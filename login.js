// Server-side login. PINs are verified here, against Turso, using credentials
// that live only in Vercel environment variables. The browser never receives
// any PIN and never touches the database directly.
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// Optional env: APP_ALLOWED_ORIGIN
//
// This is the Vercel port of the original Netlify function. Logic is
// unchanged; only the IP-header lookup and the routing config differ,
// since Vercel maps this file to /api/login automatically (no config.path
// needed the way Netlify required).

export const config = { runtime: "edge" };

const ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> { count, resetAt }

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function normalizeOrigin(o) {
  if (!o) return o;
  try {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return o.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function cors(request) {
  const allowed = process.env.APP_ALLOWED_ORIGIN;
  if (!allowed) return {};
  const origin = request.headers.get("origin");
  if (origin && normalizeOrigin(origin) !== normalizeOrigin(allowed)) return { __blocked: true };
  return {
    "Access-Control-Allow-Origin": origin || allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

const text = (v) => ({ type: "text", value: String(v) });

function tursoEndpoint(dbUrl) {
  return dbUrl.trim().replace(/\/+$/, "").replace(/^libsql:\/\//, "https://").replace(/^http:\/\//, "https://") + "/v2/pipeline";
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, class TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', phone TEXT)`,
  `CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS marks (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, subject TEXT NOT NULL, term TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'Exam', score REAL NOT NULL, academic_year TEXT, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS teacher_subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, subject TEXT NOT NULL, FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS class_tutors (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, class TEXT NOT NULL UNIQUE, FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, term TEXT NOT NULL, month TEXT, class TEXT NOT NULL, base_avg REAL, base_pass REAL, base_hr INTEGER, base_r INTEGER, base_ot INTEGER, target_avg REAL, target_pass REAL, target_hr INTEGER, target_r INTEGER, target_ot INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS student_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, term TEXT NOT NULL, period TEXT NOT NULL, group_number INTEGER NOT NULL, student_id INTEGER NOT NULL, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS student_commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, student_name TEXT NOT NULL, class TEXT NOT NULL, term TEXT NOT NULL, month TEXT, subjects TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS class_history (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, from_academic_year TEXT, from_class TEXT, to_academic_year TEXT, to_class TEXT, action TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pin', '1234')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('data_clerk_pin', '2222')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('head_teacher_pin', '3333')`,
];

async function pipeline(statements) {
  const dbUrl = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!dbUrl || !token) throw new Error("not-configured");
  const endpoint = tursoEndpoint(dbUrl);
  const requests = statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(text) } }));
  requests.push({ type: "close" });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("turso upstream error", res.status, detail.slice(0, 500));
    throw new Error(`upstream-${res.status}`);
  }
  const data = await res.json();
  const failed = (data.results || []).find((r) => r.type === "error");
  if (failed) {
    console.error("turso statement error", failed.error);
    throw new Error("statement-failed");
  }
  return (data.results || []).map((r) => {
    if (r.type !== "ok" || !r.response?.result) return [];
    const result = r.response.result;
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], cell.value ?? null])));
  });
}

async function ensureSchema() {
  await pipeline(SCHEMA_STATEMENTS.map((sql) => ({ sql })));
}

export default async function handler(request) {
  const headers = cors(request);
  if (headers.__blocked) return json({ error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  if (request.method === "GET") {
    const configured = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
    if (!configured) {
      return json({ ok: true, service: "auth-login", configured: false, reachable: false }, 200, headers);
    }
    try {
      await ensureSchema();
      return json({ ok: true, service: "auth-login", configured: true, reachable: true }, 200, headers);
    } catch (err) {
      let reason = err.message;
      if (err.message === "upstream-401" || err.message === "upstream-403") reason = "credentials-rejected";
      if (err.message === "statement-failed") reason = "schema-error";
      return json({ ok: true, service: "auth-login", configured: true, reachable: false, reason }, 200, headers);
    }
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);

  // Vercel Edge Functions expose the client IP via x-forwarded-for
  // (Netlify's x-nf-client-connection-ip header doesn't exist here).
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  if (rateLimited(ip)) return json({ error: "Too many attempts. Wait a minute and try again." }, 429, headers);

  let pin = "";
  try {
    const body = await request.json();
    pin = typeof body?.pin === "string" ? body.pin.trim() : "";
  } catch {
    return json({ error: "Invalid request" }, 400, headers);
  }
  if (!pin || pin.length > 32) return json({ error: "Enter your PIN." }, 400, headers);

  try {
    await ensureSchema();

    const [settings, teachers] = await pipeline([
      { sql: "SELECT key, value FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin')" },
      { sql: "SELECT id, name FROM teachers WHERE pin = ? AND pin IS NOT NULL AND pin != ''", args: [pin] },
    ]);

    const setting = (key, fallback) => settings.find((r) => r.key === key)?.value ?? fallback;
    const roleMatch =
      pin === setting("admin_pin", "1234") ? { role: "admin", name: "HABINEZA" }
      : pin === setting("data_clerk_pin", "2222") ? { role: "data_clerk", name: "Data Clerk" }
      : pin === setting("head_teacher_pin", "3333") ? { role: "head_teacher", name: "Head Teacher" }
      : null;

    if (roleMatch) return json({ ok: true, ...roleMatch, teacherId: null, subjects: [], tutorClass: null }, 200, headers);

    const teacher = teachers[0];
    if (!teacher) return json({ error: "Incorrect PIN. Try again." }, 401, headers);

    const [subjectRows, tutorRows] = await pipeline([
      { sql: "SELECT subject FROM teacher_subjects WHERE teacher_id = ?", args: [teacher.id] },
      { sql: "SELECT class FROM class_tutors WHERE teacher_id = ?", args: [teacher.id] },
    ]);

    return json({
      ok: true,
      role: "teacher",
      name: teacher.name,
      teacherId: Number(teacher.id),
      subjects: subjectRows.map((r) => r.subject),
      tutorClass: tutorRows[0]?.class ?? null,
    }, 200, headers);
  } catch (err) {
    if (err.message === "not-configured") {
      return json({ error: "Server is not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, then redeploy." }, 500, headers);
    }
    if (err.message === "upstream-401" || err.message === "upstream-403") {
      return json({ error: "The database rejected the server credentials. Check TURSO_AUTH_TOKEN." }, 502, headers);
    }
    if (err.message === "statement-failed") {
      return json({ error: "The database rejected a setup query — check that TURSO_DATABASE_URL points at a normal libSQL/Turso database." }, 502, headers);
    }
    console.error("login failure", err);
    return json({ error: `Cannot reach the school database (${err.message}).` }, 502, headers);
  }
}

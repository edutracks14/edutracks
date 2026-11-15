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

import { signSession } from "./_auth.js";

// v109: run next to the Turso database (change "fra1" if your Turso DB is in another region)
export const config = { runtime: "edge", regions: ["fra1"] };

const ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // ip -> { count, resetAt }

// v169: failed-PIN lockout kept in the DATABASE, so it is shared by every server instance and survives restarts
// (the in-memory counter above is per instance and resets often). Limits can be changed with Vercel env vars.
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const envInt = (name, dflt) => { const n = parseInt(process.env[name] || "", 10); return Number.isFinite(n) && n > 0 ? n : dflt; };
const MAX_FAILS_IP = () => envInt("LOGIN_MAX_FAILS_IP", 15);   // wrong PINs from one address in 10 minutes
const MAX_FAILS_ALL = () => envInt("LOGIN_MAX_FAILS_ALL", 80); // wrong PINs from everywhere in 10 minutes

function clientIp(request) {
  const raw = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";
  return String(raw).split(",")[0].trim().slice(0, 64) || "unknown";
}

// Constant-time string comparison (does not stop at the first different character).
export function safeEq(a, b) {
  a = String(a == null ? "" : a); b = String(b == null ? "" : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// An easy-to-guess PIN: a factory default, repeated digits (1111), a run (1234 / 4321), or shorter than 6 digits.
const DEFAULT_ROLE_PINS = new Set(["1234", "2222", "3333"]);
export function isWeakPin(pin) {
  const p = String(pin || "");
  if (p.length < 6) return true;
  if (DEFAULT_ROLE_PINS.has(p)) return true;
  if (/^(\d)\1+$/.test(p)) return true;
  if ("0123456789".includes(p) || "9876543210".includes(p)) return true;
  return false;
}

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

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, class TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', phone TEXT)`,
  `CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, level TEXT DEFAULT 'P6')`,
  `CREATE TABLE IF NOT EXISTS marks (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, subject TEXT NOT NULL, term TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'Exam', score REAL NOT NULL, academic_year TEXT, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS teacher_subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, subject TEXT NOT NULL, FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS class_tutors (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, class TEXT NOT NULL UNIQUE, FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS teacher_classes (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, class TEXT NOT NULL, UNIQUE(teacher_id, class), FOREIGN KEY(teacher_id) REFERENCES teachers(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, term TEXT NOT NULL, month TEXT, class TEXT NOT NULL, base_avg REAL, base_pass REAL, base_hr INTEGER, base_r INTEGER, base_ot INTEGER, target_avg REAL, target_pass REAL, target_hr INTEGER, target_r INTEGER, target_ot INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS student_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, term TEXT NOT NULL, period TEXT NOT NULL, group_number INTEGER NOT NULL, student_id INTEGER NOT NULL, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS student_commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, student_name TEXT NOT NULL, class TEXT NOT NULL, term TEXT NOT NULL, month TEXT, subjects TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS class_history (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, from_academic_year TEXT, from_class TEXT, to_academic_year TEXT, to_class TEXT, action TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE)`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pin', '1234')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('data_clerk_pin', '2222')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('head_teacher_pin', '3333')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_name', 'Administrator')`,
  // v155: one PIN = one person. The database itself refuses a teacher PIN that another teacher or a role
  // already uses, whichever screen or device sends it (Admin Teachers tab, Change My PIN, an old cached copy).
  // Only NEW or CHANGED PINs are checked, so existing data never blocks other edits.
  `CREATE TRIGGER IF NOT EXISTS teachers_pin_unique_ins BEFORE INSERT ON teachers WHEN NEW.pin IS NOT NULL AND TRIM(NEW.pin) <> '' AND (EXISTS (SELECT 1 FROM teachers WHERE pin = NEW.pin) OR EXISTS (SELECT 1 FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin') AND value = NEW.pin)) BEGIN SELECT RAISE(ABORT, 'PIN_TAKEN: That PIN is already used by another teacher or role. Choose a different one.'); END`,
  `CREATE TRIGGER IF NOT EXISTS teachers_pin_unique_upd BEFORE UPDATE OF pin ON teachers WHEN NEW.pin IS NOT NULL AND TRIM(NEW.pin) <> '' AND NEW.pin IS NOT OLD.pin AND (EXISTS (SELECT 1 FROM teachers WHERE pin = NEW.pin AND id <> NEW.id) OR EXISTS (SELECT 1 FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin') AND value = NEW.pin)) BEGIN SELECT RAISE(ABORT, 'PIN_TAKEN: That PIN is already used by another teacher or role. Choose a different one.'); END`,
  `CREATE TRIGGER IF NOT EXISTS role_pin_unique_upd BEFORE UPDATE OF value ON settings WHEN NEW.key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin') AND NEW.value IS NOT NULL AND TRIM(NEW.value) <> '' AND NEW.value IS NOT OLD.value AND EXISTS (SELECT 1 FROM teachers WHERE pin = NEW.value) BEGIN SELECT RAISE(ABORT, 'PIN_TAKEN: That PIN is already used by a teacher. Choose a different one.'); END`,
  `CREATE TRIGGER IF NOT EXISTS role_pin_unique_ins BEFORE INSERT ON settings WHEN NEW.key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin') AND NEW.value IS NOT NULL AND TRIM(NEW.value) <> '' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = NEW.key) AND EXISTS (SELECT 1 FROM teachers WHERE pin = NEW.value) BEGIN SELECT RAISE(ABORT, 'PIN_TAKEN: That PIN is already used by a teacher. Choose a different one.'); END`,
];

export function pinIsAmbiguous(teachers, roleMatch) {
  return teachers.length > 1 || Boolean(roleMatch && teachers.length > 0);
}

export const CLEAR_CONFLICTING_TEACHER_PINS = `UPDATE teachers
  SET pin = NULL
  WHERE pin IS NOT NULL AND TRIM(pin) <> ''
    AND (
      EXISTS (SELECT 1 FROM teachers AS other WHERE other.pin = teachers.pin AND other.id <> teachers.id)
      OR EXISTS (SELECT 1 FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin') AND value = teachers.pin)
    )`;

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

// The tables only need to be checked once each time the server wakes up, not on
// every login. (The GET check below forces it, so /api/login still proves the
// database is reachable.)
let schemaReady = false;
async function ensureSchema(force = false) {
  if (schemaReady && !force) return;
  await pipeline(SCHEMA_STATEMENTS.map((sql) => ({ sql })));
  schemaReady = true;
}

export default async function handler(request) {
  const headers = cors(request);
  if (headers.__blocked) return json({ error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  if (request.method === "GET") {
    // Light "wake-up" call sent when the login screen opens: warms the server and
    // the database connection so the real login is quick. Never creates anything.
    if (new URL(request.url).searchParams.get("warm")) {
      try { await pipeline([{ sql: "SELECT 1" }]); } catch { /* ignore */ }
      return json({ ok: true, warm: true }, 200, headers);
    }
    const configured = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
    if (!configured) {
      return json({ ok: true, service: "auth-login", configured: false, reachable: false }, 200, headers);
    }
    try {
      await ensureSchema(true);
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
  const ip = clientIp(request);
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
    // v111: go straight to the login query (one round trip). Only if the tables are missing
    // (brand-new database) do we create them and try once more.
    const teacherId = "(SELECT id FROM teachers WHERE pin = ? AND pin IS NOT NULL AND pin != '' ORDER BY id LIMIT 1)";
    const loginStatements = [
      // Clear every teacher account involved in a legacy collision. Do not
      // guess which teacher owns a PIN that is shared by multiple accounts.
      { sql: CLEAR_CONFLICTING_TEACHER_PINS },
      { sql: "SELECT key, value FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin','admin_name')" },
      // Return every matching teacher. Legacy duplicate PINs may predate the
      // uniqueness triggers; never silently log in as whichever row sorts first.
      { sql: "SELECT id, name FROM teachers WHERE pin = ? AND pin IS NOT NULL AND pin != '' ORDER BY id", args: [pin] },
      { sql: `SELECT subject FROM teacher_subjects WHERE teacher_id = ${teacherId}`, args: [pin] },
      { sql: `SELECT class FROM class_tutors WHERE teacher_id = ${teacherId}`, args: [pin] },
      { sql: `SELECT class FROM teacher_classes WHERE teacher_id = ${teacherId}`, args: [pin] },
      // v169: shared failed-attempt log (same round trip as the login itself)
      { sql: "CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL)" },
      { sql: "DELETE FROM login_attempts WHERE ts < ?", args: [Date.now() - FAIL_WINDOW_MS] },
      { sql: "SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts >= ?", args: [ip, Date.now() - FAIL_WINDOW_MS] },
      { sql: "SELECT COUNT(*) AS n FROM login_attempts WHERE ts >= ?", args: [Date.now() - FAIL_WINDOW_MS] },
    ];
    let settings, teachers, subjectRows, tutorRows, classRows, ipFailRows, allFailRows;
    try {
      [, settings, teachers, subjectRows, tutorRows, classRows, , , ipFailRows, allFailRows] = await pipeline(loginStatements);
    } catch (firstErr) {
      if (firstErr.message !== "statement-failed" || schemaReady) throw firstErr;
      await ensureSchema(true);
      [, settings, teachers, subjectRows, tutorRows, classRows, , , ipFailRows, allFailRows] = await pipeline(loginStatements);
    }
    schemaReady = true;

    // v169: too many wrong PINs recently (from this address, or from everywhere) -> refuse EVERY attempt for a while,
    // even a correct PIN, so guessing gains nothing.
    const ipFails = Number(ipFailRows?.[0]?.n || 0);
    const allFails = Number(allFailRows?.[0]?.n || 0);
    if (ipFails >= MAX_FAILS_IP() || allFails >= MAX_FAILS_ALL()) {
      return json({ error: "Too many wrong PIN attempts. Please wait 10 minutes and try again." }, 429, { ...headers, "Retry-After": "600" });
    }

    const setting = (key, fallback) => settings.find((r) => r.key === key)?.value ?? fallback;
    const roleMatch =
      safeEq(pin, setting("admin_pin", "1234")) ? { role: "admin", name: setting("admin_name", "Administrator") || "Administrator" }
      : safeEq(pin, setting("data_clerk_pin", "2222")) ? { role: "data_clerk", name: "Data Clerk" }
      : safeEq(pin, setting("head_teacher_pin", "3333")) ? { role: "head_teacher", name: "Head Teacher" }
      : (setting("deputy_pin", "") && safeEq(pin, setting("deputy_pin", ""))) ? { role: "deputy", name: "Deputy" }
      : null;

    // v156: uniqueness triggers prevent new collisions, but do not alter legacy
    // rows. Fail closed if this PIN still identifies multiple accounts or a role
    // and a teacher, rather than accepting a stale/ambiguous teacher PIN.
    if (pinIsAmbiguous(teachers, roleMatch)) {
      return json({ error: "This PIN is assigned to more than one account. Ask the Admin to give each account a different PIN." }, 409, headers);
    }

    const forgiveIp = async () => {
      if (ipFails > 0) { try { await pipeline([{ sql: "DELETE FROM login_attempts WHERE ip = ?", args: [ip] }]); } catch { /* ignore */ } }
    };

    if (roleMatch) {
      await forgiveIp();
      const token = await signSession({ role: roleMatch.role, name: roleMatch.name });
      return json({ ok: true, ...roleMatch, token, teacherId: null, subjects: [], tutorClass: null, weakPin: isWeakPin(pin) }, 200, headers);
    }

    const teacher = teachers[0];
    if (!teacher) {
      try { await pipeline([{ sql: "INSERT INTO login_attempts (ip, ts) VALUES (?, ?)", args: [ip, Date.now()] }]); } catch { /* ignore */ }
      return json({ error: "Incorrect PIN. Try again." }, 401, headers);
    }
    await forgiveIp();

    const token = await signSession({ role: "teacher", teacherId: Number(teacher.id), name: teacher.name });
    return json({
      ok: true,
      token,
      role: "teacher",
      name: teacher.name,
      teacherId: Number(teacher.id),
      subjects: subjectRows.map((r) => r.subject),
      tutorClass: tutorRows[0]?.class ?? null,
      classes: classRows.map((r) => r.class),
      weakPin: isWeakPin(pin),
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

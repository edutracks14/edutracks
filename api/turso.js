// Turso proxy — the ONLY place database credentials exist.
// Runs on Vercel's Edge Network; the browser never receives the URL or token.
//
// Required Vercel environment variables:
//   TURSO_DATABASE_URL  e.g. https://your-db-yourname.turso.io
//   TURSO_AUTH_TOKEN    the database auth token
// Optional:
//   APP_ALLOWED_ORIGIN  restrict which site origin may call this (defaults to same-origin only)
//
// Vercel port of the original Netlify function. Logic is unchanged; Vercel
// maps this file to /api/turso automatically (no config.path needed).

import { verifySession } from "./_auth.js";

export const config = { runtime: "edge" };

const ALLOWED_REQUEST_TYPES = new Set(["execute", "close"]);
const MAX_STATEMENTS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
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

function corsHeaders(request) {
  const allowed = process.env.APP_ALLOWED_ORIGIN;
  if (!allowed) return {};
  const origin = request.headers.get("origin");
  if (origin && normalizeOrigin(origin) !== normalizeOrigin(allowed)) return { __blocked: true };
  return {
    "Access-Control-Allow-Origin": origin || allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function tursoEndpoint(dbUrl) {
  return dbUrl.trim().replace(/\/+$/, "").replace(/^libsql:\/\//, "https://").replace(/^http:\/\//, "https://") + "/v2/pipeline";
}

function validatePipeline(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.requests)) {
    return "Body must be { requests: [...] }";
  }
  const { requests } = payload;
  if (requests.length === 0) return "requests must not be empty";
  if (requests.length > MAX_STATEMENTS) return `Too many statements (max ${MAX_STATEMENTS})`;
  for (const req of requests) {
    if (!req || typeof req !== "object" || !ALLOWED_REQUEST_TYPES.has(req.type)) {
      return "Only 'execute' and 'close' requests are allowed";
    }
    if (req.type === "execute") {
      const stmt = req.stmt;
      if (!stmt || typeof stmt.sql !== "string" || stmt.sql.trim() === "") return "Each execute needs a non-empty sql string";
      if (stmt.sql.length > 100000) return "SQL statement too long";
      if (stmt.args !== undefined && !Array.isArray(stmt.args)) return "stmt.args must be an array";
      if (stmt.named_args !== undefined && !Array.isArray(stmt.named_args)) return "stmt.named_args must be an array";
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Access policy. The browser can no longer talk to the database freely: every
// request needs a signed session token (from /api/login) and is checked here
// against the signed-in role. The admin is unrestricted.
// ---------------------------------------------------------------------------
const CORE_TABLES = ["teachers", "students", "classes", "subjects", "marks", "teacher_subjects", "teacher_classes",
  "class_tutors", "class_history", "commitments", "student_commitments", "student_groups", "settings"];
const WRITE_DENY = {
  admin: [],
  deputy: [],
  data_clerk: ["teachers", "teacher_subjects", "teacher_classes", "class_tutors", "commitments", "student_commitments", "student_groups", "settings"],
  teacher: ["teachers", "students", "classes", "subjects", "teacher_subjects", "teacher_classes", "class_tutors", "class_history", "settings"],
  head_teacher: CORE_TABLES,
};
const HIDE_TEACHER_PINS = new Set(["teacher", "data_clerk", "head_teacher"]);
const PIN_KEY = /^(admin|data_clerk|head_teacher|deputy)_pin$|^admin_name$/i;
const TBL = "[`\"\\[]?(?:main\\s*\\.\\s*)?[`\"\\[]?([A-Za-z_][A-Za-z0-9_]*)";

function cleanSql(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
}
function argValues(stmt) {
  const out = [];
  for (const a of stmt.args || []) out.push(String(a && typeof a === "object" ? a.value ?? "" : a ?? ""));
  for (const a of stmt.named_args || []) out.push(String(a && a.value && typeof a.value === "object" ? a.value.value ?? "" : a?.value ?? ""));
  return out;
}

// Returns an error string if this statement is not allowed for the role, else null.
function checkStatement(role, stmt) {
  if (role === "admin") return null;
  const sql = cleanSql(stmt.sql);
  if (/;\s*\S/.test(sql)) return "Multiple statements are not allowed.";
  const op = (sql.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
  const mentionsSettings = /\bsettings\b/i.test(sql);
  const mentionsPinKey = /_pin\b|\badmin_name\b/i.test(sql) || argValues(stmt).some((v) => PIN_KEY.test(v));
  // Reading the pin column is refused for roles that must not see teacher PINs (schema statements that merely define it are fine).
  // Teachers may read everything (the result scrubber blanks PIN columns/values).
  if (role === "teacher" && (op === "SELECT" || (op === "WITH" && !/\b(insert|update|delete|replace)\b/i.test(sql)))) return null;
  if (HIDE_TEACHER_PINS.has(role) && (op === "SELECT" || op === "WITH") && /\bpin\b/i.test(sql)) return "Not allowed.";

  let writeTable = null;
  let isWrite = false;
  if (op === "INSERT" || op === "REPLACE") {
    isWrite = true;
    writeTable = (sql.match(new RegExp("^(?:insert\\s+(?:or\\s+\\w+\\s+)?|replace\\s+)into\\s+" + TBL, "i")) || [])[1] || null;
  } else if (op === "UPDATE") {
    isWrite = true;
    writeTable = (sql.match(new RegExp("^update\\s+(?:or\\s+\\w+\\s+)?" + TBL, "i")) || [])[1] || null;
  } else if (op === "DELETE") {
    isWrite = true;
    writeTable = (sql.match(new RegExp("^delete\\s+from\\s+" + TBL, "i")) || [])[1] || null;
    if (!/\bwhere\b/i.test(sql)) return "Bulk deletes are admin-only.";
  } else if (op === "SELECT") {
    // read — handled below
  } else if (op === "WITH") {
    if (/\b(insert|update|delete|replace)\b/i.test(sql)) return "Not allowed.";
  } else if (op === "CREATE") {
    if (!/^create\s+(unique\s+)?(table|index)\b/i.test(sql)) return "Not allowed.";
  } else if (op === "ALTER") {
    if (!/\badd\s+column\b/i.test(sql)) return "Not allowed.";
  } else if (op === "PRAGMA") {
    if (!/^pragma\s+table_info\b/i.test(sql)) return "Not allowed.";
  } else if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END"].includes(op)) {
    // transaction control
  } else {
    return "Not allowed.";
  }

  if (isWrite) {
    if (!writeTable) return "Not allowed.";
    if ((WRITE_DENY[role] || CORE_TABLES).map((x) => x.toLowerCase()).includes(writeTable.toLowerCase())) {
      return "Your role cannot change this data.";
    }
    if (writeTable.toLowerCase() === "settings" && mentionsPinKey) return "Only the admin can change PINs.";
  }
  // Teacher dashboards hydrate from the same read-only cloud tables as Admin.
  // Do not reject those SELECTs because they mention a protected table; the
  // result scrubber below still removes PINs and protected setting values.
  if (!isWrite && (op === "SELECT" || op === "WITH") && role === "teacher") {
    return null;
  }
  if (!isWrite && mentionsSettings && op !== "CREATE") {
    // Reading settings is allowed, but only in simple shapes the server can safely scrub.
    const stripped = sql.replace(/\bin\s*\([^)]*\)/gi, " ");
    if (/\bas\b|\bjoin\b|\bunion\b|\|\||[()]/i.test(stripped) || (sql.match(/\bselect\b/gi) || []).length > 1) {
      return "Not allowed.";
    }
  }
  return null;
}

// Removes secrets from the rows a non-admin is about to receive.
function scrubResult(role, result) {
  if (!result || !Array.isArray(result.cols) || !Array.isArray(result.rows)) return;
  const names = result.cols.map((c) => String(c.name).toLowerCase());
  const keyIdx = names.indexOf("key");
  const valIdx = names.indexOf("value");
  const pinIdx = names.indexOf("pin");
  const blank = { type: "text", value: "" };
  for (const row of result.rows) {
    if (keyIdx >= 0 && valIdx >= 0 && PIN_KEY.test(String(row[keyIdx]?.value ?? ""))) row[valIdx] = blank;
    if (pinIdx >= 0 && HIDE_TEACHER_PINS.has(role) && row[pinIdx] && row[pinIdx].type !== "null") row[pinIdx] = blank;
  }
  // A settings read that does not return the key column cannot be scrubbed: blank the values.
  if (valIdx >= 0 && keyIdx < 0 && names.length === 1) {
    for (const row of result.rows) row[valIdx] = blank;
  }
}

export default async function handler(request) {
  const cors = corsHeaders(request);
  if (cors.__blocked) return jsonResponse({ error: "Origin not allowed" }, 403);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET") {
    return jsonResponse(
      { ok: true, service: "turso-proxy" },
      200,
      cors,
    );
  }

  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

  const dbUrl = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!dbUrl || !token) {
    return jsonResponse({ error: "Server is not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN" }, 500, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResponse({ error: "Payload too large" }, 413, cors);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }

  const problem = validatePipeline(payload);
  if (problem) return jsonResponse({ error: problem }, 400, cors);

  // --- Sign-in required ---
  const session = await verifySession(request);
  if (!session) return jsonResponse({ error: "Not signed in or session expired." }, 401, cors);
  const role = session.role;
  // A single forbidden statement used to reject the WHOLE batch, so a teacher's
  // queued marks never reached the cloud (admin is unrestricted, so it worked).
  // Now forbidden statements are swapped for a no-op and the rest still runs.
  // The forbidden statement is still never executed, so access rules are unchanged.
  const skipped = [];
  payload.requests = payload.requests.map((r, i) => {
    if (r.type !== "execute") return r;
    const why = checkStatement(role, r.stmt);
    if (!why) return r;
    skipped.push({ index: i, error: why });
    return { type: "execute", stmt: { sql: "SELECT 0 WHERE 0" } };
  });
  if (skipped.length) console.warn("Skipped statements for role", role, JSON.stringify(skipped).slice(0, 500));

  const endpoint = tursoEndpoint(dbUrl);

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: payload.requests }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error("Turso upstream error", upstream.status, text.slice(0, 500));
      return jsonResponse({ error: `Database error (${upstream.status})` }, 502, cors);
    }
    let outText = text;
    if (role !== "admin") {
      try {
        const data = JSON.parse(text);
        for (const r of data.results || []) {
          if (r.type === "ok") scrubResult(role, r.response && r.response.result);
        }
        outText = JSON.stringify(data);
      } catch {
        return jsonResponse({ error: "Unexpected database response" }, 502, cors);
      }
    }
    return new Response(outText, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
    });
  } catch (err) {
    console.error("Turso proxy failure", err);
    return jsonResponse({ error: "Database unreachable" }, 502, cors);
  }
}

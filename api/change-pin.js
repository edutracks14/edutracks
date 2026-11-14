// Lets a signed-in TEACHER change his own login PIN (v153).
//
// Safety rules, all enforced here on the server (the browser is never trusted):
//   1. Needs a valid signed session token from /api/login with role "teacher".
//      The teacher id comes from the token, never from the request body, so a
//      teacher can only ever change his own PIN.
//   2. The teacher must type his CURRENT PIN correctly.
//   3. The new PIN must be exactly 6 digits, different from the current one, and not used by
//      another teacher or by a role (admin, data clerk, head teacher, deputy).
//   4. The duplicate check and the update happen in ONE database statement, so two
//      teachers choosing the same PIN at the same moment cannot both succeed.
//   5. Attempts are limited per teacher.
// The admin can still set or reset any teacher's PIN in the Teachers tab, as before.
//
// Required env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (same as /api/login)

import { verifySession } from "./_auth.js";

export const config = { runtime: "edge", regions: ["fra1"] };

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map(); // teacherId -> { count, resetAt }

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function limited(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

const text = (v) => ({ type: "text", value: String(v) });

function tursoEndpoint(dbUrl) {
  return dbUrl.trim().replace(/\/+$/, "").replace(/^libsql:\/\//, "https://").replace(/^http:\/\//, "https://") + "/v2/pipeline";
}

async function pipeline(statements) {
  const dbUrl = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!dbUrl || !token) throw new Error("not-configured");
  const requests = statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args || []).map(text) } }));
  requests.push({ type: "close" });
  const res = await fetch(tursoEndpoint(dbUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`upstream-${res.status}`);
  const data = await res.json();
  if ((data.results || []).find((r) => r.type === "error")) throw new Error("statement-failed");
  return (data.results || []).map((r) => {
    if (r.type !== "ok" || !r.response?.result) return [];
    const result = r.response.result;
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], cell.value ?? null])));
  });
}

export default async function handler(request) {
  const headers = cors(request);
  if (headers.__blocked) return json({ error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);

  let session = null;
  try { session = await verifySession(request); } catch { session = null; }
  if (!session) return json({ error: "Your session expired. Please log in again.", code: "session" }, 401, headers);
  if (session.role !== "teacher" || !Number.isInteger(Number(session.teacherId)) || session.teacherId === null) {
    return json({ error: "Only teachers can change their own PIN here." }, 403, headers);
  }
  const teacherId = Number(session.teacherId);

  let currentPin = "", newPin = "";
  try {
    const body = await request.json();
    currentPin = typeof body?.currentPin === "string" ? body.currentPin.trim() : "";
    newPin = typeof body?.newPin === "string" ? body.newPin.trim() : "";
  } catch {
    return json({ error: "Invalid request" }, 400, headers);
  }
  if (!currentPin || currentPin.length > 32) return json({ error: "Enter your current PIN." }, 400, headers);
  if (!/^\d{6}$/.test(newPin)) return json({ error: "The new PIN must be exactly 6 digits." }, 400, headers);
  if (newPin === currentPin) return json({ error: "The new PIN must be different from the current PIN." }, 400, headers);

  if (limited(String(teacherId))) return json({ error: "Too many attempts. Wait a few minutes and try again.", code: "limit" }, 429, headers);

  try {
    const [mine, settings] = await pipeline([
      { sql: "SELECT pin FROM teachers WHERE id = CAST(? AS INTEGER)", args: [teacherId] },
      { sql: "SELECT key, value FROM settings WHERE key IN ('admin_pin','data_clerk_pin','head_teacher_pin','deputy_pin')" },
    ]);
    const stored = mine[0]?.pin ?? "";
    if (!stored) return json({ error: "Your login was removed. Ask the Admin.", code: "removed" }, 403, headers);
    if (stored !== currentPin) return json({ error: "Your current PIN is incorrect.", code: "wrong-current" }, 403, headers);

    const setting = (key, fallback) => settings.find((r) => r.key === key)?.value ?? fallback;
    const rolePins = [setting("admin_pin", "1234"), setting("data_clerk_pin", "2222"), setting("head_teacher_pin", "3333"), setting("deputy_pin", "")];
    if (rolePins.includes(newPin)) return json({ error: "That PIN cannot be used. Choose a different one.", code: "taken" }, 409, headers);

    // One atomic statement: only changes the PIN if nobody else already has the new one.
    const [, after] = await pipeline([
      {
        sql: "UPDATE teachers SET pin = ? WHERE id = CAST(? AS INTEGER) AND pin = ? AND NOT EXISTS (SELECT 1 FROM teachers WHERE pin = ? AND id <> CAST(? AS INTEGER))",
        args: [newPin, teacherId, currentPin, newPin, teacherId],
      },
      { sql: "SELECT pin FROM teachers WHERE id = CAST(? AS INTEGER)", args: [teacherId] },
    ]);
    if (after[0]?.pin !== newPin) return json({ error: "That PIN cannot be used. Choose a different one.", code: "taken" }, 409, headers);
    return json({ ok: true }, 200, headers);
  } catch (err) {
    if (err.message === "not-configured") return json({ error: "Server is not configured." }, 500, headers);
    console.error("change-pin failure", err.message);
    return json({ error: "Cannot reach the school database. Try again." }, 502, headers);
  }
}

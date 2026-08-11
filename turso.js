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

export default async function handler(request) {
  const cors = corsHeaders(request);
  if (cors.__blocked) return jsonResponse({ error: "Origin not allowed" }, 403);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET") {
    return jsonResponse(
      { ok: true, service: "turso-proxy", configured: Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) },
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
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
    });
  } catch (err) {
    console.error("Turso proxy failure", err);
    return jsonResponse({ error: "Database unreachable" }, 502, cors);
  }
}

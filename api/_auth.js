// Signed session tokens (HMAC-SHA256). Issued by /api/login after a correct PIN,
// required by /api/turso and /api/app. Files starting with "_" are NOT routed by
// Vercel, so this is only importable by the other functions.
//
// Secret: SESSION_SECRET if set, otherwise derived from TURSO_AUTH_TOKEN (which
// already exists only on the server). Changing either invalidates all sessions.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const SESSION_TTL_MS = 10 * 60 * 60 * 1000; // 10 hours

function toB64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(str) {
  const b = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmacKey() {
  const secret = process.env.SESSION_SECRET || process.env.TURSO_AUTH_TOKEN || "";
  if (!secret) throw new Error("not-configured");
  return crypto.subtle.importKey("raw", enc.encode("edutracks-session-v1|" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession({ role, teacherId = null, name = "" }) {
  const body = toB64u(enc.encode(JSON.stringify({ r: role, t: teacherId, n: name, e: Date.now() + SESSION_TTL_MS })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return body + "." + toB64u(sig);
}

// Returns { role, teacherId, name } for a valid, unexpired token, else null.
export async function verifySession(request) {
  try {
    const h = request.headers.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), fromB64u(sig), enc.encode(body));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(fromB64u(body)));
    if (!data || typeof data.e !== "number" || Date.now() > data.e) return null;
    return { role: data.r, teacherId: data.t, name: data.n };
  } catch {
    return null;
  }
}

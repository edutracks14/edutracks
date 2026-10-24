// Delivers the application itself — but only to a signed-in user. Before login the
// browser receives just a small login page (index.html); the real app code never
// sits in a public file. The code is stored (obfuscated + gzipped) in _app.js.

import { verifySession } from "./_auth.js";
import { APP_GZ_B64 } from "./_app.js";

export const config = { runtime: "edge" };

let cachedBytes = null;
function appBytes() {
  if (!cachedBytes) cachedBytes = Uint8Array.from(atob(APP_GZ_B64), (c) => c.charCodeAt(0));
  return cachedBytes;
}

export default async function handler(request) {
  const noStore = { "Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow" };
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: noStore });
  const session = await verifySession(request);
  if (!session) return new Response(JSON.stringify({ error: "Please sign in." }), { status: 401, headers: { "Content-Type": "application/json", ...noStore } });
  const stream = new Blob([appBytes()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...noStore } });
}

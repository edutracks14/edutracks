// v171 — PINs are stored ENCRYPTED in the database (AES-256-GCM), so someone who only gets the database
// (a leaked Turso token, a copy of the file) sees "e1:..." text instead of real PINs.
// The key lives only in the Vercel setting PIN_ENC_KEY. Without that setting nothing changes (PINs stay as before).
//
// The encryption is deterministic (same PIN -> same stored text) on purpose: the database triggers that stop two
// people sharing a PIN, and the "WHERE pin = ?" lookups, keep working. The Admin still sees real PINs in the app,
// because /api/turso decrypts them for Admin/Deputy on the way out. Teachers, clerk and head teacher still get blanks.
//
// Files starting with "_" are NOT routed by Vercel; this is imported by /api/login, /api/change-pin and /api/turso.

const PREFIX = "e1:";
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PIN_KEY_NAMES = /^(admin|data_clerk|head_teacher|deputy)_pin$/i;

export function pinEncEnabled() {
  return String(process.env.PIN_ENC_KEY || "").length >= 16;
}
export const isEncPin = (v) => typeof v === "string" && v.startsWith(PREFIX);

let cached = { secret: "", keys: null };
async function keys() {
  const secret = String(process.env.PIN_ENC_KEY || "");
  if (cached.keys && cached.secret === secret) return cached.keys;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("edutracks-pin-v1|" + secret));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const hmac = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("edutracks-pin-iv|" + secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  cached = { secret, keys: { aes, hmac } };
  return cached.keys;
}
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// plain PIN -> stored text. Returns the input unchanged when encryption is off, or it is empty / already encrypted.
export async function encPin(pin) {
  if (!pinEncEnabled() || typeof pin !== "string" || pin === "" || isEncPin(pin)) return pin;
  const k = await keys();
  const iv = new Uint8Array(await crypto.subtle.sign("HMAC", k.hmac, enc.encode(pin))).slice(0, 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k.aes, enc.encode(pin)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return PREFIX + b64(out);
}
// stored text -> plain PIN. Old plain values pass through; an unreadable value (wrong key) becomes "".
export async function decPin(v) {
  if (!isEncPin(v)) return v;
  if (!pinEncEnabled()) return "";
  try {
    const k = await keys();
    const all = unb64(v.slice(PREFIX.length));
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, k.aes, all.slice(12)));
  } catch { return ""; }
}

const cellText = (c) => (c && c.type !== "null" ? String(c.value ?? "") : null);
// Encrypts the PIN argument of the statements the app uses to save PINs. Other statements are left alone.
export async function encryptPinWrites(requests, cleanSql) {
  if (!pinEncEnabled()) return;
  const setArg = async (stmt, i) => {
    const a = stmt.args && stmt.args[i];
    if (a && a.type !== "null" && typeof a.value === "string" && a.value !== "") stmt.args[i] = { ...a, type: "text", value: await encPin(a.value) };
  };
  for (const r of requests || []) {
    if (!r || r.type !== "execute" || !r.stmt || typeof r.stmt.sql !== "string") continue;
    const sql = cleanSql(r.stmt.sql).replace(/\s+/g, " ");
    if (/^insert into teachers \(name, pin\) values \(\?, \?\)$/i.test(sql)) await setArg(r.stmt, 1);
    else if (/^insert into teachers \(id, name, pin\) values \(\?, \?, \?\)$/i.test(sql)) await setArg(r.stmt, 2);
    else if (/^update teachers set pin = \? where id = \?$/i.test(sql)) await setArg(r.stmt, 0);
    else if (/^insert into settings \(key, value\) values \(\?, \?\) on conflict\(key\) do update set value = excluded\.value$/i.test(sql)) {
      const k = r.stmt.args && r.stmt.args[0] && r.stmt.args[0].value;
      if (PIN_KEY_NAMES.test(String(k || ""))) await setArg(r.stmt, 1);
    }
  }
}
// Turns encrypted PINs in a result back into real PINs (only called for roles allowed to see PINs).
export async function decryptResult(result) {
  if (!result || !Array.isArray(result.cols) || !Array.isArray(result.rows)) return;
  const names = result.cols.map((c) => String(c.name).toLowerCase());
  const keyIdx = names.indexOf("key"), valIdx = names.indexOf("value"), pinIdx = names.indexOf("pin");
  for (const row of result.rows) {
    if (pinIdx >= 0 && isEncPin(cellText(row[pinIdx]))) row[pinIdx] = { type: "text", value: await decPin(cellText(row[pinIdx])) };
    if (keyIdx >= 0 && valIdx >= 0 && PIN_KEY_NAMES.test(cellText(row[keyIdx]) || "") && isEncPin(cellText(row[valIdx]))) row[valIdx] = { type: "text", value: await decPin(cellText(row[valIdx])) };
  }
}

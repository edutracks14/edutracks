// v141 — Marks editing control (server side).
// Admin / Deputy switch teacher marks editing ON for one (Term, Period, Level).
// The switch is a settings row:  key "marks_edit:<Term>|<Period>|<LEVEL>", value "1" = open.
// Anything else (no row, "0", unreadable) = CLOSED. Only teachers are restricted.
// Files starting with "_" are NOT routed by Vercel; this is imported by /api/turso.

export const LOCK_PREFIX = "marks_edit:";
const DEFAULT_LEVELS = [
  { code: "P6", prefix: "P6" }, { code: "S3", prefix: "S3" },
  { code: "S6LFK", prefix: "S6LFK" }, { code: "S6HGL", prefix: "S6HGL" },
];

const norm = (s) => String(s == null ? "" : s).trim();
export function lockKey(term, period, level) {
  return LOCK_PREFIX + [norm(term), norm(period), norm(level).toUpperCase()].join("|");
}

export function levelsFromConfig(json) {
  try {
    const t = JSON.parse(json);
    if (Array.isArray(t) && t.length) {
      const n = t.filter((e) => e && e.code && e.prefix)
        .map((e) => ({ code: String(e.code).toUpperCase(), prefix: String(e.prefix).toUpperCase() }));
      if (n.length) return n;
    }
  } catch {}
  return DEFAULT_LEVELS;
}
// Same rule as the app: longest matching class-name prefix wins.
export function levelOf(cls, levels) {
  const c = norm(cls).toUpperCase();
  if (!c) return "";
  const hit = levels.slice().sort((a, b) => b.prefix.length - a.prefix.length).find((l) => c.startsWith(l.prefix));
  return hit ? hit.code : "";
}

function argVals(stmt) {
  return (stmt.args || []).map((a) => (a && typeof a === "object" ? (a.type === "null" ? null : a.value) : a));
}
const squash = (sql) => sql.replace(/\s+/g, " ").trim();

// Returns:
//   undefined  -> not a write to the marks table (ignore)
//   null       -> a marks write we cannot understand (treated as closed)
//   object     -> { checks: [{term, period, studentId?, markId?}], markIds: [], studentIds: [] }
export function parseMarksWrite(sqlClean, stmt) {
  const sql = squash(sqlClean);
  const args = argVals(stmt);
  let m;
  if ((m = sql.match(/^(?:insert(?: or \w+)? into|replace into) [`"[]?(?:main\s*\.\s*)?[`"[]?marks[`"\]]?\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)\s*;?$/i))) {
    const cols = m[1].split(",").map((c) => c.replace(/[`"[\]\s]/g, "").toLowerCase());
    const vals = m[2].split(",").map((v) => v.trim());
    if (cols.length !== vals.length || vals.some((v) => v !== "?") || args.length !== cols.length) return null;
    const at = (n) => args[cols.indexOf(n)];
    if (cols.indexOf("term") < 0 || cols.indexOf("period") < 0 || cols.indexOf("student_id") < 0) return null;
    const sid = Number(at("student_id"));
    if (!Number.isFinite(sid)) return null;
    return { checks: [{ term: at("term"), period: at("period"), studentId: sid }], markIds: [], studentIds: [sid] };
  }
  if ((m = sql.match(/^update(?: or \w+)? [`"[]?(?:main\s*\.\s*)?[`"[]?marks[`"\]]?\s+set (.+) where id ?= ?\?\s*;?$/i))) {
    const parts = m[1].split(",").map((p) => p.trim());
    const cols = [];
    for (const p of parts) {
      const mm = p.match(/^[`"[]?(\w+)[`"\]]? ?= ?\?$/);
      if (!mm) return null;
      cols.push(mm[1].toLowerCase());
    }
    if (args.length !== cols.length + 1) return null;
    const markId = Number(args[args.length - 1]);
    if (!Number.isFinite(markId)) return null;
    const checks = [{ markId }]; // the mark's existing term/period/student are looked up
    const ti = cols.indexOf("term"), pi = cols.indexOf("period");
    if (ti >= 0 || pi >= 0) checks.push({ markId, newTerm: ti >= 0 ? args[ti] : undefined, newPeriod: pi >= 0 ? args[pi] : undefined });
    if (cols.includes("student_id")) return null; // moving a mark to another student: not a teacher action
    return { checks, markIds: [markId], studentIds: [] };
  }
  if ((m = sql.match(/^delete from [`"[]?(?:main\s*\.\s*)?[`"[]?marks[`"\]]?\s+where (.+?)\s*;?$/i))) {
    const w = m[1].replace(/\s+/g, "").toLowerCase();
    if (w === "student_id=?andtrim(term)=trim(?)andtrim(period)=trim(?)andlower(trim(subject))=lower(trim(?))" && args.length === 4) {
      const sid = Number(args[0]);
      if (!Number.isFinite(sid)) return null;
      return { checks: [{ term: args[1], period: args[2], studentId: sid }], markIds: [], studentIds: [sid] };
    }
    return null;
  }
  if (/^(?:insert|replace|update|delete)\b[\s\S]*\bmarks\b/i.test(sql) && /^(?:insert(?: or \w+)? into|replace into|update(?: or \w+)?|delete from)\s+[`"[]?(?:main\s*\.\s*)?[`"[]?marks\b/i.test(sql)) return null;
  return undefined;
}

// requests: the pipeline requests (already past the role check).
// query(sql, args[]) -> Promise<array of plain row objects>; may throw.
// Returns [{ index, error }] for marks writes that must NOT run.
export async function marksLockBlocks(role, requests, cleanSql, query) {
  if (role !== "teacher") return [];
  const found = [];
  requests.forEach((r, index) => {
    if (!r || r.type !== "execute" || !r.stmt || typeof r.stmt.sql !== "string") return;
    const p = parseMarksWrite(cleanSql(r.stmt.sql), r.stmt);
    if (p === undefined) return;
    found.push({ index, p });
  });
  if (!found.length) return [];
  const CLOSED = "Marks editing is closed for this term, period and level.";
  const blockAll = (why) => found.map((f) => ({ index: f.index, error: why }));

  const markIds = [...new Set(found.flatMap((f) => (f.p ? f.p.markIds : [])))];
  const studentIds = [...new Set(found.flatMap((f) => (f.p ? f.p.studentIds : [])))];
  let settings, marks, students;
  try {
    settings = await query("SELECT key, value FROM settings WHERE key LIKE 'marks_edit:%' OR key = 'levels_config'", []);
    marks = markIds.length
      ? await query("SELECT id, student_id, term, period FROM marks WHERE id IN (" + markIds.map(() => "?").join(",") + ")", markIds)
      : [];
    const need = new Set(studentIds);
    marks.forEach((x) => need.add(Number(x.student_id)));
    const ids = [...need];
    students = ids.length
      ? await query("SELECT id, class FROM students WHERE id IN (" + ids.map(() => "?").join(",") + ")", ids)
      : [];
  } catch {
    return blockAll(CLOSED + " (could not be checked)");
  }
  const open = new Set();
  let cfg = "";
  for (const s of settings) {
    const k = String(s.key || "");
    if (k === "levels_config") cfg = s.value;
    else if (k.startsWith(LOCK_PREFIX) && String(s.value).trim() === "1") open.add(k.toLowerCase());
  }
  const levels = levelsFromConfig(cfg);
  const classOf = new Map(students.map((s) => [Number(s.id), s.class]));
  const markOf = new Map(marks.map((x) => [Number(x.id), x]));
  const isOpen = (term, period, studentId) => {
    const lv = levelOf(classOf.get(Number(studentId)), levels);
    if (!lv || !norm(term) || !norm(period)) return false;
    return open.has(lockKey(term, period, lv).toLowerCase());
  };

  const out = [];
  for (const f of found) {
    let ok = !!f.p;
    if (ok) {
      for (const c of f.p.checks) {
        if (c.markId !== undefined) {
          const row = markOf.get(c.markId);
          if (!row) { ok = false; break; }
          const term = c.newTerm !== undefined ? c.newTerm : row.term;
          const period = c.newPeriod !== undefined ? c.newPeriod : row.period;
          if (!isOpen(term, period, row.student_id)) { ok = false; break; }
        } else if (!isOpen(c.term, c.period, c.studentId)) { ok = false; break; }
      }
    }
    if (!ok) out.push({ index: f.index, error: CLOSED });
  }
  return out;
}

/* Duit Bijak: which statements are in, and which are missing.
   A statement record is saved for each PDF imported. Statements imported
   before records existed are inferred from their saved transactions. Each
   account issues one statement a month, keyed by the month of its statement
   date (a card cycle ending 12 Sep is Sep). From that, coverage() finds the
   gaps between an account's first and latest statements, and the statements
   that should have been issued since its latest one. */
(function (root) {
"use strict";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// Row order in the grid. Statements read by Gemini go after these, by name.
const KNOWN_ACCOUNTS = ["UOB One", "POSB", "DBS CC", "UOB Card"];
const INFERABLE = new Set([...KNOWN_ACCOUNTS, "Other account", "Other card"]);
// Days after the expected statement date before it counts as overdue.
const GRACE_DAYS = 7;
const DAY = 86400000;

// "12 Sep 2026" → epoch ms (UTC), or null.
function parseDate(s) {
  const p = String(s || "").trim().split(/\s+/);
  const mi = MONTHS.indexOf(p[1]);
  if (p.length < 3 || mi === -1 || !(Number(p[0]) >= 1)) return null;
  return Date.UTC(Number(p[2]), mi, Number(p[0]));
}
const monthIndex = ms => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const monthLabel = idx => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
const indexOfLabel = label => { const p = String(label).split(" "); return Number(p[1]) * 12 + MONTHS.indexOf(p[0]); };
// The same day of the month in month `idx`, clamped to its length.
function dayInMonth(idx, day) {
  const y = Math.floor(idx / 12), m = idx % 12;
  return Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
}
const idFor = (account, month) => `${account}|${month}`.replace(/[^\w|-]+/g, "_");

// Built-in parsers name the account by statement type. Gemini's "Other
// account" or "Other card" would lump every bank together, so use its label.
function accountOf(f) { return /^Other /.test(f.stmtType) ? f.label : f.stmtType; }

// One parsed PDF from the import review → the record to save.
function recordFromImport(f, importedAt) {
  const date = parseDate(f.statementDate);
  if (date == null) return null;
  const account = accountOf(f), month = monthLabel(monthIndex(date));
  return {
    id: idFor(account, month), account, stmtType: f.stmtType, bank: f.bank,
    statementDate: f.statementDate, month, file: f.file, rows: f.rows.length,
    ok: f.checks.every(c => c.ok), importedAt: importedAt || new Date().toISOString(),
  };
}

// Statements with no record, rebuilt from saved transactions. Rows carrying
// their file are grouped by file, dated by their latest transaction. Rows
// from before files were kept fall back to one statement per calendar month.
function inferRecords(months, records) {
  const knownFiles = new Set(records.map(r => r.file).filter(Boolean));
  const groups = {};
  (months || []).forEach(m => (m.transactions || []).forEach(t => {
    if (!INFERABLE.has(t.account) || (t.file && knownFiles.has(t.file))) return;
    const date = parseDate(t.date);
    if (date == null) return;
    const key = t.file ? `f:${t.account}|${t.file}` : `m:${t.account}|${monthIndex(date)}`;
    const g = groups[key] = groups[key] || { account: t.account, file: t.file || null, date: 0, rows: 0 };
    g.date = Math.max(g.date, date); g.rows++;
  }));
  const out = {};
  Object.values(groups).forEach(g => {
    const month = monthLabel(monthIndex(g.date)), id = idFor(g.account, month);
    if (out[id]) { out[id].rows += g.rows; return; }
    const d = new Date(g.date);
    out[id] = { id, account: g.account, stmtType: g.account, statementDate: `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, month, file: g.file, rows: g.rows, ok: true, inferred: true };
  });
  return Object.values(out);
}

function accountOrder(a, b) {
  const ia = KNOWN_ACCOUNTS.indexOf(a), ib = KNOWN_ACCOUNTS.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

// records: saved statement records. months: saved months, for inference.
// Returns { accounts, months (newest first), cells[account][month], issues }.
// A cell's state is "ok", "inferred", "warn" (totals didn't match), "gap"
// (missing between two statements), "due" (overdue since the latest one)
// or "none" (before the first statement, or not issued yet).
function coverage(records, months, now) {
  now = now == null ? Date.now() : now;
  const saved = (records || []).filter(r => r && r.account && r.month);
  const ids = new Set(saved.map(r => r.id));
  const all = saved.concat(inferRecords(months, saved).filter(r => !ids.has(r.id)));
  const byAccount = {};
  all.forEach(r => { (byAccount[r.account] = byAccount[r.account] || {})[r.month] = r; });
  const names = Object.keys(byAccount).sort(accountOrder);
  if (!names.length) return { accounts: [], months: [], cells: {}, issues: [] };

  const nowIdx = monthIndex(now);
  let lo = Infinity, hi = nowIdx;
  const cells = {}, issues = [];
  const accounts = names.map(name => {
    const recs = byAccount[name];
    const idxs = Object.keys(recs).map(indexOfLabel);
    const first = Math.min(...idxs), last = Math.max(...idxs);
    const lastRec = recs[monthLabel(last)];
    const day = new Date(parseDate(lastRec.statementDate)).getUTCDate();
    lo = Math.min(lo, first);
    const row = cells[name] = {};
    for (let i = first; i < last; i++) if (!recs[monthLabel(i)]) { row[monthLabel(i)] = { state: "gap" }; issues.push({ account: name, month: monthLabel(i), kind: "gap" }); }
    let nextDue = null;
    for (let i = last + 1; i <= nowIdx + 1; i++) {
      const expected = dayInMonth(i, day);
      if (expected + GRACE_DAYS * DAY > now) { nextDue = expected; break; }
      row[monthLabel(i)] = { state: "due" };
      issues.push({ account: name, month: monthLabel(i), kind: "due" });
    }
    Object.values(recs).forEach(r => { row[r.month] = { state: !r.ok ? "warn" : r.inferred ? "inferred" : "ok", record: r }; });
    return { name, last: lastRec, nextDue, overdue: issues.some(x => x.account === name && x.kind === "due") };
  });
  const list = [];
  for (let i = hi; i >= lo; i--) list.push(monthLabel(i));
  return { accounts, months: list, cells, issues };
}

// The issues worth a nudge: anything overdue, and gaps in the last few months.
function recentIssues(cov, now, monthsBack) {
  const nowIdx = monthIndex(now == null ? Date.now() : now);
  return cov.issues.filter(x => x.kind === "due" || indexOfLabel(x.month) > nowIdx - (monthsBack || 3));
}

const api = { coverage, recentIssues, recordFromImport, inferRecords, parseDate, idFor, GRACE_DAYS };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitStatements = api;
})(typeof self !== "undefined" ? self : this);

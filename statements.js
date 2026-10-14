/* Duit Bijak: which statements are in, and which are missing.
   A statement record is saved for each PDF imported. Statements imported
   before records existed are inferred from their saved transactions. Rows
   are statement sources (accounts.js): kind + bank, so a DBS card statement
   covering two cards is one row, and a new or cancelled card doesn't start
   a new one. Each source issues one statement a month, keyed by the month of its statement
   date (a card cycle ending 12 Sep is Sep). From that, coverage() finds the
   gaps between a source's first and latest statements, and the statements
   that should have been issued since its latest one. */
(function (root) {
"use strict";

const Acc = typeof module === "object" && module.exports ? require("./accounts.js") : root.DuitAccounts;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
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
const sourceOfRecord = r => r.source || Acc.sourceOf(r.account) || r.account;

// One parsed PDF from the import review → the record to save.
function recordFromImport(f, importedAt) {
  const date = parseDate(f.statementDate);
  if (date == null || !f.source) return null;
  const month = monthLabel(monthIndex(date));
  const list = f.accounts || [];
  return {
    id: Acc.recordId(f.source, month, list.map(a => a.number)), source: f.source, bank: f.bank, kind: f.kind,
    accounts: list.map(a => a.id), statementDate: f.statementDate, month, file: f.file, rows: f.rows.length,
    ok: f.checks.every(c => c.ok), importedAt: importedAt || new Date().toISOString(),
  };
}

// Saved records a new one replaces: same source and month, and either the
// same file re-imported or a record from before accounts had numbers.
function supersededBy(records, rec) {
  return (records || []).filter(r => r && r.id !== rec.id && sourceOfRecord(r) === rec.source && r.month === rec.month
    && ((r.file && r.file === rec.file) || !(r.accounts || []).length)).map(r => r.id);
}

// Statements with no record, rebuilt from saved transactions. Rows carrying
// their file are grouped by file, dated by their latest transaction. Rows
// from before files were kept fall back to one statement per calendar month.
function inferRecords(months, records) {
  const knownFiles = new Set(records.map(r => r.file).filter(Boolean));
  const groups = {};
  (months || []).forEach(m => (m.transactions || []).forEach(t => {
    const source = Acc.sourceOf(t.account);
    if (!source || (t.file && knownFiles.has(t.file))) return;
    const date = parseDate(t.date);
    if (date == null) return;
    const key = t.file ? `f:${source}|${t.file}` : `m:${source}|${monthIndex(date)}`;
    const g = groups[key] = groups[key] || { source, file: t.file || null, date: 0, rows: 0 };
    g.date = Math.max(g.date, date); g.rows++;
  }));
  const out = {};
  Object.values(groups).forEach(g => {
    const month = monthLabel(monthIndex(g.date)), id = Acc.recordId(g.source, month);
    if (out[id]) { out[id].rows += g.rows; return; }
    const d = new Date(g.date);
    out[id] = { id, source: g.source, statementDate: `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, month, file: g.file, rows: g.rows, ok: true, inferred: true };
  });
  return Object.values(out);
}

// Bank accounts first, then cards, each by bank.
function sourceOrder(a, b) {
  const ka = a.startsWith("bank-") ? 0 : 1, kb = b.startsWith("bank-") ? 0 : 1;
  return ka - kb || a.localeCompare(b);
}

// records: saved statement records. months: saved months, for inference.
// opts.hidden(source): leave that source out (all its accounts hidden).
// Returns { accounts (one per source; name is the source id), months
// (newest first), cells[source][month], issues }.
// A cell's state is "ok", "inferred", "warn" (totals didn't match), "gap"
// (missing between two statements), "due" (overdue since the latest one)
// or "none" (before the first statement, or not issued yet).
function coverage(records, months, now, opts) {
  now = now == null ? Date.now() : now;
  const hidden = (opts && opts.hidden) || (() => false);
  const saved = (records || []).filter(r => r && sourceOfRecord(r) && r.month);
  const ids = new Set(saved.map(r => r.id));
  const all = saved.concat(inferRecords(months, saved).filter(r => !ids.has(r.id)));
  const byAccount = {};
  // Two statements from one source in a month: the cell shows the worse.
  all.forEach(r => {
    const src = sourceOfRecord(r);
    if (hidden(src)) return;
    const row = byAccount[src] = byAccount[src] || {};
    if (!row[r.month] || (row[r.month].ok && !r.ok)) row[r.month] = r;
  });
  const names = Object.keys(byAccount).sort(sourceOrder);
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

const api = { coverage, recentIssues, recordFromImport, supersededBy, inferRecords, parseDate, GRACE_DAYS };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitStatements = api;
})(typeof self !== "undefined" ? self : this);

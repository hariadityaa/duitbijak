/* Duit Bijak: accounts.
   An account is one bank account or one card, named by what's printed on
   the statement: { id, bank, kind: "bank"|"card", number (last 4), name }.
   The id is built from those, so the same statement gives the same id on
   any device, and the kind can be read off the id without a lookup:
     bank-posb-6789, card-dbs-5678, or card-dbs when no number is known.
   A source is one statement series, kind + bank (card-dbs). A DBS card
   statement covering two cards is one source with two accounts.

   Transactions saved before accounts existed carry a statement type
   ("UOB One", "DBS CC", ...) instead. migrate() rewrites those to
   accounts with no number, and re-keys statement records by source. */
(function (root) {
"use strict";

const KINDS = ["bank", "card"];
// Legacy statement types → bank and kind. "Other" types take the bank from
// the statement record saved for the same file, when there is one.
const LEGACY = {
  "UOB One": { bank: "UOB", kind: "bank" },
  "POSB": { bank: "POSB", kind: "bank" },
  "DBS CC": { bank: "DBS", kind: "card" },
  "UOB Card": { bank: "UOB", kind: "card" },
  "Other account": { bank: "Other", kind: "bank" },
  "Other card": { bank: "Other", kind: "card" },
};

const slug = bank => String(bank || "other").toLowerCase().replace(/[^a-z0-9]+/g, "") || "other";
// Last 4 digits of whatever the statement prints, or null.
function last4(s) {
  const d = String(s == null ? "" : s).replace(/\D+/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}
const sourceId = (bank, kind) => `${kind}-${slug(bank)}`;
const accountId = (bank, kind, number) => sourceId(bank, kind) + (number ? `-${number}` : "");

function parseId(id) {
  const m = String(id || "").match(/^(bank|card)-([a-z0-9]+)(?:-(\d{4}))?$/);
  return m ? { kind: m[1], slug: m[2], number: m[3] || null, source: `${m[1]}-${m[2]}` } : null;
}
// Legacy statement types still resolve, so nothing routes by name alone.
function kindOf(id) {
  const p = parseId(id);
  if (p) return p.kind;
  return LEGACY[id] ? LEGACY[id].kind : null;
}
function sourceOf(id) {
  const p = parseId(id);
  if (p) return p.source;
  return LEGACY[id] ? sourceId(LEGACY[id].bank, LEGACY[id].kind) : null;
}

const KIND_WORD = { bank: "account", card: "card" };
function defaultName(a) {
  return `${a.bank} ${KIND_WORD[a.kind]}` + (a.number ? ` ·${a.number}` : "");
}
function makeAccount(bank, kind, number) {
  const a = { id: accountId(bank, kind, number), bank: String(bank || "Other"), kind, number: number || null };
  a.name = defaultName(a);
  return a;
}

// registry: { [id]: account }. A missing entry falls back to a name built
// from the id, so a synced transaction never shows blank.
function accountFor(id, registry) {
  const a = registry && registry[id];
  if (a) return a;
  const p = parseId(id);
  if (!p) return null;
  return makeAccount(p.slug.toUpperCase(), p.kind, p.number);
}
function accountName(id, registry) {
  const a = accountFor(id, registry);
  return a ? (a.name || defaultName(a)) : String(id || "");
}
// A source's label: its one visible account's name, else "DBS cards".
function sourceAccounts(source, registry) {
  return Object.values(registry || {}).filter(a => sourceOf(a.id) === source);
}
function sourceName(source, registry) {
  const all = sourceAccounts(source, registry);
  const shown = all.filter(a => !a.hidden);
  if (shown.length === 1) return shown[0].name || defaultName(shown[0]);
  const p = parseId(source);
  if (!p) return String(source || "");
  const bank = all.length ? all[0].bank : p.slug.toUpperCase();
  return `${bank} ${KIND_WORD[p.kind]}s`;
}
// Hidden only once every account it covers is hidden.
function sourceHidden(source, registry) {
  const all = sourceAccounts(source, registry);
  return all.length > 0 && all.every(a => a.hidden);
}

// Adds accounts the registry doesn't have. Names and hidden flags already
// there are kept. Returns the new registry and the accounts added.
function register(registry, accounts) {
  const out = { ...(registry || {}) }, added = [];
  (accounts || []).forEach(a => {
    if (!a || !a.id || out[a.id]) return;
    out[a.id] = { ...a, name: a.name || defaultName(a) };
    added.push(out[a.id]);
  });
  return { registry: out, added };
}

const isLegacy = v => Object.prototype.hasOwnProperty.call(LEGACY, v);
function fromLegacy(stmtType, bank) {
  const l = LEGACY[stmtType];
  if (!l) return null;
  const isOther = /^Other /.test(stmtType);
  return makeAccount(isOther && bank ? bank : l.bank, l.kind, null);
}

// Statement record id: one per source per statement month. The account
// numbers on it are added so two statements from one source in the same
// month (say, two separate accounts) don't overwrite each other.
function recordId(source, month, numbers) {
  const nums = (numbers || []).filter(Boolean).slice().sort();
  return `${source}|${month}${nums.length ? "|" + nums.join("+") : ""}`.replace(/[^\w|+-]+/g, "_");
}

// One-time rewrite of data saved before accounts existed. Pure and
// idempotent: only legacy statement types and records with no source change.
// data: { months, statements, accounts }. Returns the same shape plus
// changedMonths (month keys rewritten), removedStatements (old record ids)
// and addedAccounts.
function migrate(data) {
  const statements = data.statements || {};
  const fileBank = {};
  Object.values(statements).forEach(r => { if (r && r.file && r.bank) fileBank[r.file] = r.bank; });
  let registry = { ...(data.accounts || {}) };
  const addedAccounts = [];
  const add = a => { const res = register(registry, [a]); registry = res.registry; addedAccounts.push(...res.added); };

  const changedMonths = [];
  const months = (data.months || []).map(m => {
    if (!m || !(m.transactions || []).some(t => isLegacy(t.account))) return m;
    changedMonths.push(m.month);
    return { ...m, transactions: m.transactions.map(t => {
      if (!isLegacy(t.account)) return t;
      const a = fromLegacy(t.account, t.file && fileBank[t.file]);
      add(a);
      return { ...t, account: a.id };
    }) };
  });

  const outStatements = {}, removedStatements = [];
  Object.entries(statements).forEach(([key, r]) => {
    if (!r || r.source) { outStatements[key] = r; return; }
    const type = isLegacy(r.stmtType) ? r.stmtType : r.account;
    const l = LEGACY[type];
    if (!l) { outStatements[key] = r; return; }
    const bank = /^Other /.test(type) ? (r.bank || "Other") : l.bank;
    const source = sourceId(bank, l.kind);
    add(makeAccount(bank, l.kind, null));
    const id = recordId(source, r.month, []);
    const next = { ...r, id, source, bank, kind: l.kind, accounts: [] };
    delete next.account;
    removedStatements.push(key);
    const prev = outStatements[id];
    if (!prev || String(prev.importedAt || "") < String(next.importedAt || "")) outStatements[id] = next;
  });
  // A record re-keyed onto its own old id isn't removed.
  const removed = removedStatements.filter(k => !outStatements[k]);

  return { months, statements: outStatements, accounts: registry, changedMonths, removedStatements: removed, addedAccounts,
    changed: changedMonths.length > 0 || removedStatements.length > 0 || addedAccounts.length > 0 };
}

// Re-imports. Rows saved in a month come back as import rows (txToRow).
// Rows from a re-uploaded file are replaced by the new ones; rows saved
// before transactions carried their file are matched one for one (so three
// identical purchases stay three) on date, type, amount and description,
// then on date, type, amount and statement source. Source, not account, so
// a row saved as bank-posb before accounts had numbers matches
// bank-posb-6789. Description goes first because older CSV imports could
// mislabel the account; digits are ignored because older imports stripped
// merchant numbers. A matched row passes its category on, so hand-set
// categories survive a re-import.
function txToRow(tx) {
  const isDr = tx.withdrawal != null;
  return { file: tx.file || "", date: tx.date, description: tx.description, amount: isDr ? tx.withdrawal : (tx.deposit || 0), type: isDr ? "DR" : "CR", category: tx.category || "", account: tx.account };
}
const descKey = d => String(d || "").toUpperCase().replace(/[\d\s]+/g, "");
const sameAmount = (a, b) => a.date === b.date && a.type === b.type && Math.abs(a.amount - b.amount) < 0.005;
function matchOldRows(incoming, pool) {
  const tiers = [(o, r) => descKey(o.description) === descKey(r.description), (o, r) => sourceOf(o.account) === sourceOf(r.account)];
  tiers.forEach(same => incoming.forEach(r => {
    if (r.matched) return;
    const old = pool.find(o => !o.matched && sameAmount(o, r) && same(o, r));
    if (!old) return;
    old.matched = r.matched = true;
    if (!r.category && old.category) r.category = old.category;
  }));
}
// savedTxs: one month's saved transactions. incoming: new rows for that
// month. files: every file in this import. Returns the month's rows and how
// many saved rows the new ones replaced.
function mergeMonth(savedTxs, incoming, files) {
  const saved = (savedTxs || []).map(txToRow);
  const rows = incoming.map(r => ({ ...r }));
  const sameFile = saved.filter(r => r.file && files.has(r.file));
  const legacy = saved.filter(r => !r.file);
  matchOldRows(rows, sameFile.concat(legacy));
  const keptLegacy = legacy.filter(r => !r.matched);
  const strip = ({ matched, ...r }) => r;
  return {
    rows: [...saved.filter(r => r.file && !files.has(r.file)), ...keptLegacy, ...rows].map(strip),
    replaced: sameFile.length + legacy.length - keptLegacy.length,
  };
}

const api = { KINDS, LEGACY, slug, last4, sourceId, accountId, parseId, kindOf, sourceOf, defaultName, makeAccount,
  accountFor, accountName, sourceAccounts, sourceName, sourceHidden, register, isLegacy, fromLegacy, recordId, migrate, txToRow, matchOldRows, mergeMonth };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitAccounts = api;
})(typeof self !== "undefined" ? self : this);

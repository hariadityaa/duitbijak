/* Duit Bijak: the user's own rules for sorting transactions into totals.
   Fixed bills, salary, one-off and savings categories, card bill payments and internal
   transfers are edited in Settings and saved with the ledger. Nothing about
   one person's finances lives in code: DEFAULT_RULES are generic Singapore
   starters, used until the user saves their own.

   A pattern is plain text, matched anywhere in the description, any case.
   Wrapped in /…/ it is a regex, also matched in any case. */
(function (root) {
"use strict";

const categorise = typeof module === "object" && module.exports ? require("./categorise.js") : root.DuitCategorise;

// Always one-off, whatever the list says: Net Op-Ex subtracts it.
const BUILT_IN_ONE_OFF = ["Reimbursement"];

// DBS/POSB and UOB wording comes from real statements. OCBC, Citi, SC and the
// generic card-side credits are best guesses; users can edit them.
const DEFAULT_RULES = {
  version: 1,
  fixedBills: [
    { name: "HDB Loan", match: "/HDB.*LOAN/" },
    { name: "IRAS", match: "IRAS" },
    { name: "CPF", match: "CPF" },
    { name: "Town Council", match: "TOWN COUNCIL" },
  ],
  salary: ["SALARY", "GIRO SALA", "PAYROLL"],
  oneOffCategories: ["Internal Transfer"],
  // Cash moved into assets you still own: kept out of op-ex, and counted
  // towards the savings rate instead of spend.
  savingsCategories: ["Investment"],
  cardBillPayments: [
    "/Bill Payment.*(Cards?|DBSC)/", "BILL PAYMENT - DBS INTERNET",
    "mBK-UOB Cards", "PAYMT THRU E-BANK",
    "/OCBC.*CARD/", "/CITI(BANK)?.*CARD/", "/(STANDARD CHARTERED|SCB).*CARD/",
    "PAYMENT - THANK YOU", "PAYMENT RECEIVED",
  ],
  internalTransfers: ["/Funds Tr(a|f)nsfer/", "Funds Trf"],
};
const LISTS = ["salary", "oneOffCategories", "savingsCategories", "cardBillPayments", "internalTransfers"];

/* ---------------------------- patterns ---------------------------- */
const isRegexForm = s => s.length > 2 && s[0] === "/" && s[s.length - 1] === "/";
// Plain text matches across any run of spaces, since statements pad words.
function compilePattern(pattern) {
  const s = String(pattern == null ? "" : pattern).trim();
  if (!s) return { re: null, error: "Empty" };
  if (isRegexForm(s)) {
    try { return { re: new RegExp(s.slice(1, -1), "i"), error: null }; }
    catch (e) { return { re: null, error: "Not a valid regex" }; }
  }
  const literal = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return { re: new RegExp(literal, "i"), error: null };
}
const patternError = p => compilePattern(p).error;

/* ---------------------------- shape ---------------------------- */
const clone = r => JSON.parse(JSON.stringify(r));
function cleanList(list) {
  const seen = new Set(), out = [];
  (Array.isArray(list) ? list : []).forEach(v => {
    const s = String(v == null ? "" : v).trim();
    if (s && !seen.has(s.toUpperCase())) { seen.add(s.toUpperCase()); out.push(s); }
  });
  return out;
}
// Null (never saved) means the defaults. A saved list stays as saved, even empty.
function normaliseRules(raw) {
  if (!raw || typeof raw !== "object") return clone(DEFAULT_RULES);
  const out = { version: 1 };
  const names = new Set();
  out.fixedBills = (Array.isArray(raw.fixedBills) ? raw.fixedBills : []).map(b => ({
    name: String((b && b.name) || "").trim(), match: String((b && b.match) || "").trim(),
  })).filter(b => b.name && b.match && !names.has(b.name.toUpperCase()) && names.add(b.name.toUpperCase()));
  LISTS.forEach(k => { out[k] = cleanList(Array.isArray(raw[k]) ? raw[k] : DEFAULT_RULES[k]); });
  // Rules saved before savings existed listed Investment as one-off. A label
  // in both lists counts as savings.
  const savings = new Set(out.savingsCategories.map(c => c.toUpperCase()));
  out.savingsCategories = out.savingsCategories.filter(c => !BUILT_IN_ONE_OFF.includes(c));
  out.oneOffCategories = out.oneOffCategories.filter(c => !BUILT_IN_ONE_OFF.includes(c) && !savings.has(c.toUpperCase()));
  if (raw.updatedAt) out.updatedAt = String(raw.updatedAt);
  return out;
}

/* ---------------------------- matching ---------------------------- */
// Invalid patterns are skipped here; Settings won't save them anyway.
function compileRules(raw) {
  const r = normaliseRules(raw);
  const res = list => list.map(p => compilePattern(p).re).filter(Boolean);
  const any = list => { const rs = res(list); return d => rs.some(re => re.test(d || "")); };
  const bills = r.fixedBills.map(b => ({ name: b.name, re: compilePattern(b.match).re })).filter(b => b.re);
  const savings = new Set(r.savingsCategories);
  const oneOff = new Set([...r.oneOffCategories, ...BUILT_IN_ONE_OFF, ...savings]);
  return {
    rules: r,
    isTransfer: any(r.internalTransfers),
    isCardBill: any(r.cardBillPayments),
    isSalary: any(r.salary),
    fixedBillFor: d => { const b = bills.find(x => x.re.test(d || "")); return b ? b.name : null; },
    // Savings labels are one-off too, so op-ex leaves them out.
    isOneOff: label => oneOff.has(label),
    isSavings: label => savings.has(label),
  };
}

// Where a bank-account row goes. "spend" rows are then sorted by category
// label: one-off if the label is in the list, op-ex otherwise.
function routeBankTx(tx, c) {
  const d = tx.description || "";
  if (c.isTransfer(d)) return { kind: "skip" };
  if (tx.type === "DR" && c.isCardBill(d)) return { kind: "skip" };
  const bill = tx.type === "DR" ? c.fixedBillFor(d) : null;
  if (bill) return { kind: "fixed", name: bill };
  if (tx.type === "CR") return { kind: c.isSalary(d) ? "salary" : "otherIn" };
  return { kind: "spend" };
}
function routeCardTx(tx, c) {
  return c.isCardBill(tx.description || "") ? { kind: "skip" } : { kind: "spend" };
}

/* ---------------------------- suggestions ---------------------------- */
const monthOf = date => { const p = String(date || "").trim().split(/\s+/); return p.length >= 3 ? `${p[1]} ${p[2]}` : null; };
const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const words = d => String(d || "").toUpperCase().split(/\s+/).filter(Boolean);
const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

// The keyword for a group: from the merchant's first word, as many following
// words as every description shares. Falls back to a regex on the merchant key.
function keywordFor(descs, key) {
  const first = key.split(" ")[0];
  const ws = words(descs[0]);
  const start = ws.findIndex(w => w.replace(/[^A-Z&]+/g, " ").trim().split(" ").includes(first));
  const norm = descs.map(d => words(d).join(" "));
  if (start !== -1) {
    let best = null;
    for (let end = start + 1; end <= ws.length && !/\d/.test(ws[end - 1]); end++) {
      const phrase = ws.slice(start, end).join(" ");
      if (norm.every(n => n.includes(phrase))) best = phrase; else break;
    }
    if (best && best.length >= 3) return best;
  }
  return `/${key.split(" ").join("\\W+")}/`;
}

// Proposes fixed bills from bank debits no rule covers yet: same merchant in
// at least minMonths distinct months, once a month, every amount within
// tolerance of the median. txs are saved ledger rows ({ date, account,
// description, withdrawal }); isBank(account) picks bank-account rows.
function suggestFixedBills(txs, raw, opts) {
  const o = { minMonths: 3, tolerance: 0.15, isBank: () => true, ...(opts || {}) };
  const c = compileRules(raw);
  const groups = new Map();
  (txs || []).forEach(tx => {
    if (!tx || tx.withdrawal == null || !(tx.withdrawal > 0) || !o.isBank(tx.account)) return;
    const d = tx.description || "";
    if (c.isTransfer(d) || c.isCardBill(d) || c.fixedBillFor(d) || c.isSalary(d)) return;
    const key = categorise.merchantKey(d), month = monthOf(tx.date);
    if (!key || !month) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ month, amount: tx.withdrawal, description: d });
  });
  const out = [];
  groups.forEach((rows, key) => {
    const months = new Set(rows.map(r => r.month));
    if (months.size < o.minMonths || months.size !== rows.length) return;
    const mid = median(rows.map(r => r.amount));
    if (!rows.every(r => Math.abs(r.amount - mid) <= mid * o.tolerance)) return;
    const descs = rows.map(r => r.description);
    const match = keywordFor(descs, key);
    const re = compilePattern(match).re;
    if (!re || !descs.every(d => re.test(d))) return;
    const name = titleCase(isRegexForm(match) ? key : match.split(" ").slice(0, 3).join(" "));
    const avg = Math.round(rows.reduce((s, r) => s + r.amount, 0) / rows.length * 100) / 100;
    out.push({ name, match, months: months.size, avg, example: descs[descs.length - 1] });
  });
  return out.sort((a, b) => b.avg - a.avg);
}

const api = { DEFAULT_RULES, BUILT_IN_ONE_OFF, compilePattern, patternError, normaliseRules, compileRules, routeBankTx, routeCardTx, suggestFixedBills };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitRules = api;
})(typeof self !== "undefined" ? self : this);

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
  // Bank credits that are friends paying you back. They reduce op-ex instead
  // of counting as income. Filled in as suggestions are confirmed.
  reimbursedBy: [],
  // Senders you said are not repayments, so they stop being suggested.
  notReimbursements: [],
};
const LISTS = ["salary", "oneOffCategories", "savingsCategories", "cardBillPayments", "internalTransfers", "reimbursedBy", "notReimbursements"];

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
    isReimbursement: any(r.reimbursedBy),
    isNotReimbursement: any(r.notReimbursements),
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

/* ---------------------------- repayments ---------------------------- */
// Words that mark a sender as a business, not a friend.
const COMPANY_WORDS = new Set(["PTE", "LTD", "LLP", "LIMITED", "PRIVATE", "SDN", "BHD", "INC", "CORP", "GROUP", "SERVICES", "DESIGN", "INTERIOR", "INTERIORS", "TESTING", "TRADING", "HOLDINGS", "ENTERPRISE", "STUDIO", "BANK"]);
const PAYNOW_FROM = /Incoming PayNow[^:]*From:\s*(.+)$/i;
// Credits this size or bigger are shown with a "check this" note.
const REPAYMENT_CHECK_OVER = 500;

// The sender's name on a PayNow credit: the run of all-capital words after
// "From:". The memo follows it, and usually has lowercase letters. Null for
// other credits, companies, and senders typed in mixed case.
function paynowSender(description) {
  const m = PAYNOW_FROM.exec(String(description || ""));
  if (!m) return null;
  const run = [];
  for (const w of m[1].trim().split(/\s+/)) { if (/[a-z\d]/.test(w) || w === "OTHR") break; run.push(w); }
  if (!run.length || run.join("").length < 3) return null;
  if (run.some(w => COMPANY_WORDS.has(w.replace(/[^A-Z]/g, "")))) return null;
  return run.join(" ");
}

// Proposes senders whose PayNow credits are probably friends paying you back.
// Grouped by sender, shown once. A caps memo glued to a name ("… STEPHEN
// DINNER") joins the shorter name. Credits under $1 (bank tests), rows with a
// saved category, and senders already decided are left out.
// txs are saved ledger rows ({ date, account, description, deposit, category });
// isBank(account) picks bank-account rows.
function suggestReimbursers(txs, raw, opts) {
  const o = { isBank: () => true, ...(opts || {}) };
  const c = compileRules(raw);
  const byRun = new Map();
  (txs || []).forEach(tx => {
    if (!tx || !(tx.deposit >= 1) || tx.category || !o.isBank(tx.account)) return;
    const d = tx.description || "";
    if (c.isSalary(d) || c.isReimbursement(d) || c.isNotReimbursement(d)) return;
    const run = paynowSender(d);
    if (!run) return;
    if (!byRun.has(run)) byRun.set(run, []);
    byRun.get(run).push({ amount: tx.deposit, month: monthOf(tx.date), description: d });
  });
  const keys = [];
  const groups = new Map();
  [...byRun.keys()].sort((a, b) => a.split(" ").length - b.split(" ").length).forEach(run => {
    const key = keys.find(k => run === k || run.startsWith(k + " ")) || (keys.push(run), run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...byRun.get(run));
  });
  const out = [];
  groups.forEach((rows, key) => {
    const amounts = rows.map(r => r.amount), total = amounts.reduce((s, v) => s + v, 0), max = Math.max(...amounts);
    out.push({
      name: titleCase(key), match: `From: ${key}`, count: rows.length, total: Math.round(total * 100) / 100,
      min: Math.min(...amounts), max, months: new Set(rows.map(r => r.month)).size,
      check: max >= REPAYMENT_CHECK_OVER, example: rows[rows.length - 1].description,
    });
  });
  return out.sort((a, b) => b.count - a.count || b.total - a.total);
}

/* ---------------------------- sharing ---------------------------- */
// Rules travel as a small JSON file, or as the reply to a prompt pasted into
// an AI chat. Both are merged into the draft, never saved straight away.
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
const RULE_KEYS = ["fixedBills", ...LISTS];

function exportRules(raw, exportedAt) {
  return { app: "duit-bijak", kind: "rules", version: 1, exportedAt: exportedAt || new Date().toISOString(), rules: normaliseRules(raw) };
}

// Accepts an exported rules file, a full backup, or a bare rules object, with
// or without chat-style code fences around it. Returns only what the text
// holds (missing lists stay empty, so a merge adds nothing for them) and the
// patterns it had to leave out. Throws with a reason a person can act on.
function parseRulesText(text) {
  const s = String(text == null ? "" : text);
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error("No rules found in that text.");
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { throw new Error("That isn't valid JSON."); }
  if (isObj(obj) && obj.app === "duit-bijak") obj = obj.kind === "rules" ? obj.rules : isObj(obj.data) ? obj.data.rules : null;
  if (!isObj(obj) || !RULE_KEYS.some(k => Array.isArray(obj[k]))) throw new Error("No rules found in that text.");
  const skipped = [];
  const ok = (p, label) => { const err = patternError(p); if (err) skipped.push(`${label}: ${err}`); return !err; };
  const out = { fixedBills: [] };
  (Array.isArray(obj.fixedBills) ? obj.fixedBills : []).forEach(b => {
    const name = String((b && b.name) || "").trim(), match = String((b && b.match) || "").trim();
    if (name && match && ok(match, name)) out.fixedBills.push({ name, match });
  });
  LISTS.forEach(k => {
    const list = cleanList(obj[k]);
    out[k] = LABEL_LISTS.includes(k) ? list : list.filter(p => ok(p, p));
  });
  return { rules: out, skipped };
}
const LABEL_LISTS = ["oneOffCategories", "savingsCategories"];

// Adds what's new in `incoming` to `base`. Nothing is removed. Returns the
// merged rules and how many entries were added.
function mergeRules(base, incoming) {
  const b = normaliseRules(base), inc = incoming || {};
  let added = 0;
  const names = new Set(b.fixedBills.map(x => x.name.toUpperCase())), matches = new Set(b.fixedBills.map(x => x.match.toUpperCase()));
  (inc.fixedBills || []).forEach(x => {
    if (!x || !x.name || !x.match || names.has(x.name.toUpperCase()) || matches.has(x.match.toUpperCase())) return;
    names.add(x.name.toUpperCase()); matches.add(x.match.toUpperCase());
    b.fixedBills.push({ name: x.name, match: x.match }); added++;
  });
  LISTS.forEach(k => {
    const have = new Set(b[k].map(v => v.toUpperCase()));
    cleanList(inc[k]).forEach(v => { if (!have.has(v.toUpperCase())) { have.add(v.toUpperCase()); b[k].push(v); added++; } });
  });
  return { rules: normaliseRules(b), added };
}

// Text to paste into an AI chat. It holds the schema, the current rules and a
// sample of transaction descriptions, one line per merchant, so the person
// can read exactly what they're sending. txs are saved ledger rows.
function buildRulesPrompt(txs, raw, opts) {
  const o = { max: 120, ...(opts || {}) };
  const groups = new Map();
  (txs || []).forEach(tx => {
    if (!tx || !tx.description) return;
    const out = tx.withdrawal != null;
    const amount = out ? tx.withdrawal : tx.deposit;
    if (!(amount > 0)) return;
    const key = (out ? "DR " : "CR ") + (categorise.merchantKey(tx.description) || tx.description.toUpperCase());
    if (!groups.has(key)) groups.set(key, { type: out ? "DR" : "CR", amounts: [], example: tx.description });
    const g = groups.get(key); g.amounts.push(amount); g.example = tx.description;
  });
  const lines = [...groups.values()].sort((x, y) => y.amounts.length - x.amounts.length || median(y.amounts) - median(x.amounts)).slice(0, o.max)
    .map(g => `${g.type} | ${g.amounts.length}x | about ${Math.round(median(g.amounts))} | ${g.example.replace(/\s+/g, " ").trim()}`);
  return `I use a personal finance app that sorts bank transactions with rules. Using the transactions below, suggest rules in the JSON shape shown. Reply with JSON only.

Rules:
- "fixedBills": recurring bank debits to count as fixed. Each is {"name": "...", "match": "..."}.
- "salary": text found in salary credits.
- "cardBillPayments": text in payments from my bank account to my own credit cards.
- "internalTransfers": text in transfers between my own accounts.
- "oneOffCategories" and "savingsCategories": leave as they are unless a category is clearly needed.
- A match is plain text, found anywhere in the description in any case. Wrap it in /slashes/ for a regex. Prefer short plain text. Do not repeat anything already in my current rules.

My current rules:
${JSON.stringify(normaliseRules(raw))}

Transactions (type | how often | typical amount | example description):
${lines.join("\n")}
`;
}

const api = { DEFAULT_RULES, BUILT_IN_ONE_OFF, compilePattern, patternError, normaliseRules, compileRules, routeBankTx, routeCardTx, suggestFixedBills, suggestReimbursers, paynowSender, REPAYMENT_CHECK_OVER, exportRules, parseRulesText, mergeRules, buildRulesPrompt };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitRules = api;
})(typeof self !== "undefined" ? self : this);

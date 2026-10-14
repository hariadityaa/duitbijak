// Constants, utilities and CSV/TSV parsing.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== constants ============================== */
const STORAGE_KEY = "duit-bijak-finance-ledger-v1";
const MONTH_ORDER = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const CATEGORY_FIELDS = [
  ["cat_shopping","Shopping/Online"], ["cat_dining","Dining & Food"], ["cat_transport","Transport"],
  ["cat_sports","Sports"], ["cat_home","Home & Furniture"], ["cat_groceries","Groceries"],
  ["cat_services","Services"], ["cat_electronics","Electronics"], ["cat_subscriptions","Subscriptions"],
  ["cat_travel","Travel"], ["cat_fashion","Fashion"], ["cat_utilities","Utilities"], ["cat_convenience","Convenience Stores"],
  ["cat_other","Other"],
];

// Statement types. "Other …" are statements read by Gemini (gemini-parse.js).
// Bank vs card comes from the account id (accounts.js), e.g. card-dbs-5678.
const isBankAccount = id => DuitAccounts.kindOf(id) === "bank";
const isCardAccount = id => DuitAccounts.kindOf(id) === "card";
const accountLabel = id => DuitAccounts.accountName(id, appData.accounts);
const sourceLabel = src => DuitAccounts.sourceName(src, appData.accounts);
// Category rules and history matching live in categorise.js. Fixed bills,
// salary, one-offs, card bill payments and transfers are the user's own rules
// (rules.js, edited in Settings), saved with the ledger.

/* ============================== utilities ============================== */
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = n => { if (n == null || isNaN(n)) return "—"; const r = Math.round(n); return r < 0 ? `-$${Math.abs(r).toLocaleString()}` : `$${r.toLocaleString()}`; };
const pct = (a, b) => b ? ((a - b) / b * 100).toFixed(0) : null;
function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return `var(--chart-${(Math.abs(h) % 10) + 1})`;
}
// Assigns colors by rank (order of `names`) instead of a hash, so the handful of
// categories in any one view get visually distinct colors instead of colliding.
function colorMap(names) {
  const map = {};
  names.forEach((n, i) => { if (!(n in map)) map[n] = `var(--chart-${(i % 10) + 1})`; });
  return name => map[name] || hashColor(name);
}

/* ============================== CSV / TSV parsing ============================== */
function parseCsv(text, delimiter) {
  delimiter = delimiter || ",";
  const rows = []; let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(f => f !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== "") || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? "\t" : ",";
}
function parseSheetTransactions(csvText) {
  const rows = parseCsv(csvText, detectDelimiter(csvText));
  const headerIdx = rows.findIndex(r => (r[0] || "").trim() === "Statement File");
  if (headerIdx === -1) throw new Error('No "Statement File" header found. Paste the full table, starting with its header row.');
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const file = (r[0] || "").trim();
    if (!file || file === "File ID") break;
    const bank = (r[1] || "").trim();
    const date = (r[2] || "").trim();
    const description = (r[3] || "").trim();
    const amount = parseFloat((r[4] || "0").replace(/,/g, ""));
    const type = (r[5] || "").trim().toUpperCase();
    const category = (r[6] || "").trim();
    if (!date || !bank) continue;
    out.push({ file, bank, date, description, amount: isNaN(amount) ? 0 : amount, type, category });
  }
  if (!out.length) throw new Error("No transaction rows found under the header.");
  return out;
}
function classifyFile(rows) {
  // Salary and fixed bills only arrive in a bank account, so either marks one.
  const text = rows.map(r => r.description).join(" | ");
  const c = currentRules();
  if (/One Account/i.test(text) || rows.some(r => c.isSalary(r.description) || c.fixedBillFor(r.description))) return "UOB One";
  const bank = rows[0] && rows[0].bank;
  if (bank === "POSB") return "POSB";
  if (bank === "DBS") return "DBS CC";
  if (bank === "UOB") return "UOB Card";
  return "Unknown";
}
// Rebuilt whenever appData.months is replaced, so a new import or sync
// teaches the next guess. Only saved (hand-set or imported) labels count.
let categoryHistoryFor = null, categoryHistory = new Map();
function currentCategoryHistory() {
  if (categoryHistoryFor !== appData.months) {
    categoryHistoryFor = appData.months;
    categoryHistory = DuitCategorise.buildCategoryHistory(appData.months.flatMap(m => m.transactions || []));
  }
  return categoryHistory;
}
// Recompiled whenever appData.rules is replaced (a save or a sync).
let rulesFor, compiledRules = null;
function currentRules() {
  if (!compiledRules || rulesFor !== appData.rules) { rulesFor = appData.rules; compiledRules = DuitRules.compileRules(appData.rules); }
  return compiledRules;
}
const classifyOpex = description => DuitCategorise.classifyOpex(description, currentCategoryHistory());
const resolveCategory = tx => DuitCategorise.resolveCategory(tx.description, tx.category, currentCategoryHistory());
function monthKeyFromDate(dateStr) {
  const parts = dateStr.trim().split(" ");
  if (parts.length < 3) return null;
  return `${parts[1]} ${parts[2]}`;
}

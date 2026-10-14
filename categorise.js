/* Duit Bijak: transaction auto-categorisation.
   Runs in this browser only. Rows without a category get one from, in order:
   1. a pinned rule (merchants whose label is settled, whatever the history says),
   2. the label last given to the same merchant in saved transactions,
   3. the regex rules below.
   Older labels are folded into the current ones by CATEGORY_ALIASES, so a
   rename doesn't split a merchant's history or a month's totals. */
(function (root) {
"use strict";

const CATEGORY_ALIASES = {
  "Transport - SMRT": "Transport",
  "Transport - Ride-Hail": "Transport",
  "Sports/Padel": "Sports",
  "7-Eleven": "Convenience Stores",
};
const canonCategory = label => (label && CATEGORY_ALIASES[label]) || label;

// First match wins. Pinned rules run before history.
const OPEX_MATCH_RULES = [
  { cat: "Convenience Stores", match: /7[\s-]?ELEVEN/i, pinned: true },
  { cat: "Credit Card Payment", match: /PAYMT THRU E-BANK/i },
  { cat: "Interest Income", match: /Bonus Interest|Interest Credit|Interest Earned/i },
  { cat: "Transport", match: /BUS\/MRT/i },
  { cat: "Subscriptions", match: /Netflix|YOUTUBE|Grab\s*Subscription|Subscription\s*Grab|AMZNPRIME|Amazon Prime|ANTHROPIC.*CLAUDE|GOOGLE\s*ONE|GOOGLE\W*PLAY|PAYPAL \*GOOGLE|CARD MEMBERSHIP|ANNUAL FEE|CARD FEE/i },
  { cat: "Utilities", match: /SP Digital|STARHUB|\bGOMO\b|MyRepublic|KEPPEL ELECTRIC|SENOKO|GENECO|TUAS POWER/i },
  { cat: "Sports", match: /PLAYTOMIC|Anytime\s*Fitness|Padel|Badminton/i },
  { cat: "Convenience Stores", match: /\bCHEERS\b/i },
  { cat: "Groceries", match: /\bNTUC\b|FAIRPRICE|COLD STORAGE|REDMART|NESPRESSO|SHENG SIONG|\bGIANT\b|DON DON DONKI|SAN XIANG|MEATMEN/i },
  { cat: "Shopping/Online", match: /SHOPEE|LAZADA|AMAZON MKTPLC|\bSHEIN\b|UNIQLO|DECATHLON/i },
  { cat: "Transport", match: /Grab\*|TADA Mobility|PAYPAL \*GOJEK/i },
  { cat: "Electronics", match: /BEST DENKI|HARVEY NORMAN|CHALLENGER|AFTERSHOCK|APPLE STORE/i },
  { cat: "Home & Furniture", match: /\bIKEA\b|\bMUJI\b|NIPPON HOME/i },
  { cat: "Services", match: /URBANCOMPANY|AXS PTE LTD|HSBC LIFE|WHITECOATME/i },
  { cat: "Travel", match: /FLYSCOOT|SCOOT PTE|BINTAN RESORT FERRIES|LOTTE DUTY FREE|EXPEDIA|TRIP\W?COM|AGODA|BOOKING\.COM|AIRBNB|SINGAPORE AIRLINES/i },
  { cat: "Dining & Food", match: /SUBWAY|RAMEN|SUSHIRO|CAFE|BAKERY|BREADTALK|KITCHEN|BISTRO|PIZZ|KOPI|THAI|CURRY|NASI|HAWKER|VENDING|IJOOZ|POKE|TONKOTSU|BUTAO|KOREAN|CATERING|PENYET|GUZMAN|GRUMPY|FOOD|NOODLE|CHICKEN|BURGER|RESTAURANT|EATERY|PRATA|STUFF'?D/i },
];

// Bank wrappers in front of the merchant name. Words with digits (refs,
// card numbers, dates, branch codes) are dropped, so one merchant's rows share a key.
const KEY_PREFIXES = [
  /^MISC (DR|CR)-DEBIT CARD \d+ [A-Z]{3}\s*/,
  /^PAYNOW-FAST \S+\s*/,
  /^NETS DEBIT-CONSUMER\s*/,
  /^FAST PAYMENT \/ RECEIPT\s*/,
  /^INWARD (DR|DEBIT|CR)\s*-\s*(FAST|GIRO)?\s*(OTHR|COLL)?\s*/,
  /^WWW\./,
];
const KEY_STOPWORDS = new Set(["SINGAPORE", "SG", "OTHR"]);
function merchantKey(description) {
  let s = String(description || "").toUpperCase().trim();
  KEY_PREFIXES.forEach(p => { s = s.replace(p, ""); });
  s = s.replace(/7[\s-]?ELEVEN/g, "SEVENELEVEN");
  const words = s.split(/\s+/).filter(w => !/\d/.test(w)).join(" ")
    .replace(/[^A-Z&]+/g, " ").split(" ")
    .filter(w => w.length > 1 && !KEY_STOPWORDS.has(w));
  return words.slice(0, 2).join(" ");
}

// txs in date order, each { description, category }. Later labels win.
function buildCategoryHistory(txs) {
  const history = new Map();
  (txs || []).forEach(tx => {
    if (!tx || !tx.category) return;
    const key = merchantKey(tx.description);
    if (key) history.set(key, canonCategory(tx.category));
  });
  return history;
}

function classifyOpex(description, history) {
  const d = description || "";
  const pinned = OPEX_MATCH_RULES.find(r => r.pinned && r.match.test(d));
  if (pinned) return pinned.cat;
  const learned = history && history.get(merchantKey(d));
  if (learned) return learned;
  const hit = OPEX_MATCH_RULES.find(r => r.match.test(d));
  return hit ? hit.cat : "Uncategorized";
}

// A saved label wins over a guess, except where a pinned rule settles the merchant.
function resolveCategory(description, category, history) {
  const d = description || "";
  const pinned = OPEX_MATCH_RULES.find(r => r.pinned && r.match.test(d));
  if (pinned) return pinned.cat;
  return canonCategory(category) || classifyOpex(d, history);
}

// Folds old labels in a month's per-category totals into the current ones.
function canonCategoryTotals(totals) {
  if (!totals) return totals;
  const out = {};
  Object.entries(totals).forEach(([label, amt]) => {
    const k = canonCategory(label);
    out[k] = Math.round(((out[k] || 0) + (Number(amt) || 0)) * 100) / 100;
  });
  return out;
}

/* One-off spend, classed by what it buys rather than by size alone:
   asset (lasts years, spread over its life), prepaid (covers a coming period,
   spread over it) and exceptional (kept out of core op-ex, shown on its own).
   The size threshold only decides what gets suggested. */
const ONE_OFF_THRESHOLD = 500;
const TRAVEL_CLUSTER_DAYS = 3;
const SPEND_TYPES = {
  asset: { label: "Asset", life: 36 },
  prepaid: { label: "Prepaid", life: 12 },
  exceptional: { label: "Exceptional", life: 0 },
};
const ASSET_CATEGORIES = new Set(["Electronics", "Home & Furniture"]);
const PREPAID_MATCH = /ANNUAL FEE|CARD MEMBERSHIP|CARD FEE/i;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// "12 Sep 2026" -> days since 1970; null when unreadable.
function dayNumber(date) {
  const [d, mon, y] = String(date || "").trim().split(/\s+/);
  const mi = MONTHS.indexOf(mon);
  if (mi < 0 || !Number(d) || !Number(y)) return null;
  return Date.UTC(Number(y), mi, Number(d)) / 86400000;
}
// "Sep 2026" -> a running month count, so months subtract.
function monthNumber(month) {
  const [mon, y] = String(month || "").trim().split(/\s+/);
  const mi = MONTHS.indexOf(mon);
  return mi < 0 || !Number(y) ? null : Number(y) * 12 + mi;
}

// rows: op-ex rows { date, description, category, amount }, amount > 0 for spend.
// Returns a suggested type (or null) per row. A trip paid in pieces is caught
// by taking any Travel row within a few days of a big Travel row.
function suggestSpendTypes(rows) {
  const anchors = (rows || []).filter(r => r.category === "Travel" && r.amount >= ONE_OFF_THRESHOLD)
    .map(r => dayNumber(r.date)).filter(d => d != null);
  return (rows || []).map(r => {
    if (!(r.amount > 0)) return null;
    if (PREPAID_MATCH.test(r.description || "")) return "prepaid";
    if (ASSET_CATEGORIES.has(r.category) && r.amount >= ONE_OFF_THRESHOLD) return "asset";
    if (r.category === "Travel") {
      const d = dayNumber(r.date);
      if (d != null && anchors.some(a => Math.abs(a - d) <= TRAVEL_CLUSTER_DAYS)) return "exceptional";
    }
    return null;
  });
}

// Months a flagged row is spread over: 0 for exceptional or unflagged.
function spreadLife(tx) {
  const t = tx && SPEND_TYPES[tx.spendType];
  if (!t || !t.life) return 0;
  const life = Math.round(Number(tx.life));
  return life > 0 ? life : t.life;
}

// The part of `amount`, bought in `fromMonth` and spread over `life` months,
// that falls in `month`. The purchase month takes the first share.
function monthShare(amount, life, fromMonth, month) {
  const a = monthNumber(fromMonth), b = monthNumber(month);
  if (!life || a == null || b == null) return 0;
  const k = b - a;
  return k >= 0 && k < life ? amount / life : 0;
}

const api = { CATEGORY_ALIASES, OPEX_MATCH_RULES, canonCategory, merchantKey, buildCategoryHistory, classifyOpex, resolveCategory, canonCategoryTotals,
  ONE_OFF_THRESHOLD, SPEND_TYPES, suggestSpendTypes, spreadLife, monthShare, dayNumber, monthNumber };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitCategorise = api;
})(typeof self !== "undefined" ? self : this);

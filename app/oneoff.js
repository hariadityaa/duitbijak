// One-off spend: flags, spreading and core op-ex.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== one-off spend ==============================
   Rows flagged asset, prepaid or exceptional (see categorise.js). Saved month
   totals stay cash. Core op-ex is worked out here: a flagged row leaves its
   month, and a prepaid row comes back as an even share in each
   month it's spread over. Total Out stays cash. */
const SPEND_TYPES = DuitCategorise.SPEND_TYPES;
const FLAG_GROUPS = { asset: "Assets", prepaid: "Prepaid", exceptional: "Exceptional" };
function spendFlags(t) {
  const out = {};
  const type = DuitCategorise.canonSpendType(t.spendType);
  if (SPEND_TYPES[type]) { out.spendType = type; if (Number(t.life) > 0) out.life = Number(t.life); }
  if (t.suggestDismissed) out.suggestDismissed = true;
  return out;
}
// What a saved row adds to its month's op-ex, mirroring buildMonths; null if it isn't op-ex.
function opexRowAmount(tx, cat) {
  const rules = currentRules();
  if (cat === "Credit Card Payment" || rules.isOneOff(cat)) return null;
  const row = { description: tx.description, type: tx.withdrawal != null ? "DR" : "CR" };
  if (isCardAccount(tx.account)) return DuitRules.routeCardTx(row, rules).kind === "skip" ? null : (tx.withdrawal != null ? tx.withdrawal : -(tx.deposit || 0));
  if (isBankAccount(tx.account) && DuitRules.routeBankTx(row, rules).kind === "spend") return tx.withdrawal;
  return null;
}
const txKey = (month, idx) => `${month}|${idx}`;
// Spend rows take a category; transfers, card bills, fixed bills and income don't.
function canRecategorise(tx) {
  const rules = currentRules();
  const row = { description: tx.description, type: tx.withdrawal != null ? "DR" : "CR" };
  if (isCardAccount(tx.account)) return DuitRules.routeCardTx(row, rules).kind !== "skip";
  return isBankAccount(tx.account) && DuitRules.routeBankTx(row, rules).kind === "spend";
}
// Every label a row can be given: the built-in ones plus the user's one-off categories.
function categoryOptions() {
  const skip = new Set(["Credit Card Payment", "Interest Income"]);
  const labels = [...DuitCategorise.OPEX_MATCH_RULES.map(r => r.cat), ...CATEGORY_FIELDS.map(f => f[1]), ...currentRules().rules.oneOffCategories, ...currentRules().rules.savingsCategories, ...DuitRules.BUILT_IN_ONE_OFF];
  return [...new Set(labels)].filter(l => !skip.has(l)).sort((a, b) => a.localeCompare(b));
}
// Rebuilt when the months or the rules are replaced.
let oneOffFor = null, oneOffRules = null, oneOff = null;
function oneOffModel() {
  if (oneOff && oneOffFor === appData.months && oneOffRules === appData.rules) return oneOff;
  const rows = [];
  appData.months.forEach(m => (m.transactions || []).forEach((tx, i) => {
    const cat = resolveCategory(tx), amount = opexRowAmount(tx, cat);
    if (amount != null) rows.push({ key: txKey(m.month, i), month: m.month, tx, date: tx.date, description: tx.description, category: cat, amount });
  }));
  const guesses = DuitCategorise.suggestSpendTypes(rows);
  const opexKeys = new Set(rows.map(r => r.key));
  const catKeys = new Set();
  appData.months.forEach(m => (m.transactions || []).forEach((tx, i) => { if (canRecategorise(tx)) catKeys.add(txKey(m.month, i)); }));
  const suggestions = new Map();
  rows.forEach((r, i) => { if (guesses[i] && !r.tx.spendType && !r.tx.suggestDismissed) suggestions.set(r.key, guesses[i]); });
  const flagged = rows.filter(r => SPEND_TYPES[r.tx.spendType]).map(r => ({ ...r, type: r.tx.spendType, life: DuitCategorise.spreadLife(r.tx) }));
  oneOffFor = appData.months; oneOffRules = appData.rules;
  oneOff = { rows, opexKeys, catKeys, suggestions, flagged, core: new Map() };
  return oneOff;
}
// A month's op-ex categories with flagged rows taken out and spread shares put back.
function coreCategories(m) {
  if (!m.cardSpendAvailable || !m.categories) return null;
  const model = oneOffModel();
  if (model.core.has(m.month)) return model.core.get(m.month);
  const out = { ...m.categories };
  const add = (cat, v) => { out[cat] = round2((out[cat] || 0) + v); };
  model.flagged.forEach(r => {
    if (r.month === m.month) add(r.category, -r.amount);
    const share = DuitCategorise.monthShare(r.amount, r.life, r.month, m.month);
    if (share) add(r.category, share);
  });
  model.core.set(m.month, out);
  return out;
}
const coreAdjustment = m => { const core = coreCategories(m); return core ? Object.entries(core).reduce((s, [k, v]) => s + v - (m.categories[k] || 0), 0) : 0; };
// Flagged rows' cash in a month, grouped by type, for the Other bucket.
function flaggedCategories(m) {
  const out = {};
  oneOffModel().flagged.forEach(r => { if (r.month === m.month) out[FLAG_GROUPS[r.type]] = round2((out[FLAG_GROUPS[r.type]] || 0) + r.amount); });
  return out;
}
// The tag or suggestion shown on an op-ex row, and its editor when open.
function spendControls(key, tx) {
  const model = oneOffModel();
  if (!model.catKeys.has(key)) return { tag: "", editor: "" };
  const cat = resolveCategory(tx), opts = categoryOptions();
  if (!opts.includes(cat) && cat !== "Uncategorized") opts.push(cat);
  const catEditor = `<label class="spend-cat">Category <select class="tx-category" data-key="${esc(key)}">
      <option value="" ${tx.category ? "" : "selected"}>${tx.category ? "Auto" : `Auto: ${esc(cat)}`}</option>
      ${opts.map(o => `<option value="${esc(o)}" ${tx.category && cat === o ? "selected" : ""}>${esc(o)}</option>`).join("")}
    </select></label>`;
  if (!model.opexKeys.has(key)) return { tag: "", editor: ui.editTx === key ? `<div class="spend-editor">${catEditor}</div>` : "" };
  const t = SPEND_TYPES[tx.spendType], life = DuitCategorise.spreadLife(tx);
  const suggested = !t && model.suggestions.get(key);
  const tag = t ? `<button class="flag-tag" data-action="edit-spend" data-key="${esc(key)}">${esc(t.label)}${life ? ` &middot; ${life} mo` : ""}</button>`
    : suggested ? `<span class="suggest">One-off? ${esc(SPEND_TYPES[suggested].label)}
        <button class="link-btn" data-action="confirm-spend" data-key="${esc(key)}" data-type="${suggested}">Confirm</button>
        <button class="link-btn" data-action="dismiss-spend" data-key="${esc(key)}" aria-label="Dismiss suggestion">&times;</button></span>`
    : "";
  if (ui.editTx !== key) return { tag, editor: "" };
  const opt = (type, label) => `<button class="btn small ${(tx.spendType || "") === type ? "on" : ""}" data-action="set-spend" data-key="${esc(key)}" data-type="${type}">${label}</button>`;
  const editor = `<div class="spend-editor">
    ${catEditor}
    <div class="toggle-row">${opt("", "Normal")}${Object.keys(SPEND_TYPES).map(k => opt(k, SPEND_TYPES[k].label)).join("")}</div>
    ${life ? `<label class="spend-life">Spread over <input type="number" inputmode="numeric" min="1" max="600" id="spend-life" data-key="${esc(key)}" value="${life}"> months</label>` : ""}
  </div>`;
  return { tag, editor };
}
// patch fields set to null are removed from the row.
function saveSpend(key, patch) {
  const sep = key.lastIndexOf("|"), month = key.slice(0, sep), idx = Number(key.slice(sep + 1));
  const m = appData.months.find(x => x.month === month);
  if (!m || !m.transactions || !m.transactions[idx]) return;
  const tx = { ...m.transactions[idx], ...patch };
  ["spendType", "life", "suggestDismissed"].forEach(f => { if (tx[f] == null) delete tx[f]; });
  const transactions = m.transactions.slice();
  transactions[idx] = tx;
  persistMonths([{ ...m, transactions }]).then(() => render()).catch(err => { ui.syncError = "Couldn't save that: " + err.message; render(); });
}
// A saved label also teaches the guess for the same merchant's unlabelled rows
// (categorise.js history), so every month is rebuilt.
function saveCategory(key, category) {
  const sep = key.lastIndexOf("|"), month = key.slice(0, sep), idx = Number(key.slice(sep + 1));
  const m = appData.months.find(x => x.month === month);
  if (!m || !m.transactions || !m.transactions[idx]) return;
  const transactions = m.transactions.slice();
  const tx = { ...transactions[idx], category: category || null };
  transactions[idx] = tx;
  const prev = appData.months;
  appData.months = prev.map(x => x === m ? { ...m, transactions } : x);
  const merchant = DuitCategorise.merchantKey(tx.description);
  const follow = merchant ? appData.months.reduce((n, x) => n + (x.transactions || []).filter(t => t !== tx && !t.category && DuitCategorise.merchantKey(t.description) === merchant).length, 0) : 0;
  const rebuilt = rebuildMonths();
  persistMonths(rebuilt).then(() => {
    ui.editTx = null;
    showToast(category && follow ? `Saved. ${follow} other row${follow !== 1 ? "s" : ""} from this merchant follow it.` : "Saved.");
    render();
  }).catch(err => { appData.months = prev; ui.syncError = "Couldn't save that: " + err.message; render(); });
}
function ccpAdjustment(m) { const v = m.cardSpendAvailable && m.categories ? m.categories["Credit Card Payment"] : 0; return v ? -v : 0; }
// Reimbursements are stored as a negative one-off; this is the positive amount paid back.
function reimbursementAmount(m) { return -((m.otherCategories && m.otherCategories["Reimbursement"]) || 0); }
// Core op-ex: one-offs out, spread shares in, and what friends paid back out.
function opexAmount(m) { return m.cardSpendAvailable ? round2((m.cardSpend || 0) + ccpAdjustment(m) + coreAdjustment(m) - reimbursementAmount(m)) : null; }
function totalOutAdjusted(m) { return round2((m.totalOut || 0) + ccpAdjustment(m)); }
/* Total out, taken apart so the parts add up to it. Core op-ex isn't cash:
   it carries spread shares of earlier buys and leaves flagged rows out, so
   the bridge takes the shares off and puts the one-offs back. Whole dollars,
   with the spread as the remainder, so the shown figures sum exactly. */
function outBreakdown(months) {
  const flagged = oneOffModel().flagged;
  let core = 0, noCard = 0, oneOffs = 0, ruleOneOffs = 0, fixed = 0, saved = 0, total = 0, confirmedMonths = 0;
  months.forEach(m => {
    const out = totalOutAdjusted(m), saving = savingsAmount(m);
    const paid = flagged.filter(r => r.month === m.month).reduce((s, r) => s + r.amount, 0);
    total += out; fixed += m.giroOut || 0; saved += saving; ruleOneOffs += (m.otherOut || 0) - saving + reimbursementAmount(m); oneOffs += paid;
    if (m.cardSpendAvailable) { core += opexAmount(m); confirmedMonths++; }
    else noCard += out - (m.giroOut || 0) - (m.otherOut || 0) - paid;
  });
  const r = Math.round;
  const parts = { core: r(core), noCard: r(noCard), oneOffs: r(oneOffs), ruleOneOffs: r(ruleOneOffs), fixed: r(fixed), saved: r(saved), total: r(total), confirmedMonths };
  parts.spread = parts.core + parts.noCard + parts.oneOffs + parts.ruleOneOffs + parts.fixed + parts.saved - parts.total;
  parts.spend = parts.core - parts.spread + parts.noCard;
  return parts;
}

// Senders whose PayNow credits look like friends paying you back, for review.
let reimbFor = null, reimbRules = null, reimbList = [];
function reimbSuggestions() {
  if (reimbFor !== appData.months || reimbRules !== appData.rules) {
    reimbFor = appData.months; reimbRules = appData.rules;
    reimbList = DuitRules.suggestReimbursers(appData.months.flatMap(m => m.transactions || []), appData.rules, { isBank: isBankAccount });
  }
  return reimbList;
}

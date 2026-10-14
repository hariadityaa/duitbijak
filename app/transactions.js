// Transactions tab.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== transactions tab ============================== */
// "12 Sep 2026" -> 20260812 for sorting; Date parsing of this format varies by browser.
function dateKey(d) {
  const [day, mon, year] = String(d || "").trim().split(/\s+/);
  return Number(year) * 10000 + MONTH_ORDER.indexOf(mon) * 100 + Number(day) || 0;
}
const TX_PAGE = 100;
function renderTxns() {
  const f = ui.txFilter;
  const chip = (field, text) => `<button class="chip on" data-action="tx-unfilter" data-field="${field}" aria-label="Remove filter: ${esc(text)}">${esc(text)}${ICON(ICONS.close, 14)}</button>`;
  return `
  ${f ? `<div class="tx-filters">${f.label ? chip("label", f.label) : ""}${f.month ? chip("month", f.month) : ""}</div>` : ""}
  <input type="search" class="tx-search" id="tx-search" placeholder="Search description, category, account" value="${esc(ui.txQuery || "")}" autocomplete="off" aria-label="Search transactions">
  <div id="tx-list">${renderTxList()}</div>`;
}
function renderTxList() {
  const q = (ui.txQuery || "").trim().toLowerCase(), f = ui.txFilter;
  const months = periodMonths().filtered.filter(m => !f || !f.month || m.month === f.month);
  // A label filter keeps the rows its drill-down sheet listed, so fixed bills and flagged groups match too.
  const keys = f && f.label ? new Set(lineItems(months, f.bucket, f.label).map(r => r.key)) : null;
  const all = months.flatMap(m => (m.transactions || []).map((tx, i) => ({ ...tx, cat: resolveCategory(tx), key: txKey(m.month, i) })))
    .filter(tx => !keys || keys.has(tx.key))
    .filter(tx => !(ui.hideIncome && tx.deposit != null && currentRules().isSalary(tx.description)))
    .filter(tx => !q || [tx.description, tx.cat, accountLabel(tx.account)].some(v => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => dateKey(b.date) - dateKey(a.date));
  if (!all.length) return `<div style="font-size:14px;color:var(--text-2);padding:16px 0;">${q || f ? "No transactions match." : "No line items in this period. Months entered by hand have totals only."}</div>`;
  const out = all.reduce((s, t) => s + (t.withdrawal || 0), 0), inn = all.reduce((s, t) => s + (t.deposit || 0), 0);
  const shown = all.slice(0, ui.txLimit || TX_PAGE);
  let day = null;
  const rows = shown.map(tx => {
    const head = tx.date !== day ? `<div class="tx-day">${esc(tx.date)}</div>` : "";
    day = tx.date;
    const isIn = tx.deposit != null;
    const c = spendControls(tx.key, tx);
    const editable = oneOffModel().catKeys.has(tx.key);
    return `${head}<div class="tx-row">
      <div class="tx-main" ${editable ? `data-action="edit-spend" data-key="${esc(tx.key)}"` : ""}><div class="tx-desc">${esc(tx.description)}</div><div class="tx-meta">${esc(tx.cat)} &middot; ${esc(accountLabel(tx.account))}</div>${c.tag ? `<div class="tx-flags">${c.tag}</div>` : ""}</div>
      <span class="tx-amt ${isIn ? "in" : ""}">${isIn ? "+" : ""}${esc(fmt(isIn ? tx.deposit : tx.withdrawal))}</span>
    </div>${c.editor}`;
  }).join("");
  return `<div class="tx-summary">${all.length} transaction${all.length !== 1 ? "s" : ""} &middot; out ${esc(fmt(out))}${ui.hideIncome ? "" : ` &middot; in ${esc(fmt(inn))}`}</div>
  ${rows}
  ${all.length > shown.length ? `<div class="btn-row" style="justify-content:center;"><button class="btn" data-action="tx-more">Show ${Math.min(TX_PAGE, all.length - shown.length)} more</button></div>` : ""}`;
}

// Drill-down sheets, add month, total out and one-off review.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== drill-down sheets ==============================
   Tapping a month or a category opens a sheet over the page. Sheets stack two
   deep (a month, then a category in it). Each level is a history entry, so the
   phone's back button closes the top sheet instead of leaving the app. */
const DRILL_MAX = 2;
const BUCKET_LABEL = { opex: "Op-ex", other: "Other" };
const CHEV = `<span class="chev">${ICON(ICONS.chevron, 16)}</span>`;
const periodLabel = months => months.length > 1 ? `${months[0].month} – ${months[months.length - 1].month}` : months[0].month;
const shortMonth = month => month.split(" ")[0];
// $950, $1.2k, $12k: fits under a narrow bar.
const fmtShort = n => Math.abs(n) < 1000 ? fmt(n) : `${n < 0 ? "-" : ""}$${(Math.abs(n) / 1000).toFixed(Math.abs(n) < 10000 ? 1 : 0)}k`;
function drillAttrs(action, d) {
  return `role="button" tabindex="0" data-action="${action}" data-bucket="${d.bucket}"${d.month ? ` data-month="${esc(d.month)}"` : ""}${d.cat ? ` data-cat="${esc(d.cat)}"` : ""}`;
}
function openDrill(entry) {
  if (ui.drill.length >= DRILL_MAX) ui.drill[ui.drill.length - 1] = entry;
  else { ui.drill.push(entry); try { history.pushState({ drill: ui.drill.length }, ""); } catch (e) {} }
  ui.editTx = null;
  render();
}
// Trims the stack now; the history entries go too, and popstate then finds nothing to do.
function closeDrill(levels) {
  const n = Math.min(levels, ui.drill.length);
  if (!n) return;
  ui.drill = ui.drill.slice(0, ui.drill.length - n);
  ui.editTx = null;
  try { history.go(-n); } catch (e) {}
}
// A month's bucket as [label, amount, tag] rows, largest first. Card bill payments are never spend.
function bucketEntries(m, bucket) {
  const merged = {}, tags = {};
  bucketSources(m, bucket).forEach(({ src, tag }) => {
    if (src) Object.entries(src).forEach(([k, v]) => { if (k === "Credit Card Payment" || !v) return; merged[k] = (merged[k] || 0) + v; if (tag) tags[k] = tag; });
  });
  return Object.entries(merged).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, tags[k] || null]);
}
// The saved rows behind one label in a bucket, routed the way buildMonths and
// the one-off model total them. Op-ex rows show cash, so flagged rows still appear.
function lineItems(months, bucket, label) {
  if (bucket === "opex") return opexLineItems(months, label);
  const inMonths = new Set(months.map(m => m.month));
  const group = Object.keys(FLAG_GROUPS).find(t => FLAG_GROUPS[t] === label);
  if (group) return oneOffModel().flagged.filter(r => r.type === group && inMonths.has(r.month)).map(r => ({ ...r.tx, amount: r.amount, month: r.month, key: r.key }));
  const rules = currentRules(), rows = [];
  months.forEach(m => (m.transactions || []).forEach((tx, i) => {
    const row = { description: tx.description, type: tx.withdrawal != null ? "DR" : "CR" };
    const isLabel = () => rules.isOneOff(label) && resolveCategory(tx) === label;
    let hit = false;
    if (isBankAccount(tx.account)) { const r = DuitRules.routeBankTx(row, rules); hit = r.kind === "fixed" ? r.name === label : r.kind === "spend" && isLabel(); }
    else if (isCardAccount(tx.account)) hit = DuitRules.routeCardTx(row, rules).kind === "spend" && isLabel();
    const amount = tx.withdrawal != null ? tx.withdrawal : -(tx.deposit || 0);
    if (hit && amount) rows.push({ ...tx, amount, month: m.month, guessed: !tx.category, key: txKey(m.month, i) });
  }));
  return rows;
}
// "▲ $120 (+8%) vs Aug", or null when there's nothing to compare with.
// More spend reads red; tone "save" turns that round, "neutral" leaves it uncoloured.
function deltaHtml(cur, prev, label, tone) {
  if (prev == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 0.5) return `Same as ${esc(label)}`;
  const p = pct(cur, prev);
  const cls = tone === "neutral" ? "" : (d > 0) === (tone === "save") ? "down" : "up";
  return `<span class="${cls}">${d > 0 ? "▲" : "▼"} ${esc(fmt(Math.abs(d)))}</span>${p != null ? ` (${d > 0 ? "+" : ""}${p}%)` : ""} vs ${esc(label)}`;
}
// Opens Transactions searched for the merchant, in the month when there is one.
const merchantRow = (name, amt, month) => `<div class="item-row clickable" role="button" tabindex="0" data-action="tx-search" data-q="${esc(name)}"${month ? ` data-month="${esc(month)}"` : ""}><span class="item-desc">${esc(name)}</span><span class="item-amt">${esc(fmt(amt))}</span>${CHEV}</div>`;
function itemRow(tx, dateText) {
  const c = spendControls(tx.key, tx);
  return `<div class="item-row"><span class="item-date">${esc(dateText)}</span><span class="item-desc" data-action="edit-spend" data-key="${esc(tx.key)}">${tx.guessed ? '<span class="guess">~ </span>' : ""}${esc(tx.description)}</span><span class="item-amt" style="color:${tx.amount < 0 ? "var(--success)" : "var(--text)"}">${tx.amount < 0 ? "−" : ""}${esc(fmt(Math.abs(tx.amount)))}</span></div>${c.tag ? `<div class="item-flags">${c.tag}</div>` : ""}${c.editor}`;
}

function renderMonthDrill(d) {
  const i = appData.months.findIndex(x => x.month === d.month), m = appData.months[i];
  if (!m) return `<p class="paste-help">That month is no longer in the ledger.</p>`;
  const prev = i > 0 ? appData.months[i - 1] : null;
  const counts = x => !(d.bucket === "opex" && !x.cardSpendAvailable);
  const entries = bucketEntries(m, d.bucket);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const prevMap = prev && counts(prev) ? Object.fromEntries(bucketEntries(prev, d.bucket).map(([k, v]) => [k, v])) : null;
  const prevTotal = prevMap ? Object.values(prevMap).reduce((s, v) => s + v, 0) : null;
  const missing = d.bucket === "opex" ? missingCards(m) : [];
  const sub = !counts(m) ? "No card statement yet"
    : [deltaHtml(total, prevTotal, prev && shortMonth(prev.month), d.bucket === "other" ? "neutral" : "spend"), missing.length ? `partial: no ${esc(missing.map(sourceLabel).join(", "))} yet` : null].filter(Boolean).join(" &middot; ");
  // Savings can back out salary, so it hides with income, as the Savings / mo card does.
  const stats = [["Core op-ex", m.cardSpendAvailable ? fmt(opexAmount(m)) : "Pending"], ["Total out", fmt(totalOutAdjusted(m))]];
  if (!ui.hideIncome) stats.push(["Fixed bills", fmt(m.giroOut)], ["Savings", fmt(savingsAmount(m))], ["In", fmt(m.totalIn)], ["In less out", fmt(m.totalIn - totalOutAdjusted(m))]);
  const max = entries.reduce((s, [, v]) => Math.max(s, v), 0);
  const rows = entries.map(([cat, v, tag]) => {
    const dl = prevMap ? v - (prevMap[cat] || 0) : null;
    return `<div class="row2 clickable" ${drillAttrs("drill-cat", { cat, bucket: d.bucket, month: m.month })}>
      <div class="row2-top"><span class="row2-name">${esc(cat)}${tag ? `<span class="tag">${esc(tag)}</span>` : ""}</span><span class="row2-amt">${esc(fmt(v))}</span>${CHEV}</div>
      <div class="row2-bottom"><div class="row2-bar"><div class="row2-bar-fill" style="width:${max > 0 ? Math.max(0, v / max * 100).toFixed(0) : 0}%;background:var(--text-2)"></div></div>
      ${dl == null ? "" : Math.abs(dl) > 0.5 ? `<span class="row2-delta ${dl > 0 ? "up" : "down"}${tag === "Savings" ? " save" : ""}">${dl > 0 ? "▲" : "▼"} ${esc(fmt(Math.abs(dl)))}</span>` : `<span class="row2-delta flat">—</span>`}</div>
    </div>`;
  }).join("");
  const merchants = d.bucket === "opex" && m.cardSpendAvailable ? (m.topMerchants || []).slice(0, 5) : [];
  return `
  <div class="drill-head">
    <div class="drill-total">${counts(m) ? esc(fmt(total)) : "Pending"}</div>
    ${sub ? `<div class="drill-sub">${sub}</div>` : ""}
  </div>
  <div class="drill-stats">${stats.map(([k, v]) => `<div class="drill-stat"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}</div>
  <div class="drill-section">By category${prevMap ? ` &middot; change vs ${esc(shortMonth(prev.month))}` : ""}</div>
  ${rows || `<p class="paste-help">Nothing in this view for ${esc(m.month)}.</p>`}
  ${merchants.length ? `<div class="drill-section">Top card merchants</div>
    ${merchants.map(x => merchantRow(x.name, x.amt, m.month)).join("")}` : ""}
  <div class="btn-row drill-more"><button class="btn" data-action="drill-to-txns">See ${esc(m.month)} in Transactions</button></div>`;
}

const DRILL_ITEM_LIMIT = 100;
function renderCatDrill(d) {
  const { filtered } = periodMonths();
  const counts = m => !(d.bucket === "opex" && !m.cardSpendAvailable);
  const valueIn = m => (bucketEntries(m, d.bucket).find(([k]) => k === d.cat) || [null, 0])[1];
  const scope = d.month ? appData.months.filter(m => m.month === d.month) : filtered;
  const total = scope.reduce((s, m) => s + (counts(m) ? valueIn(m) : 0), 0);
  // Op-ex averages divide by confirmed months only, as on the overview.
  const avgMonths = d.bucket === "opex" ? filtered.filter(isConfirmed) : filtered;
  const avg = avgMonths.length ? avgMonths.reduce((s, m) => s + valueIn(m), 0) / avgMonths.length : null;
  const sub = d.month ? (avg != null && avgMonths.length > 1 ? deltaHtml(total, avg, "period average", d.bucket === "other" && currentRules().isSavings(d.cat) ? "save" : "spend") : null)
    : [avg != null && avgMonths.length > 1 ? `${esc(fmt(avg))}/mo average` : null, `${filtered.length} month${filtered.length !== 1 ? "s" : ""}`].filter(Boolean).join(" &middot; ");

  const vals = filtered.map(m => ({ month: m.month, v: counts(m) ? valueIn(m) : null }));
  const max = Math.max(1, ...vals.map(x => x.v || 0));
  const trend = filtered.length > 1 ? `<div class="drill-trend" role="group" aria-label="Pick a month">${vals.map(x => `<button class="tb ${d.month === x.month ? "on" : ""}" data-action="drill-pick-month" data-month="${esc(x.month)}" aria-pressed="${d.month === x.month}" title="${esc(x.month)}: ${x.v == null ? "no card statement" : esc(fmt(x.v))}" ${x.v == null ? "disabled" : ""}>${x.v ? `<b>${esc(fmtShort(x.v))}</b>` : ""}<i style="height:${x.v ? Math.max(2, Math.round(x.v / max * 56)) : 2}px"></i>${esc(shortMonth(x.month))}</button>`).join("")}</div>
    <p class="paste-help" style="margin:0 0 8px;">${d.month ? "Tap the month again to see the whole period." : "Tap a month to see only its rows."}</p>` : "";

  const items = lineItems(scope, d.bucket, d.cat);
  const byMerchant = {};
  items.forEach(tx => { const k = tx.description || "Unknown"; byMerchant[k] = (byMerchant[k] || 0) + tx.amount; });
  const merchants = Object.entries(byMerchant).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sorted = ui.drillSort === "amount" ? items.slice().sort((a, b) => b.amount - a.amount) : items.slice().sort((a, b) => dateKey(b.date) - dateKey(a.date));
  const shown = sorted.slice(0, DRILL_ITEM_LIMIT);
  let list = "";
  const dayMonth = tx => tx.date.split(" ").slice(0, 2).join(" ");
  if (ui.drillSort === "amount") list = shown.map(tx => itemRow(tx, dayMonth(tx))).join("");
  else {
    const monthTotals = {};
    items.forEach(tx => { monthTotals[tx.month] = (monthTotals[tx.month] || 0) + tx.amount; });
    let cur = null;
    list = shown.map(tx => {
      const head = tx.month !== cur ? `<div class="drill-month"><span>${esc(tx.month)}</span><span>${esc(fmt(monthTotals[tx.month]))}</span></div>` : "";
      cur = tx.month;
      return head + itemRow(tx, dayMonth(tx));
    }).join("");
  }
  const sortBtn = (k, label) => `<button class="btn small ${ui.drillSort === k ? "on" : ""}" data-action="drill-sort" data-sort="${k}">${label}</button>`;
  return `
  <div class="drill-head">
    <div class="drill-total">${esc(fmt(total))}</div>
    ${sub ? `<div class="drill-sub">${sub}</div>` : ""}
  </div>
  ${trend}
  ${merchants.length > 1 ? `<div class="drill-section">Top merchants</div>
    ${merchants.map(([name, v]) => merchantRow(name, v, d.month)).join("")}` : ""}
  <div class="drill-section">${items.length} transaction${items.length !== 1 ? "s" : ""}${items.length > shown.length ? ` &middot; showing ${shown.length}` : ""}</div>
  ${items.length ? `<div class="toggle-row" style="margin:8px 0;">${sortBtn("date", "Newest")}${sortBtn("amount", "Largest")}</div>` : ""}
  ${shown.some(tx => tx.guessed) ? `<p class="paste-help" style="margin:0 0 8px;">Rows marked ~ are categorised from the description, not a saved label.</p>` : ""}
  ${d.bucket === "opex" && shown.some(tx => tx.spendType) ? `<p class="paste-help" style="margin:0 0 8px;">Flagged rows show what was paid. Core op-ex leaves asset and exceptional rows out and spreads prepaid rows over their months, so the rows may not add up to the total.</p>` : ""}
  <div class="items drill-list">${list || `<p class="paste-help">No line items. Months entered by hand have totals only.</p>`}</div>
  ${items.length ? `<div class="btn-row drill-more"><button class="btn" data-action="drill-to-txns">See all in Transactions</button></div>` : ""}`;
}

/* ============================== add month tab ============================== */
function renderAddMonth() {
  const catFields = CATEGORY_FIELDS.map(([key, label]) => `
    <div class="field"><label>${esc(label)}</label><input type="number" inputmode="decimal" id="f-${key}" placeholder="0"></div>`).join("");
  return `
  <div class="card">
    <p class="card-title">Add a month by hand</p>
    <p style="font-size:14px;line-height:1.65;margin:0 0 14px;color:var(--text-2);">Use this for a month you don't have a full statement paste for yet — a manual override. Fields left blank count as $0.</p>
    <div class="form-grid cols2">
      <div class="field"><label>Month (e.g. Jun 2026)</label><input type="text" id="f-month" placeholder="Jun 2026"></div>
      <div class="field"><label>Card statement available?</label>
        <select id="f-cardAvailable"><option value="yes">Yes</option><option value="no">No</option></select></div>
      <div class="field"><label>Salary in</label><input type="number" inputmode="decimal" id="f-salaryIn" placeholder="0"></div>
      <div class="field"><label>Other income</label><input type="number" inputmode="decimal" id="f-otherIn" placeholder="0"></div>
      <div class="field"><label>Total card spend</label><input type="number" inputmode="decimal" id="f-cardSpend" placeholder="0"></div>
      <div class="field"><label>Fixed bills out</label><input type="number" inputmode="decimal" id="f-giroOut" placeholder="0"></div>
      <div class="field"><label>Other one-off out</label><input type="number" inputmode="decimal" id="f-otherOut" placeholder="0"></div>
    </div>
    <div class="section-label">Card category breakdown</div>
    <div class="form-grid cols2">${catFields}</div>
    <div class="btn-row"><button class="btn primary" data-action="save-month">Save month</button></div>
  </div>`;
}

/* ============================== total out ============================== */
// Fixed bills are spend and savings aren't, so they always show apart. The
// savings rate would back out salary, so it shows only with income visible.
function outSplit(b, savingsRate) {
  const showRate = !ui.hideIncome && savingsRate != null && b.saved;
  const parts = [["Spend", b.spend], ["One-offs", b.oneOffs + b.ruleOneOffs], ["Fixed", b.fixed],
    ["Saved", b.saved, showRate ? ` (${savingsRate}% of money in)` : ""]];
  return parts.filter(([, v]) => v).map(([k, v, note]) => `${k} ${fmt(v)}${note || ""}`).join(" · ");
}
// From core op-ex to Total out, one step a row.
function renderOutSheet() {
  const { filtered } = periodMonths(), b = outBreakdown(filtered);
  const inPeriod = new Set(filtered.map(m => m.month)), flagged = oneOffModel().flagged.filter(r => inPeriod.has(r.month));
  const byType = Object.keys(FLAG_GROUPS).map(t => [SPEND_TYPES[t].label, flagged.filter(r => r.type === t).reduce((s, r) => s + r.amount, 0)]).filter(([, v]) => v).map(([t, v]) => `${t} ${fmt(v)}`).join(" · ");
  const signed = v => v < 0 ? `−${fmt(-v)}` : `+${fmt(v)}`;
  const rows = [
    ["Core op-ex", `${b.confirmedMonths} month${b.confirmedMonths !== 1 ? "s" : ""} with card statements`, fmt(b.core)],
    ["Spread shares", "Prepaid fees counted in op-ex, paid in their own month", signed(-b.spread)],
    ["Spend, no card statement", "Bank spend in months still waiting on cards", signed(b.noCard)],
    ["One-offs paid", byType || "Flagged rows, at what was paid", signed(b.oneOffs)],
    ["Other one-offs", "Your one-off categories", signed(b.ruleOneOffs)],
    ["Fixed bills", "", signed(b.fixed)],
    ["Savings", "", signed(b.saved)],
  ].filter(([k, , v], i) => i === 0 || v !== "+$0");
  return `<p class="paste-help">Core op-ex is the running cost of living, not cash. Total out is every dollar that left. This is the bridge for ${esc(periodLabel(filtered))}.</p>
  ${rows.map(([k, note, v]) => `<div class="item-row"><span class="item-desc">${esc(k)}${note ? `<small class="out-note">${esc(note)}</small>` : ""}</span><span class="item-amt">${esc(v)}</span></div>`).join("")}
  <div class="item-row out-total"><span class="item-desc">Total out</span><span class="item-amt">${esc(fmt(b.total))}</span></div>
  <div class="btn-row drill-more"><button class="btn" data-action="show-txns">See transactions</button></div>`;
}
/* ============================== one-off review ============================== */
// Only the suggested rows in the period, newest first. Confirmed or
// dismissed rows drop off the list as they're saved.
function renderReview() {
  const model = oneOffModel();
  const inPeriod = new Set(periodMonths().filtered.map(m => m.month));
  const rows = model.rows.filter(r => inPeriod.has(r.month) && model.suggestions.has(r.key)).sort((a, b) => dateKey(b.date) - dateKey(a.date));
  if (!rows.length) return `<p class="paste-help" style="margin:0;">Nothing left to review in this period.</p>`;
  return `<p class="paste-help">Confirm to take a row out of core op-ex. Prepaid rows are spread over their months. Tap a row to pick another type.</p>
  ${rows.map(r => { const c = spendControls(r.key, r.tx); return `<div class="item-row"><span class="item-date">${esc(r.date)}</span><span class="item-desc" data-action="edit-spend" data-key="${esc(r.key)}">${esc(r.description)}</span><span class="item-amt">${esc(fmt(r.amount))}</span></div><div class="item-flags">${c.tag}</div>${c.editor}`; }).join("")}`;
}

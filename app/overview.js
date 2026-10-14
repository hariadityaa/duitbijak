// Overview and Detail tabs.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== overview tab ============================== */
function bucketSources(m, bucket) {
  if (bucket === "opex") return m.cardSpendAvailable && m.categories ? [{ src: coreCategories(m), tag: null }] : [];
  const { savings, oneOffs } = splitOther(m);
  return [{ src: m.giroCategories, tag: "Fixed" }, { src: oneOffs, tag: "One-off" }, { src: savings, tag: "Savings" }, { src: flaggedCategories(m), tag: "Flagged" }];
}
// A month's other-out labels, split into savings and true one-offs by the current rules.
function splitOther(m) {
  const rules = currentRules(), savings = {}, oneOffs = {};
  Object.entries(m.otherCategories || {}).forEach(([k, v]) => { (rules.isSavings(k) ? savings : oneOffs)[k] = v; });
  return { savings, oneOffs };
}
const savingsAmount = m => Object.values(splitOther(m).savings).reduce((s, v) => s + v, 0);
function renderOverview(filtered) {
  const bucket = ui.bucketOverview;
  const available = filtered.filter(m => m.cardSpendAvailable);
  const confirmed = filtered.filter(isConfirmed);
  const partialCard = partialMonths(filtered);
  const totalIn = filtered.reduce((s, m) => s + m.totalIn, 0);
  const totalOpex = confirmed.reduce((s, m) => s + opexAmount(m), 0);
  const netTotalOpex = confirmed.reduce((s, m) => s + netOpexAmount(m), 0);
  const totalOut = filtered.reduce((s, m) => s + totalOutAdjusted(m), 0);
  const latest = filtered[filtered.length - 1];
  const prev = filtered.length > 1 ? filtered[filtered.length - 2] : null;
  const avgOpex = confirmed.length ? Math.round(totalOpex / confirmed.length) : null;
  const netAvgOpex = confirmed.length ? Math.round(netTotalOpex / confirmed.length) : null;
  // Net Op-Ex equals Core Op-Ex until something is reimbursed, so it only shows then.
  const hasReimb = confirmed.some(m => reimbursementAmount(m));
  // The month card shows the latest confirmed month: the newest month is
  // usually still waiting on a card statement, and a partial total misleads.
  const shown = confirmed.length ? confirmed[confirmed.length - 1] : latest;
  const shownPrev = confirmed.length > 1 ? confirmed[confirmed.length - 2] : null;
  const delta = isConfirmed(shown) && shownPrev ? pct(opexAmount(shown), opexAmount(shownPrev)) : null;
  const tone = delta > 15 ? "warn" : delta < -15 ? "ok" : "";
  const shownMissing = missingCards(shown);
  const later = filtered.slice(filtered.indexOf(shown) + 1).map(m => m.month.split(" ")[0]);
  // The hero's sub-line: the latest confirmed month, its change, what's still to come.
  const latestSub = [`${esc(shortMonth(shown.month))} ${shown.cardSpendAvailable ? esc(fmt(opexAmount(shown))) : "pending"}`,
    !shown.cardSpendAvailable ? "no card stmt yet"
    : shownMissing.length ? `partial: no ${esc(shownMissing.map(sourceLabel).join(", "))} yet`
    : delta != null ? `<span class="${tone}">${delta > 0 ? "+" : ""}${delta}% vs ${esc(shortMonth(shownPrev.month))}</span>` : null,
    later.length ? `${esc(later.join(", "))} pending` : null].filter(Boolean).join(" &middot; ");
  const partial = filtered.filter(m => !m.cardSpendAvailable).map(m => m.month);
  const inPeriod = new Set(filtered.map(m => m.month));
  const model = oneOffModel();
  const pendingSuggestions = [...model.suggestions.keys()].filter(k => inPeriod.has(k.split("|")[0])).length;
  // Savings rate: savings over all money in for the period. Savings can be
  // funded by transfers from other banks, which a salary-only divisor misses.
  const totalSavings = filtered.reduce((s, m) => s + savingsAmount(m), 0);
  const savingsRate = totalIn > 0 ? Math.round(totalSavings / totalIn * 100) : null;

  // Op-Ex per-month figures divide by confirmed months only, so a partial
  // month (a card statement still missing) doesn't pull the averages down.
  const avgMonths = bucket === "opex" ? confirmed : filtered;
  const totals = {}; const tags = {}; const avgTotals = {};
  filtered.forEach(m => bucketSources(m, bucket).forEach(({ src, tag }) => {
    if (!src) return;
    Object.entries(src).forEach(([k, v]) => { if (k === "Credit Card Payment") return; if (v) { totals[k] = (totals[k] || 0) + v; if (tag) tags[k] = tag; } });
  }));
  avgMonths.forEach(m => bucketSources(m, bucket).forEach(({ src }) => {
    if (src) Object.entries(src).forEach(([k, v]) => { if (k !== "Credit Card Payment" && v) avgTotals[k] = (avgTotals[k] || 0) + v; });
  }));
  const cats = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const colorOf = colorMap(cats.map(([c]) => c));
  const bucketTotal = cats.reduce((s, [, v]) => s + v, 0);
  const maxCat = cats.reduce((m, [, v]) => Math.max(m, v), 0);
  const bucketMonths = avgMonths.length;
  const perMonth = v => bucketMonths ? v / bucketMonths : 0;
  const reimb = bucket === "opex" ? available.reduce((s, m) => s + reimbursementAmount(m), 0) : 0;
  const avgReimb = bucket === "opex" ? confirmed.reduce((s, m) => s + reimbursementAmount(m), 0) : 0;
  const netBucketTotal = bucketTotal - reimb;
  const avgBucketTotal = Object.values(avgTotals).reduce((s, v) => s + v, 0);
  const catValue = (m, cat) => bucketSources(m, bucket).reduce((s, { src }) => s + ((src || {})[cat] || 0), 0);
  const hasLatest = bucket === "opex" ? latest.cardSpendAvailable : true;
  const hasPrev = prev && (bucket === "opex" ? prev.cardSpendAvailable : true);

  const monthRows = filtered.map(m => {
    const entries = bucketEntries(m, bucket);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const isPartial = bucket === "opex" && !m.cardSpendAvailable;
    const missingCard = bucket === "opex" && partialCard.includes(m.month);
    return `<div class="month-row clickable" ${drillAttrs("drill-month", { month: m.month, bucket })}>
      <div class="month-head"><span class="month-label">${esc(m.month)}${missingCard ? '<span class="tag">partial</span>' : ""}</span><span class="month-total-wrap"><span class="month-total">${isPartial ? "—" : esc(fmt(total))}</span>${CHEV}</span></div>
      ${isPartial ? `<div class="stacked-bar empty"></div>` : stackedBar(entries, total, colorOf, cat => `data-action="drill-cat" data-bucket="${bucket}" data-month="${esc(m.month)}" data-cat="${esc(cat)}"`)}
    </div>`;
  }).join("");

  const catRows = cats.map(([cat, total]) => {
    const latestVal = hasLatest ? catValue(latest, cat) : null;
    const prevVal = hasPrev ? catValue(prev, cat) : null;
    const d = (latestVal != null && prevVal != null) ? latestVal - prevVal : null;
    const barPct = total > 0 && maxCat > 0 ? Math.min(100, total / maxCat * 100).toFixed(0) : "0";
    const deltaHtml = d != null && Math.abs(d) > 0.5
      ? `<span class="row2-delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${esc(fmt(Math.abs(d)))}</span>`
      : `<span class="row2-delta flat">—</span>`;
    return `<div class="row2 clickable" ${drillAttrs("drill-cat", { cat, bucket })}>
      <div class="row2-top">
        <span class="swatch" style="background:${colorOf(cat)}"></span>
        <span class="row2-name">${esc(cat)}${tags[cat] ? `<span class="tag">${esc(tags[cat])}</span>` : ""}</span>
        <span class="row2-amt">${esc(fmt(perMonth(avgTotals[cat] || 0)))}<small>/mo</small></span>${CHEV}
      </div>
      <div class="row2-bottom">
        <div class="row2-bar"><div class="row2-bar-fill" style="width:${barPct}%;background:${colorOf(cat)}"></div></div>
        <span class="row2-total">${esc(fmt(total))} tot</span>
        ${deltaHtml}
      </div>
    </div>`;
  }).join("");

  const reimbRow = (bucket === "opex" && reimb > 0) ? `
    <div class="row2">
      <div class="row2-top">
        <span class="swatch" style="background:var(--success)"></span>
        <span class="row2-name">Reimbursement<span class="tag">Offset</span></span>
        <span class="row2-amt" style="color:var(--success)">${esc(fmt(perMonth(-avgReimb)))}<small>/mo</small></span>
      </div>
      <div class="row2-bottom"><div class="row2-bar"></div><span class="row2-total">${esc(fmt(-reimb))} total</span></div>
    </div>
    <div class="row2" style="font-weight:600;">
      <div class="row2-top"><span class="row2-name" style="font-weight:600;">Net Op-Ex</span>
        <span class="row2-amt">${esc(fmt(perMonth(avgBucketTotal - avgReimb)))}<small>/mo</small></span></div>
      <div class="row2-bottom"><span class="row2-total">${esc(fmt(netBucketTotal))} total</span></div>
    </div>` : "";

  return `
  <div class="metrics">
    <div class="metric clickable" ${drillAttrs("drill-month", { month: shown.month, bucket: "opex" })}>
      <div class="metric-label">Core Op-Ex / mo${CHEV}</div>
      <div class="metric-value">${avgOpex != null ? esc(fmt(avgOpex)) : "—"}</div>
      <div class="metric-sub">${latestSub}</div>
      <div class="metric-sub">${confirmed.length} month${confirmed.length !== 1 ? "s" : ""} confirmed${partialCard.length ? ` &middot; ${esc(partialCard.map(mo => mo.split(" ")[0]).join(", "))} partial` : ""}${hasReimb && netAvgOpex != null ? ` &middot; net ${esc(fmt(netAvgOpex))} after reimbursements` : ""}</div>
    </div>
    <div class="metric clickable" role="button" tabindex="0" data-action="open-sheet" data-sheet="out"><div class="metric-label">Total out${CHEV}</div><div class="metric-value">${esc(fmt(totalOut))}</div><div class="metric-sub">${!ui.hideIncome ? `in ${esc(fmt(totalIn))}` : `${filtered.length} month${filtered.length !== 1 ? "s" : ""}`}${partial.length ? ` &middot; excl. ${esc(partial.join(", "))}` : ""}</div><div class="metric-sub">${esc(outSplit(outBreakdown(filtered), savingsRate))}</div>
      ${pendingSuggestions ? `<div class="metric-sub"><button class="link-btn" data-action="open-sheet" data-sheet="review">${pendingSuggestions} one-off${pendingSuggestions !== 1 ? "s" : ""} to review</button></div>` : ""}</div>
  </div>
  <div class="card">
    <p class="card-title">Monthly spend pattern</p>
    ${bucketToggle("bucketOverview", bucket)}
    ${partial.length && bucket === "opex" ? `<div style="font-size:14px;color:var(--text);margin-bottom:12px;">${esc(partial.join(", "))} excluded — no card statement yet.</div>` : ""}
    ${monthRows}
  </div>
  <div class="card">
    <p class="card-title">Spend by category &middot; ${esc(filtered[0].month)} – ${esc(latest.month)} (${bucketMonths} mo)</p>
    ${bucketToggle("bucketOverview", bucket)}
    ${cats.length === 0 ? `<div style="font-size:14px;color:var(--text-2);">No data available for this view.</div>` : catRows + reimbRow}
  </div>`;
}
function bucketToggle(stateKey, current) {
  return `<div class="toggle-row">
    <button class="btn small ${current === "opex" ? "on" : ""}" data-action="set-bucket" data-key="${stateKey}" data-value="opex">Operational expenses</button>
    <button class="btn small ${current === "other" ? "on" : ""}" data-action="set-bucket" data-key="${stateKey}" data-value="other">Other</button>
  </div>`;
}

/* ============================== deep dive tab ============================== */
function renderDeepDive(filtered) {
  // Categories live on Overview, where a row opens its sheet with the month trend.
  const merchMonths = filtered.filter(m => m.cardSpendAvailable && m.topMerchants && m.topMerchants.length);
  const merchAvgMonths = merchMonths.filter(isConfirmed);
  const merchTotals = {}; const merchAvgTotals = {};
  merchMonths.forEach(m => m.topMerchants.forEach(({ name, amt }) => { merchTotals[name] = (merchTotals[name] || 0) + amt; }));
  merchAvgMonths.forEach(m => m.topMerchants.forEach(({ name, amt }) => { merchAvgTotals[name] = (merchAvgTotals[name] || 0) + amt; }));
  const ranked = Object.entries(merchTotals).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const merchMax = ranked[0] ? ranked[0][1] : 1;
  const merchPeriod = merchMonths.length ? `${merchMonths[0].month} – ${merchMonths[merchMonths.length - 1].month}` : "—";
  const flaggedNames = new Set(oneOffModel().flagged.filter(r => merchMonths.some(m => m.month === r.month)).map(r => r.description));
  const merchRows = ranked.map(([name, total]) => `
    <div class="row2 clickable" role="button" tabindex="0" data-action="tx-search" data-q="${esc(name)}">
      <div class="row2-top"><span class="row2-name">${esc(name)}${flaggedNames.has(name) ? '<span class="tag">Flagged</span>' : ""}</span><span class="row2-amt">${esc(fmt(total))}</span>${CHEV}</div>
      <div class="row2-bottom"><div class="row2-bar"><div class="row2-bar-fill" style="width:${(total / merchMax * 100).toFixed(0)}%;background:var(--text)"></div></div>
      ${merchAvgMonths.length > 1 ? `<span class="row2-total">${esc(fmt(Math.round((merchAvgTotals[name] || 0) / merchAvgMonths.length)))}/mo</span>` : ""}</div>
    </div>`).join("");

  return `
  ${merchMonths.length ? `<div class="card"><p class="card-title">Top merchants &middot; ${esc(merchPeriod)} &middot; credit cards</p>
    <div style="font-size:14px;color:var(--text-2);margin-bottom:12px;">Credit cards only. Debit, NETS and PayNow aren't counted here.</div>
    ${merchRows}</div>` : ""}
  ${renderFixedCommitments()}`;
}
function renderFixedCommitments() {
  const fixed = appData.fixedCommitments || {};
  const entries = Object.entries(fixed).sort((a, b) => b[1] - a[1]);
  const totalFixed = entries.reduce((s, [, v]) => s + v, 0);
  const rows = entries.map(([k, v]) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px;">
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(k)}</span>
      <span style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <span class="num" style="font-weight:500;">${esc(fmt(v))}/mo</span>
        <button class="btn small ghost" data-action="delete-fixed" data-name="${esc(k)}" title="Remove">×</button>
      </span>
    </div>`).join("");
  return `
  <div class="card">
    <p class="card-title">Fixed monthly commitments</p>
    <p style="font-size:14px;color:var(--text-2);margin:0 0 12px;">Your own recurring bills (loan, insurance, subscriptions, etc.) — entered here and kept only in this browser.</p>
    ${entries.length ? rows : `<div style="font-size:14px;color:var(--text-2);padding:4px 0 12px;">Nothing added yet.</div>`}
    <div class="form-grid cols2" style="margin-top:10px;">
      <div class="field"><label>Name</label><input type="text" id="f-fixed-name" placeholder="e.g. Rent"></div>
      <div class="field"><label>Amount / mo</label><input type="number" inputmode="decimal" id="f-fixed-amount" placeholder="0"></div>
    </div>
    <div class="btn-row"><button class="btn small" data-action="add-fixed">+ Add commitment</button></div>
    ${entries.length ? `<div style="display:flex;justify-content:space-between;padding:12px;background:var(--surface-2);border-radius:8px;margin-top:10px;font-size:14px;">
      <span style="font-weight:500;">Total fixed monthly</span><span class="num" style="font-weight:600;color:var(--text);">${esc(fmt(totalFixed))}</span>
    </div>` : ""}
  </div>`;
}

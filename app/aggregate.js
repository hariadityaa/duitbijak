// Rows to months: classification and aggregation.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== aggregation ============================== */
function buildMonths(cleanRows) {
  const rules = currentRules();
  const byMonth = {};
  cleanRows.forEach(tx => {
    const month = monthKeyFromDate(tx.date);
    if (!month) return;
    (byMonth[month] = byMonth[month] || []).push(tx);
  });
  const months = {};
  Object.entries(byMonth).forEach(([month, txs]) => {
    const bankTxs = txs.filter(t => isBankAccount(t.account));
    const cardTxs = txs.filter(t => isCardAccount(t.account));
    let salaryIn = 0, otherIn = 0, giroOut = 0, otherOut = 0, cardSpend = 0;
    const giroCategories = {};
    const otherCategories = {};
    const categories = {};
    const merchantTotals = {};

    bankTxs.forEach(tx => {
      const route = DuitRules.routeBankTx(tx, rules);
      if (route.kind === "skip") return;
      if (route.kind === "fixed") { giroOut += tx.amount; giroCategories[route.name] = round2((giroCategories[route.name] || 0) + tx.amount); return; }
      if (route.kind === "salary") { salaryIn += tx.amount; return; }
      if (route.kind === "otherIn") {
        // A friend paying you back is a negative one-off, like a card refund labelled Reimbursement.
        if (rules.isReimbursement(tx.description) || resolveCategory(tx) === "Reimbursement") { otherOut -= tx.amount; otherCategories.Reimbursement = round2((otherCategories.Reimbursement || 0) - tx.amount); }
        else otherIn += tx.amount;
        return;
      }
      const label = resolveCategory(tx);
      if (label === "Credit Card Payment") return;
      if (rules.isOneOff(label)) { otherOut += tx.amount; otherCategories[label] = round2((otherCategories[label] || 0) + tx.amount); }
      else { cardSpend += tx.amount; categories[label] = round2((categories[label] || 0) + tx.amount); }
    });

    cardTxs.forEach(tx => {
      if (DuitRules.routeCardTx(tx, rules).kind === "skip") return;
      const signed = tx.type === "DR" ? tx.amount : -tx.amount;
      const cat = resolveCategory(tx);
      if (cat === "Credit Card Payment") return;
      if (rules.isOneOff(cat)) { otherOut += signed; otherCategories[cat] = round2((otherCategories[cat] || 0) + signed); }
      else {
        cardSpend += signed; categories[cat] = round2((categories[cat] || 0) + signed);
        const merchant = tx.description || "Unknown";
        merchantTotals[merchant] = round2((merchantTotals[merchant] || 0) + signed);
      }
    });

    const topMerchants = Object.entries(merchantTotals).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, amt]) => ({ name, amt }));
    const allTx = txs.map(t => ({ date: t.date, account: t.account, description: t.description, withdrawal: t.type === "DR" ? t.amount : null, deposit: t.type === "CR" ? t.amount : null, category: t.category || null, file: t.file || null, ...spendFlags(t) }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    months[month] = {
      month, salaryIn: round2(salaryIn), otherIn: round2(otherIn), totalIn: round2(salaryIn + otherIn),
      cardSpend: round2(cardSpend), cardSpendAvailable: cardTxs.length > 0,
      giroOut: round2(giroOut), otherOut: round2(otherOut), totalOut: round2(cardSpend + giroOut + otherOut),
      giroCategories, categories: cardTxs.length > 0 ? categories : null, otherCategories, topMerchants, transactions: allTx,
      catVersion: DuitCategorise.CATEGORISER_VERSION,
    };
  });
  return months;
}
function sortMonthKeys(keys) {
  return keys.sort((a, b) => {
    const [am, ay] = a.split(" "), [bm, by] = b.split(" ");
    return ay !== by ? Number(ay) - Number(by) : MONTH_ORDER.indexOf(am) - MONTH_ORDER.indexOf(bm);
  });
}
function syncFromText(csvText) {
  return syncFromRows(keepSpendFlags(parseSheetTransactions(csvText)));
}
// Rows from the PDF parsers already know their account. Only rows without
// one (CSV and paste) fall back to guessing it from descriptions, as an
// account with no number (bank-uob).
function syncFromRows(rawRows) {
  const byFile = {};
  rawRows.forEach(r => { if (!r.account) (byFile[r.file] = byFile[r.file] || []).push(r); });
  const fileAccount = {};
  Object.entries(byFile).forEach(([file, rows]) => {
    const type = classifyFile(rows);
    fileAccount[file] = DuitAccounts.isLegacy(type) ? DuitAccounts.fromLegacy(type).id : type;
  });
  const clean = rawRows.map(r => ({ ...r, account: r.account || fileAccount[r.file] }));
  const monthTotals = buildMonths(clean);
  const monthKeys = sortMonthKeys(Object.keys(monthTotals));
  return monthKeys.map(k => monthTotals[k]);
}

// PDFs arrive a statement at a time, and a card statement spans two months,
// so a PDF import can't replace whole months the way a full CSV does. Each
// touched month is rebuilt from its saved transactions plus the new rows
// (accounts.js mergeMonth: same-file rows are replaced, older rows matched
// one for one, categories carried over).
const txToRow = DuitAccounts.txToRow;
// A CSV or paste replaces whole months. One-off flags set in the app aren't in
// the file, so carry them over from saved rows that match.
function keepSpendFlags(rows) {
  const flagged = appData.months.flatMap(m => (m.transactions || []).filter(tx => tx.spendType || tx.suggestDismissed).map(txToRow));
  if (flagged.length) DuitAccounts.matchOldRows(rows, flagged, true);
  return rows.map(({ matched, ...r }) => r);
}
function planImport(newRows) {
  const files = new Set(newRows.map(r => r.file));
  const existing = {}; appData.months.forEach(m => { existing[m.month] = m; });
  const byMonth = {};
  newRows.forEach(r => { const k = monthKeyFromDate(r.date); if (k) (byMonth[k] = byMonth[k] || []).push({ ...r }); });
  const rows = [], manual = [];
  let replaced = 0;
  Object.entries(byMonth).forEach(([month, incoming]) => {
    const prev = existing[month];
    if (prev && !(prev.transactions || []).length) manual.push(month);
    const merged = DuitAccounts.mergeMonth(prev ? prev.transactions : [], incoming, files);
    replaced += merged.replaced;
    rows.push(...merged.rows);
  });
  return { months: syncFromRows(rows), monthKeys: sortMonthKeys(Object.keys(byMonth)), manual, replaced };
}
// Months keep the totals worked out at import, so changed rules only show
// once each imported month is rebuilt from its saved rows. Months entered by
// hand have no rows and keep their totals.
function rebuildMonths() {
  const rows = appData.months.flatMap(m => (m.transactions || []).map(txToRow));
  return rows.length ? syncFromRows(rows) : [];
}
// Months built by older category rules are rebuilt once, so new rules reach
// the saved totals. With db, waits for the rules so the rebuild uses them.
let rulesLoaded = false;
function refreshStaleMonths() {
  if (!rulesLoaded) return;
  const stale = appData.months.some(m => (m.transactions || []).length && m.catVersion !== DuitCategorise.CATEGORISER_VERSION);
  if (!stale) return;
  const rebuilt = rebuildMonths();
  if (rebuilt.length) persistMonths(rebuilt).then(() => render()).catch(err => { ui.syncError = "Couldn't update categories: " + err.message; render(); });
}
function opexLineItems(months, category) {
  const rules = currentRules();
  const rows = [];
  months.forEach(m => {
    if (!m.cardSpendAvailable) return;
    (m.transactions || []).forEach((tx, i) => {
      if (rules.isTransfer(tx.description) || rules.isCardBill(tx.description) || rules.fixedBillFor(tx.description)) return;
      const isBank = isBankAccount(tx.account);
      if (isBank && tx.withdrawal == null) return;
      const amount = tx.withdrawal != null ? tx.withdrawal : -(tx.deposit || 0);
      if (!amount) return;
      const resolvedCat = resolveCategory(tx);
      if (resolvedCat !== category) return;
      rows.push({ ...tx, amount, month: m.month, guessed: !tx.category, key: txKey(m.month, i) });
    });
  });
  return rows.sort((a, b) => b.amount - a.amount);
}

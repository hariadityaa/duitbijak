// Persistence: localStorage or db, import and restore.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== persistence ==============================
   Two layers: the `db` capability (a shared, realtime store scoped to this
   artifact) when the viewer grants it — this only applies if the page is
   ever embedded inside a Claude artifact viewer. Falls back to this
   browser's localStorage otherwise, which is the normal path when this
   page is hosted as a plain static site (e.g. GitHub Pages): there is no
   server and no account system here, so every visitor's data lives only
   in their own browser and is never sent anywhere. One document per month
   (or per fixed commitment), keyed by a sanitized id, when db is active.
   Rules are one document, "rules" in the settings collection. */
let dbApi = null;
const docIdForMonth = month => month.replace(/\s+/g, "_");
const docIdForCommitment = name => name.replace(/[^\w-]+/g, "_") || "item";
// Months saved before a category rename still carry the old labels in their
// totals. Fold them into the current ones as they load.
// Old one-off types are folded in too: "capital" is now "asset", which no longer spreads.
const canonTx = t => t.spendType && DuitCategorise.canonSpendType(t.spendType) !== t.spendType ? { ...t, spendType: DuitCategorise.canonSpendType(t.spendType) } : t;
const canonMonth = m => {
  if (!m) return m;
  const out = m.categories ? { ...m, categories: DuitCategorise.canonCategoryTotals(m.categories) } : { ...m };
  if (m.transactions) out.transactions = m.transactions.map(canonTx);
  return out;
};
// rules: null until the user saves their own, so the defaults apply.
const emptyData = () => ({ months: [], fixedCommitments: {}, statements: {}, rules: null, accounts: {} });
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const parsed = JSON.parse(raw); return { months: (parsed.months || []).map(canonMonth), fixedCommitments: parsed.fixedCommitments || {}, statements: parsed.statements || {}, rules: parsed.rules || null, accounts: parsed.accounts || {} }; }
  } catch (e) {}
  return emptyData();
}
function saveLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appData)); } catch (e) {} }

let appData = emptyData();
let ui = {
  tab: "overview", fromIdx: 0, toIdx: 0, hideIncome: true,
  bucketOverview: "opex",
  drill: [], drillSort: "date", // drill-down sheets, top last: { kind: "month" | "cat", bucket, month, cat }
  sheet: null, // null | "add" | "paste" | "month" | "settings" | "rules" | "suggest" | "statements" | "accounts"
  rulesDraft: null, suggestions: null, // rule edits wait here until saved
  customPeriod: false, txQuery: "", txLimit: 0, syncError: null, lastSynced: null,
  txFilter: null, // { month, bucket, label }: set from a drill-down sheet's "See all"
  storage: "connecting", // "connecting" | "synced" | "local"
};
// Saving a flag rewrites a month but adds none, so the chosen period stays.
let periodCount = -1;
function resetPeriod() {
  const n = appData.months.length;
  if (n === periodCount || !n) return;
  periodCount = n;
  [ui.fromIdx, ui.toIdx] = presetRange("3m");
}
function applySnapshotMonths(rawMonths) {
  const byKey = {}; rawMonths.forEach(m => { byKey[m.month] = canonMonth(m); });
  appData.months = sortMonthKeys(Object.keys(byKey)).map(k => byKey[k]);
  resetPeriod();
  ui.lastSynced = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
  render();
}
function applySnapshotFixed(rawFixed) {
  const map = {};
  rawFixed.forEach(f => { map[f.name] = f.amount; });
  appData.fixedCommitments = map;
  render();
}
async function initPersistence() {
  const canUseDb = typeof window.claude === "object" && window.claude && typeof window.claude.use === "function";
  const db = canUseDb ? await window.claude.use("db").catch(() => null) : null;
  if (db) {
    dbApi = db;
    ui.storage = "synced";
    db.collection("months").onSnapshot(
      snap => { applySnapshotMonths(snap.docs.filter(d => d.exists).map(d => d.data())); migrateLoaded(); refreshStaleMonths(); },
      err => { ui.storage = "local"; dbApi = null; appData = loadLocal(); resetPeriod(); ui.syncError = "Cross-device sync unavailable (" + err.message + ") — using this browser only."; render(); }
    );
    db.collection("fixedCommitments").onSnapshot(
      snap => applySnapshotFixed(snap.docs.filter(d => d.exists).map(d => d.data())),
      () => {}
    );
    db.collection("settings").onSnapshot(
      snap => { const doc = snap.docs.find(d => d.exists && d.id === "rules"); appData.rules = doc ? doc.data() : null; rulesLoaded = true; refreshStaleMonths(); render(); },
      () => {}
    );
    db.collection("statements").onSnapshot(
      snap => { const map = {}; snap.docs.filter(d => d.exists).forEach(d => { const r = d.data(); map[r.id] = r; }); appData.statements = map; migrateLoaded(); render(); },
      () => {}
    );
    db.collection("accounts").onSnapshot(
      snap => { const map = {}; snap.docs.filter(d => d.exists).forEach(d => { const a = d.data(); map[a.id] = a; }); appData.accounts = map; render(); },
      () => {}
    );
  } else {
    ui.storage = "local";
    appData = loadLocal();
    rulesLoaded = true;
    migrateLoaded();
    refreshStaleMonths();
    resetPeriod();
    render();
  }
}
// Data saved before accounts existed names accounts by statement type.
// Rewritten once, in place (accounts.js migrate is idempotent, so a synced
// snapshot that's already migrated changes nothing).
function migrateLoaded() {
  const res = DuitAccounts.migrate(appData);
  if (!res.changed) return;
  const changed = new Set(res.changedMonths);
  appData.months = res.months; appData.statements = res.statements; appData.accounts = res.accounts;
  if (!dbApi) { saveLocal(); return; }
  const months = res.months.filter(m => changed.has(m.month));
  const records = Object.values(res.statements).filter(r => r && r.source && !r.inferred);
  Promise.all([
    ...months.map(m => dbApi.collection("months").doc(docIdForMonth(m.month)).set(m)),
    ...res.removedStatements.map(id => dbApi.collection("statements").doc(id).delete()),
    ...records.map(r => dbApi.collection("statements").doc(r.id).set(r)),
    ...res.addedAccounts.map(a => dbApi.collection("accounts").doc(a.id).set(a)),
  ]).catch(err => { ui.syncError = "Couldn't update saved accounts: " + err.message; render(); });
}
// Writes months (an array of month objects) to whichever layer is active.
// With db, each month is its own document — a paste only overwrites the
// months it covers, so previously synced/manual months are left alone.
async function persistMonths(monthsArr) {
  if (dbApi) {
    await Promise.all(monthsArr.map(m => dbApi.collection("months").doc(docIdForMonth(m.month)).set(m)));
  } else {
    const byKey = {}; appData.months.forEach(m => { byKey[m.month] = m; });
    monthsArr.forEach(m => { byKey[m.month] = m; });
    appData.months = sortMonthKeys(Object.keys(byKey)).map(k => byKey[k]);
    saveLocal();
    resetPeriod();
  }
}
// One record per source per statement month, so a re-import replaces it,
// along with any record it supersedes (statements.js supersededBy).
async function persistStatements(records) {
  const saved = Object.values(appData.statements || {});
  const drop = [...new Set(records.flatMap(r => DuitStatements.supersededBy(saved, r)))];
  if (dbApi) {
    await Promise.all(records.map(r => dbApi.collection("statements").doc(r.id).set(r)));
    await Promise.all(drop.map(id => dbApi.collection("statements").doc(id).delete()));
  } else {
    appData.statements = { ...appData.statements };
    drop.forEach(id => { delete appData.statements[id]; });
    records.forEach(r => { appData.statements[r.id] = r; });
    saveLocal();
  }
}
// New accounts, or a rename or hide of one already saved.
async function persistAccounts(list) {
  if (!list.length) return;
  if (dbApi) {
    await Promise.all(list.map(a => dbApi.collection("accounts").doc(a.id).set(a)));
  } else {
    appData.accounts = { ...appData.accounts };
    list.forEach(a => { appData.accounts[a.id] = a; });
    saveLocal();
  }
}
async function persistFixedCommitment(name, amount) {
  if (dbApi) {
    await dbApi.collection("fixedCommitments").doc(docIdForCommitment(name)).set({ name, amount });
  } else {
    appData.fixedCommitments[name] = amount;
    saveLocal();
  }
}
async function persistRules(rules) {
  if (dbApi) {
    await dbApi.collection("settings").doc("rules").set(rules);
  } else {
    appData.rules = rules;
    saveLocal();
  }
}
async function deleteFixedCommitment(name) {
  if (dbApi) {
    await dbApi.collection("fixedCommitments").doc(docIdForCommitment(name)).delete();
  } else {
    delete appData.fixedCommitments[name];
    saveLocal();
  }
}
// A restore replaces everything, as a clear followed by an import would.
async function restoreAllData(data) {
  if (dbApi) {
    await clearAllData();
    await Promise.all([
      ...data.months.map(m => dbApi.collection("months").doc(docIdForMonth(m.month)).set(m)),
      ...Object.entries(data.fixedCommitments).map(([name, amount]) => dbApi.collection("fixedCommitments").doc(docIdForCommitment(name)).set({ name, amount })),
      ...Object.values(data.statements).filter(r => r && r.id).map(r => dbApi.collection("statements").doc(r.id).set(r)),
      ...Object.values(data.accounts).filter(a => a && a.id).map(a => dbApi.collection("accounts").doc(a.id).set(a)),
      ...(data.rules ? [dbApi.collection("settings").doc("rules").set(data.rules)] : []),
    ]);
  } else {
    appData = { ...data, months: sortMonthKeys(data.months.map(m => m.month)).map(k => canonMonth(data.months.find(m => m.month === k))) };
    saveLocal();
    migrateLoaded();
    refreshStaleMonths();
    periodCount = -1;
    resetPeriod();
  }
}
function downloadFile(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function clearAllData() {
  if (dbApi) {
    const snap = await dbApi.collection("months").get();
    await Promise.all(snap.docs.map(d => dbApi.collection("months").doc(d.id).delete()));
    const fsnap = await dbApi.collection("fixedCommitments").get();
    await Promise.all(fsnap.docs.map(d => dbApi.collection("fixedCommitments").doc(d.id).delete()));
    const ssnap = await dbApi.collection("statements").get();
    await Promise.all(ssnap.docs.map(d => dbApi.collection("statements").doc(d.id).delete()));
    const rsnap = await dbApi.collection("settings").get();
    await Promise.all(rsnap.docs.map(d => dbApi.collection("settings").doc(d.id).delete()));
    const asnap = await dbApi.collection("accounts").get();
    await Promise.all(asnap.docs.map(d => dbApi.collection("accounts").doc(d.id).delete()));
  } else {
    appData = emptyData();
    saveLocal();
  }
}

function showToast(msg) {
  const holder = document.getElementById("toast-holder");
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg;
  holder.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

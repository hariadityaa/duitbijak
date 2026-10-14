// Event delegation: every data-action.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== events ============================== */
let wired = false;
const OVER_IMPORT = new Set(["settings", "rules", "suggest", "accounts"]);
function wireOnce() {
  if (wired) return; wired = true;
  const root = document.getElementById("app");
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  // Search re-renders only the list, so the input keeps focus and the keyboard stays up.
  root.addEventListener("input", e => {
    if (e.target.id !== "tx-search") return;
    ui.txQuery = e.target.value; ui.txLimit = 0;
    const list = document.getElementById("tx-list");
    if (list) list.innerHTML = renderTxList();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && (ui.sheet || ui.pdfImport) && !(ui.pdfImport && !OVER_IMPORT.has(ui.sheet))) { ui.sheet = null; render(); }
    else if (e.key === "Escape" && ui.drill.length && !ui.pdfImport) { closeDrill(1); render(); }
    // Rows that open a sheet are divs with role="button"; Enter and Space work as on a button.
    else if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
  });
  // Back closes the top drill-down sheet. Each open level pushed one history entry.
  // The page doesn't move under a sheet, so there's no scroll to restore, and restoring one fights "See all".
  try { history.scrollRestoration = "manual"; } catch (e) {}
  window.addEventListener("popstate", e => {
    const depth = (e.state && e.state.drill) || 0;
    if (depth < ui.drill.length) { ui.drill = ui.drill.slice(0, depth); ui.editTx = null; render(); }
  });
  // The FAB hides while scrolling down through content and returns on scroll up.
  let lastY = window.scrollY;
  window.addEventListener("scroll", () => {
    const y = window.scrollY, hide = y > lastY && y > 80;
    if (Math.abs(y - lastY) < 8) return;
    lastY = y;
    if (hide === fabHidden) return;
    fabHidden = hide;
    const fab = document.querySelector(".fab");
    if (fab) fab.classList.toggle("hidden", hide);
  }, { passive: true });
}
let fabHidden = false;
function onChange(e) {
  const t = e.target;
  if (t.id === "from-select") { ui.fromIdx = Number(t.value); if (ui.fromIdx > ui.toIdx) ui.toIdx = ui.fromIdx; render(); }
  else if (t.id === "spend-life") {
    const life = Math.round(Number(t.value));
    if (life >= 1 && life <= 600) saveSpend(t.getAttribute("data-key"), { life }); else render();
  }
  else if (t.id === "to-select") { ui.toIdx = Number(t.value); if (ui.toIdx < ui.fromIdx) ui.fromIdx = ui.toIdx; render(); }
  else if (t.id === "csv-file-input") {
    const file = t.files && t.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => ingestText(String(reader.result || ""), ` from ${file.name}`, false);
    reader.onerror = () => { ui.syncError = `Couldn't read ${file.name}.`; render(); };
    reader.readAsText(file);
    t.value = "";
  }
  else if (t.classList.contains("acct-name")) saveAccountEdit(t.getAttribute("data-id"), { name: t.value.trim().slice(0, 40) });
  else if (t.classList.contains("acct-hidden")) saveAccountEdit(t.getAttribute("data-id"), { hidden: t.checked });
  else if (t.classList.contains("tx-category")) saveCategory(t.getAttribute("data-key"), t.value);
  else if (t.id === "restore-file-input") {
    const file = t.files && t.files[0];
    if (!file) return;
    file.text().then(text => { ui.restore = { name: file.name, data: DuitBackup.parseBackup(text) }; ui.syncError = null; render(); })
      .catch(err => { ui.restore = null; ui.syncError = err.message; render(); });
    t.value = "";
  }
  else if (t.id === "pdf-file-input") {
    const files = t.files;
    startPdfImport(files).catch(err => { ui.pdfImport = null; ui.syncError = "PDF import failed: " + err.message; render(); });
  }
}
// Shared by both the paste textarea and the CSV file import: parses the text,
// saves the resulting months, and reports the outcome the same way either path.
// Pasted text is kept in the box on failure so it can be fixed, not re-pasted.
function ingestText(text, sourceSuffix, fromPaste) {
  let parsedMonths;
  try { parsedMonths = syncFromText(text); }
  catch (err) { ui.syncError = err.message; if (fromPaste) ui.pasteDraft = text; render(); return; }
  persistMonths(parsedMonths).then(() => {
    ui.sheet = null; ui.syncError = null; ui.pasteDraft = "";
    if (!dbApi) ui.lastSynced = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
    showToast(`Loaded ${parsedMonths.length} month${parsedMonths.length !== 1 ? "s" : ""}${sourceSuffix}.`);
    render();
  }).catch(err => { ui.syncError = "Couldn't save that: " + err.message; if (fromPaste) ui.pasteDraft = text; render(); });
}
// Adds to the draft. False, with a toast, when the bill can't be added.
function addFixedBill(name, match) {
  const d = ui.rulesDraft;
  if (!name || !match) { showToast("Enter a name and a keyword."); return false; }
  const err = DuitRules.patternError(match);
  if (err) { showToast(`${err}.`); return false; }
  if (d.fixedBills.some(b => b.name.toUpperCase() === name.toUpperCase())) { showToast("A bill with that name exists."); return false; }
  d.fixedBills.push({ name, match });
  return true;
}
function onClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  if (action !== "clear-data") ui.confirmClear = false;

  if (action === "close-sheet") {
    // The backdrop carries this action too; only a tap on the backdrop itself closes.
    if (btn.classList.contains("sheet-backdrop") && e.target !== btn) return;
    ui.sheet = null; ui.keyTest = null; ui.restore = null; closeDrill(ui.drill.length); render();
  }
  else if (action === "set-tab") { ui.tab = btn.getAttribute("data-tab"); closeDrill(ui.drill.length); ui.txFilter = null; ui.txLimit = 0; ui.editTx = null; render(); window.scrollTo(0, 0); }
  else if (action === "edit-spend") { const k = btn.getAttribute("data-key"); ui.editTx = ui.editTx === k ? null : k; render(); }
  else if (action === "confirm-spend") saveSpend(btn.getAttribute("data-key"), { spendType: btn.getAttribute("data-type"), life: null });
  else if (action === "dismiss-spend") saveSpend(btn.getAttribute("data-key"), { suggestDismissed: true });
  else if (action === "set-spend") {
    const type = btn.getAttribute("data-type");
    // Choosing Normal also stops the row being suggested again.
    saveSpend(btn.getAttribute("data-key"), type ? { spendType: type, life: null } : { spendType: null, life: null, suggestDismissed: true });
  }
  else if (action === "open-add") { ui.sheet = "add"; ui.syncError = null; render(); }
  else if (action === "open-sheet") {
    ui.sheet = btn.getAttribute("data-sheet"); render();
    const ta = document.getElementById("paste-input"); if (ta) ta.focus();
  }
  else if (action === "set-preset") { [ui.fromIdx, ui.toIdx] = presetRange(btn.getAttribute("data-preset")); ui.customPeriod = false; ui.txLimit = 0; render(); }
  else if (action === "custom-period") { ui.customPeriod = true; render(); }
  else if (action === "tx-more") { ui.txLimit = (ui.txLimit || TX_PAGE) + TX_PAGE; const list = document.getElementById("tx-list"); if (list) list.innerHTML = renderTxList(); }
  else if (action === "apply-update") { location.reload(); }
  else if (action === "install-app") {
    const ev = pwa.installEvent;
    pwa.installEvent = null; render();
    if (ev) ev.prompt().catch(() => {});
  }
  else if (action === "decline-install") {
    pwa.installDeclined = true;
    try { localStorage.setItem(INSTALL_DECLINED, "1"); } catch (e) {}
    render();
  }
  else if (action === "toggle-income") { ui.hideIncome = !ui.hideIncome; render(); }
  else if (action === "set-bucket") { ui[btn.getAttribute("data-key")] = btn.getAttribute("data-value"); render(); }
  else if (action === "drill-month") openDrill({ kind: "month", bucket: btn.getAttribute("data-bucket"), month: btn.getAttribute("data-month") });
  else if (action === "drill-cat") openDrill({ kind: "cat", bucket: btn.getAttribute("data-bucket"), cat: btn.getAttribute("data-cat"), month: btn.getAttribute("data-month") || null });
  else if (action === "drill-back") { closeDrill(1); render(); }
  else if (action === "drill-pick-month") {
    const top = ui.drill[ui.drill.length - 1], month = btn.getAttribute("data-month");
    if (top) { top.month = top.month === month ? null : month; ui.editTx = null; render(); }
  }
  else if (action === "show-txns" || action === "drill-to-txns" || action === "tx-search") {
    const top = ui.drill[ui.drill.length - 1], month = btn.getAttribute("data-month");
    ui.txFilter = action === "drill-to-txns" && top ? (top.kind === "cat" ? { month: top.month, bucket: top.bucket, label: top.cat } : { month: top.month })
      : action === "tx-search" && month ? { month } : null;
    ui.txQuery = action === "tx-search" ? btn.getAttribute("data-q") : "";
    ui.tab = "txns"; ui.txLimit = 0; ui.editTx = null;
    closeDrill(ui.drill.length); render(); window.scrollTo(0, 0);
  }
  else if (action === "tx-unfilter") {
    const f = { ...ui.txFilter }, field = btn.getAttribute("data-field");
    if (field === "label") { delete f.label; delete f.bucket; } else delete f.month;
    ui.txFilter = f.label || f.month ? f : null; ui.txLimit = 0; render();
  }
  else if (action === "drill-sort") { ui.drillSort = btn.getAttribute("data-sort"); render(); }
  else if (action === "clear-data") {
    if (ui.confirmClear) {
      const storage = ui.storage;
      clearAllData().then(() => {
        ui = { tab: "overview", fromIdx: 0, toIdx: 0, hideIncome: true, bucketOverview: "opex", drill: [], drillSort: "date", sheet: null, customPeriod: false, txQuery: "", txFilter: null, txLimit: 0, syncError: null, lastSynced: null, storage };
        showToast("Data cleared.");
        render();
      }).catch(err => { ui.syncError = "Couldn't clear data: " + err.message; render(); });
    } else { ui.confirmClear = true; render(); }
  }
  else if (action === "process-paste") {
    const ta = document.getElementById("paste-input");
    const text = ta ? ta.value : "";
    if (!text.trim()) return;
    btn.disabled = true; btn.textContent = "Processing…";
    ingestText(text, "", true);
  }
  else if (action === "export-json") {
    downloadFile(DuitBackup.backupFileName("json"), "application/json", JSON.stringify(DuitBackup.buildBackup(appData), null, 1));
    showToast("Backup saved.");
  }
  else if (action === "export-csv") {
    downloadFile(DuitBackup.backupFileName("csv"), "text/csv", DuitBackup.transactionsCsv(appData.months, { accountName: accountLabel, category: resolveCategory }));
    showToast("CSV saved.");
  }
  else if (action === "trigger-restore") { const input = document.getElementById("restore-file-input"); if (input) input.click(); }
  else if (action === "cancel-restore") { ui.restore = null; render(); }
  else if (action === "confirm-restore") {
    const r = ui.restore;
    if (!r) return;
    btn.disabled = true;
    restoreAllData(r.data).then(() => { ui.restore = null; ui.syncError = null; showToast(`Restored ${r.data.months.length} month${r.data.months.length !== 1 ? "s" : ""}.`); render(); })
      .catch(err => { ui.syncError = "Couldn't restore: " + err.message; render(); });
  }
  else if (action === "trigger-csv-import") {
    const input = document.getElementById("csv-file-input");
    if (input) input.click();
  }
  else if (action === "trigger-pdf-import") {
    const input = document.getElementById("pdf-file-input");
    if (input) input.click();
  }
  else if (action === "pdf-toggle-file" || action === "pdf-toggle-rows") {
    const f = ui.pdfImport && ui.pdfImport.files[Number(btn.getAttribute("data-idx"))];
    if (!f) return;
    if (action === "pdf-toggle-file") f.include = !f.include; else f.open = !f.open;
    render();
  }
  else if (action === "pdf-cancel") { ui.pdfImport = null; render(); }
  else if (action === "pdf-gemini" || action === "pdf-gemini-consent" || action === "pdf-gemini-cancel") {
    const f = ui.pdfImport && ui.pdfImport.files[Number(btn.getAttribute("data-idx"))];
    if (!f || !f.pages || f.geminiBusy) return;
    if (action === "pdf-gemini-cancel") { f.askConsent = false; render(); return; }
    if (action === "pdf-gemini-consent") { try { DuitGemini.giveConsent(); } catch (e) {} }
    else if (!DuitGemini.hasConsent()) { f.askConsent = true; render(); return; }
    readWithGemini(f).catch(err => { f.geminiBusy = false; f.geminiError = "Gemini read failed: " + err.message; render(); });
  }
  else if (action === "open-rules") {
    if (!ui.rulesDraft) ui.rulesDraft = DuitRules.normaliseRules(appData.rules);
    ui.sheet = "rules"; render();
  }
  else if (action === "rules-add" || action === "rules-add-bill") {
    const d = ui.rulesDraft;
    if (!d) return;
    if (action === "rules-add-bill") {
      const name = (document.getElementById("rule-bill-name").value || "").trim();
      const match = (document.getElementById("rule-bill-match").value || "").trim();
      if (!addFixedBill(name, match)) return;
    } else {
      const list = btn.getAttribute("data-list");
      const value = (document.getElementById(`rule-input-${list}`).value || "").trim();
      if (!value) { showToast("Type something first."); return; }
      const err = !LABEL_LISTS.includes(list) && DuitRules.patternError(value);
      if (err) { showToast(`${err}.`); return; }
      if (d[list].some(v => v.toUpperCase() === value.toUpperCase()) || (LABEL_LISTS.includes(list) && DuitRules.BUILT_IN_ONE_OFF.includes(value))) { showToast("Already in the list."); return; }
      const other = LABEL_LISTS.find(l => l !== list && LABEL_LISTS.includes(list) && d[l].some(v => v.toUpperCase() === value.toUpperCase()));
      if (other) { showToast(`Already a ${other === "savingsCategories" ? "savings" : "one-off"} category.`); return; }
      d[list].push(value);
    }
    render();
  }
  else if (action === "rules-remove") {
    const d = ui.rulesDraft, list = btn.getAttribute("data-list");
    if (!d || !d[list]) return;
    d[list].splice(Number(btn.getAttribute("data-idx")), 1);
    render();
  }
  else if (action === "rules-discard") { ui.rulesDraft = DuitRules.normaliseRules(appData.rules); render(); }
  else if (action === "rules-suggest") {
    if (!ui.rulesDraft) return;
    const txs = appData.months.flatMap(m => m.transactions || []);
    ui.suggestions = DuitRules.suggestFixedBills(txs, ui.rulesDraft, { isBank: isBankAccount });
    ui.sheet = "suggest"; render();
  }
  else if (action === "suggest-add" || action === "suggest-skip") {
    const i = Number(btn.getAttribute("data-idx"));
    if (!ui.suggestions || !ui.suggestions[i]) return;
    if (action === "suggest-add") {
      const name = (document.getElementById(`sg-name-${i}`).value || "").trim();
      const match = (document.getElementById(`sg-match-${i}`).value || "").trim();
      if (!addFixedBill(name, match)) return;
      showToast(`${name} added. Save rules to apply.`);
    }
    ui.suggestions.splice(i, 1);
    render();
  }
  else if (action === "rules-save") {
    if (!ui.rulesDraft) return;
    const next = { ...DuitRules.normaliseRules(ui.rulesDraft), updatedAt: new Date().toISOString() };
    const prev = appData.rules;
    btn.disabled = true; btn.textContent = "Saving…";
    // Set before the rebuild so it uses the new rules. With db, the snapshot confirms it.
    appData.rules = next;
    const rebuilt = rebuildMonths();
    persistRules(next).then(() => rebuilt.length ? persistMonths(rebuilt) : null).then(() => {
      ui.rulesDraft = null; ui.suggestions = null; ui.sheet = "settings"; ui.syncError = null;
      showToast(rebuilt.length ? `Rules saved. ${rebuilt.length} month${rebuilt.length !== 1 ? "s" : ""} rebuilt.` : "Rules saved.");
      render();
    }).catch(err => { appData.rules = prev; ui.syncError = "Couldn't save rules: " + err.message; render(); });
  }
  else if (action === "open-settings") { ui.sheet = "settings"; ui.keyTest = null; render(); }
  else if (action === "save-key") {
    const input = document.getElementById("gemini-key-input");
    const key = input ? input.value.trim() : "";
    if (!key) { showToast("Paste a key first."); return; }
    try { DuitGemini.saveKeys({ ...DuitGemini.loadKeys(), gemini: key }); }
    catch (e) { showToast("Couldn't save the key in this browser."); return; }
    ui.keyTest = null; showToast("Gemini key saved."); render();
  }
  else if (action === "test-key") {
    const key = DuitGemini.loadKeys().gemini;
    if (!key) return;
    ui.keyTest = { busy: true }; render();
    DuitGemini.testKey(key).then(r => { ui.keyTest = r; render(); });
  }
  else if (action === "clear-key") {
    try { DuitGemini.clearKeys(); } catch (e) {}
    ui.keyTest = null; showToast("Gemini key cleared."); render();
  }
  else if (action === "copy-setup-link") {
    const key = DuitGemini.loadKeys().gemini;
    if (!key) return;
    const link = DuitGemini.buildSetupLink(location.href, { gemini: key });
    const fallback = () => window.prompt("Copy this setup link. It contains your key, so send it privately:", link);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(() => showToast("Setup link copied. Send it privately."), fallback);
    else fallback();
  }
  else if (action === "pdf-commit") {
    const st = ui.pdfImport;
    if (!st || st.busy) return;
    const rows = pdfSelectedRows();
    const fileCount = st.files.filter(f => f.include).length;
    if (!rows.length) return;
    btn.disabled = true; btn.textContent = "Importing…";
    const importedAt = new Date().toISOString();
    const records = st.files.filter(f => f.include).map(f => DuitStatements.recordFromImport(f, importedAt)).filter(Boolean);
    const found = DuitAccounts.register(appData.accounts, st.files.filter(f => f.include).flatMap(f => f.accounts || [])).added;
    persistAccounts(found).then(() => persistMonths(planImport(rows).months)).then(() => persistStatements(records)).then(() => {
      ui.pdfImport = null; ui.sheet = null; ui.syncError = null;
      if (!dbApi) ui.lastSynced = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
      showToast(`Imported ${rows.length} rows from ${fileCount} file${fileCount !== 1 ? "s" : ""}.`);
      render();
    }).catch(err => { ui.syncError = "Couldn't save that: " + err.message; render(); });
  }
  else if (action === "save-month") {
    const v = id => document.getElementById(id);
    const month = (v("f-month").value || "").trim();
    if (!month) { showToast("Enter a month name first."); return; }
    const salary = Number(v("f-salaryIn").value) || 0, otherIn = Number(v("f-otherIn").value) || 0;
    const cardSpend = Number(v("f-cardSpend").value) || 0, giroOut = Number(v("f-giroOut").value) || 0, otherOut = Number(v("f-otherOut").value) || 0;
    const available = v("f-cardAvailable").value === "yes";
    const categories = {};
    CATEGORY_FIELDS.forEach(([key, label]) => { categories[label] = Number(v(`f-${key}`).value) || 0; });
    const newMonth = {
      month, salaryIn: salary, otherIn, totalIn: salary + otherIn,
      cardSpend: available ? cardSpend : null, cardSpendAvailable: available,
      giroOut, otherOut, totalOut: available ? cardSpend + giroOut + otherOut : round2(giroOut + otherOut),
      categories: available ? categories : null,
      giroCategories: {}, otherCategories: {}, topMerchants: [], transactions: [],
    };
    btn.disabled = true; btn.textContent = "Saving…";
    persistMonths([newMonth]).then(() => {
      ui.tab = "overview"; ui.sheet = null;
      if (!dbApi) ui.lastSynced = new Date().toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });
      showToast(`${month} saved.`);
      render();
    }).catch(err => { ui.syncError = "Couldn't save that: " + err.message; render(); });
  }
  else if (action === "add-fixed") {
    const nameEl = document.getElementById("f-fixed-name");
    const amtEl = document.getElementById("f-fixed-amount");
    const name = (nameEl.value || "").trim();
    const amount = Number(amtEl.value);
    if (!name) { showToast("Enter a name first."); return; }
    if (!amount || amount <= 0) { showToast("Enter an amount."); return; }
    persistFixedCommitment(name, round2(amount)).then(() => {
      showToast(`${name} added.`);
      render();
    }).catch(err => { ui.syncError = "Couldn't save that: " + err.message; render(); });
  }
  else if (action === "delete-fixed") {
    const name = btn.getAttribute("data-name");
    deleteFixedCommitment(name).then(() => render()).catch(err => { ui.syncError = "Couldn't delete that: " + err.message; render(); });
  }
}

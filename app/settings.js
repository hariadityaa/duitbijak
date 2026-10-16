// Settings sheets: accounts, rules and data.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== accounts ============================== */
// Grouped by statement source. A name saves when the field loses focus;
// clearing it restores the default. Hidden accounts stay in every total.
function renderAccounts() {
  const list = Object.values(appData.accounts || {});
  if (!list.length) return `<p class="paste-help">No accounts yet. They're added as you import statements.</p>`;
  const bySource = {};
  list.forEach(a => { const s = DuitAccounts.sourceOf(a.id); (bySource[s] = bySource[s] || []).push(a); });
  const order = Object.keys(bySource).sort((a, b) => (a.startsWith("bank-") ? 0 : 1) - (b.startsWith("bank-") ? 0 : 1) || a.localeCompare(b));
  const groups = order.map(src => {
    const first = bySource[src][0];
    const rows = bySource[src].sort((a, b) => String(a.number || "").localeCompare(String(b.number || ""))).map(a => `
    <div class="acct-row${a.hidden ? " hidden-acct" : ""}">
      <input type="text" class="acct-name" data-id="${esc(a.id)}" value="${esc(a.name || DuitAccounts.defaultName(a))}" aria-label="Name for ${esc(DuitAccounts.defaultName(a))}" maxlength="40" autocomplete="off">
      <label class="acct-hide"><input type="checkbox" class="acct-hidden" data-id="${esc(a.id)}" ${a.hidden ? "checked" : ""}> Hide</label>
    </div>
    <p class="acct-meta">${a.number ? `${esc(first.bank)} ${a.kind === "card" ? "card" : "account"} ending ${esc(a.number)}` : "From imports before account numbers were read"}</p>`).join("");
    return `<div class="section-label">${esc(`${first.bank} ${first.kind === "card" ? "cards" : "accounts"}`)}</div>${rows}`;
  }).join("");
  return `
  <p class="paste-help">Accounts are added as you import statements, named by bank and the last 4 digits. Hiding one takes it out of the Statements list and its reminders. Its transactions still count.</p>
  ${groups}`;
}
function saveAccountEdit(id, patch) {
  const a = appData.accounts[id];
  if (!a) return;
  const next = { ...a, ...patch };
  if ("name" in patch && !String(patch.name).trim()) next.name = DuitAccounts.defaultName(a);
  if (next.name === a.name && !!next.hidden === !!a.hidden) return;
  persistAccounts([next]).then(render).catch(err => { ui.syncError = "Couldn't save that: " + err.message; render(); });
}

/* ============================== rules ============================== */
// Edits collect in ui.rulesDraft. Saving rebuilds every imported month once.
const RULE_LISTS = [
  ["salary", "Salary", "Keyword or /regex/", "Credits that count as salary."],
  ["oneOffCategories", "One-off categories", "Category name", "Matches category labels, not descriptions. Kept out of op-ex."],
  ["savingsCategories", "Savings categories", "Category name", "Category labels for money moved into assets you keep. Kept out of op-ex; counted in the savings rate."],
  ["cardBillPayments", "Card bill payments", "Keyword or /regex/", "Skipped, so card spend isn't counted twice."],
  ["internalTransfers", "Internal transfers", "Keyword or /regex/", "Skipped. Add your own name to catch PayNow to yourself."],
  ["reimbursedBy", "Repayments from friends", "Keyword or /regex/", "Bank credits matching these reduce op-ex instead of counting as income. Filled in as you confirm suggestions."],
  ["notReimbursements", "Not repayments", "Keyword or /regex/", "Senders you said aren't repayments, so they stop being suggested."],
];
// Lists of category labels rather than description patterns.
const LABEL_LISTS = ["oneOffCategories", "savingsCategories"];
const rulesKey = r => JSON.stringify({ ...r, updatedAt: null });
function ruleChip(list, value, i) {
  const bad = !LABEL_LISTS.includes(list) && DuitRules.patternError(value);
  return `<span class="rule-chip ${bad ? "bad" : ""}" ${bad ? `title="${esc(bad)}"` : ""}><span class="rule-match">${esc(value)}</span><button class="icon-btn" data-action="rules-remove" data-list="${list}" data-idx="${i}" aria-label="Remove ${esc(value)}">${ICON(ICONS.close, 16)}</button></span>`;
}
function renderRules() {
  const d = ui.rulesDraft;
  const dirty = rulesKey(d) !== rulesKey(DuitRules.normaliseRules(appData.rules));
  const imported = appData.months.filter(m => (m.transactions || []).length).length;
  const manual = appData.months.length - imported;
  const bills = d.fixedBills.map((b, i) => `
    <div class="rule-row ${DuitRules.patternError(b.match) ? "bad" : ""}">
      <span class="rule-name">${esc(b.name)}</span><span class="rule-match">${esc(b.match)}</span>
      <button class="icon-btn" data-action="rules-remove" data-list="fixedBills" data-idx="${i}" aria-label="Remove ${esc(b.name)}">${ICON(ICONS.close, 16)}</button>
    </div>`).join("");
  const lists = RULE_LISTS.map(([list, label, placeholder, help]) => {
    const locked = list === "oneOffCategories" ? DuitRules.BUILT_IN_ONE_OFF.map(c => `<span class="rule-chip locked" title="Built in">${esc(c)}</span>`).join("") : "";
    return `
    <div class="section-label">${esc(label)}</div>
    <p class="paste-help">${esc(help)}</p>
    <div class="rule-chips">${locked}${d[list].map((v, i) => ruleChip(list, v, i)).join("") || (locked ? "" : `<span class="paste-help" style="margin:0;">None yet.</span>`)}</div>
    <div class="rule-add"><input type="text" id="rule-input-${list}" aria-label="New ${esc(label.toLowerCase())}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><button class="btn small" data-action="rules-add" data-list="${list}">Add</button></div>`;
  }).join("");
  return `
  ${appData.rules ? "" : `<p class="paste-help"><strong>Starter rules for Singapore banks.</strong> Edit them to fit your accounts.</p>`}
  <p class="paste-help">Text matches anywhere, in any case. Wrap it in /…/ for a regex.</p>
  <div class="section-label">Fixed bills</div>
  <p class="paste-help">Bank debits counted as fixed, by name.</p>
  ${bills || `<p class="paste-help">None yet.</p>`}
  <div class="rule-add" style="margin-top:12px;">
    <input type="text" id="rule-bill-name" aria-label="Bill name" placeholder="Name" autocomplete="off">
    <input type="text" id="rule-bill-match" aria-label="Bill keyword" placeholder="Keyword or /regex/" autocomplete="off" spellcheck="false">
    <button class="btn small" data-action="rules-add-bill">Add</button>
  </div>
  <div class="btn-row"><button class="btn" data-action="rules-suggest" ${imported ? "" : "disabled"}>Suggest from my transactions</button></div>
  ${lists}
  ${renderRulesShare()}
  <div class="sheet-foot">
    <p>${imported ? `Saving rebuilds ${imported} imported month${imported !== 1 ? "s" : ""}.` : "No imported months to rebuild."}</p>
    ${manual ? `<p>${manual} month${manual !== 1 ? "s" : ""} entered by hand keep${manual === 1 ? "s" : ""} ${manual === 1 ? "its" : "their"} totals.</p>` : ""}
    <div class="btn-row">
      <button class="btn ghost" data-action="rules-discard" ${dirty ? "" : "disabled"}>Discard</button>
      <button class="btn primary" data-action="rules-save" ${dirty || !appData.rules ? "" : "disabled"}>Save rules</button>
    </div>
  </div>`;
}
// Edge case, so it stays collapsed: share rules as a file, or fill them in
// from an AI chat reply. Both merge into the draft.
function renderRulesShare() {
  const hasTxs = appData.months.some(m => (m.transactions || []).length);
  return `
  <details class="rules-share" ${ui.rulesShareOpen ? "open" : ""}>
    <summary>Share or import rules</summary>
    <p class="paste-help">Export your rules as a file, or add rules from someone else's file. Imports merge into the list above and apply when you save.</p>
    <div class="btn-row" style="margin-top:0;">
      <button class="btn small" data-action="rules-export">Export rules</button>
      <button class="btn small" data-action="rules-import-file">Import from file</button>
    </div>
    <input type="file" accept=".json,application/json" id="rules-file-input" style="display:none">
    <p class="paste-help">Or have an AI chat suggest rules. The prompt lists one line per merchant, with no dates or account numbers. Paste its reply below.</p>
    <div class="btn-row" style="margin-top:0;"><button class="btn small" data-action="rules-prompt" ${hasTxs ? "" : "disabled"}>Copy prompt for an AI chat</button></div>
    ${ui.rulesPrompt ? `<textarea class="paste-area" readonly aria-label="Prompt to copy" style="min-height:96px;">${esc(ui.rulesPrompt)}</textarea>` : ""}
    <textarea class="paste-area" id="rules-paste" aria-label="Reply with rules" placeholder="Paste the reply here" style="min-height:96px;margin-top:8px;"></textarea>
    <div class="btn-row"><button class="btn small" data-action="rules-paste-add">Add pasted rules</button></div>
  </details>`;
}
function renderSuggestions() {
  const list = ui.suggestions || [];
  const cards = list.map((s, i) => `
    <div class="suggest-card">
      <div class="rule-add">
        <input type="text" id="sg-name-${i}" aria-label="Bill name" value="${esc(s.name)}" autocomplete="off">
        <input type="text" id="sg-match-${i}" aria-label="Bill keyword" value="${esc(s.match)}" autocomplete="off" spellcheck="false">
      </div>
      <p class="settings-meta"><span class="num">~${esc(fmt(s.avg))}/mo</span> &middot; ${s.months} months</p>
      <p class="settings-meta">${esc(s.example)}</p>
      <div class="btn-row">
        <button class="btn ghost" data-action="suggest-skip" data-idx="${i}">Skip</button>
        <button class="btn primary" data-action="suggest-add" data-idx="${i}">Add</button>
      </div>
    </div>`).join("");
  return `
  <p class="paste-help">Bank debits seen in 3 or more months at a similar amount.</p>
  ${cards || `<p class="paste-help">Nothing else recurs yet.</p>`}
  <p class="paste-help">Added bills apply when you save rules.</p>
  <div class="btn-row"><button class="btn" data-action="open-sheet" data-sheet="rules">Back to rules</button></div>`;
}
// What used to sit in the header subtitle and the page footer.
function renderDataSettings() {
  const months = appData.months;
  const range = months.length ? `${months[0].month} – ${months[months.length - 1].month}` : "no data yet";
  const statusText = ui.storage === "synced" ? "Synced across your devices" : ui.storage === "local" ? "Saved in this browser only" : "Connecting…";
  return `
  <div class="section-label">Your data</div>
  <p class="settings-meta">${esc(statusText)} &middot; ${months.length} month${months.length !== 1 ? "s" : ""} (${esc(range)})${ui.lastSynced ? ` &middot; updated ${esc(ui.lastSynced)}` : ""}<br>Reads UOB, POSB and DBS card statements.</p>
  <div class="btn-row" style="margin-top:0;"><button class="btn" data-action="open-sheet" data-sheet="statements">Statements imported</button><button class="btn danger" data-action="clear-data">${ui.confirmClear ? "Really clear? Tap again" : "Clear all data"}</button></div>
  <div class="section-label">Backup</div>
  <p class="settings-meta">The JSON backup holds everything and restores it exactly. The CSV lists every transaction with its category, for a spreadsheet.</p>
  <div class="btn-row" style="margin-top:0;">
    <button class="btn" data-action="export-json" ${months.length ? "" : "disabled"}>Back up (JSON)</button>
    <button class="btn" data-action="export-csv" ${months.length ? "" : "disabled"}>Export CSV</button>
    <button class="btn ghost" data-action="trigger-restore">Restore backup</button>
  </div>
  <input type="file" accept=".json,application/json" id="restore-file-input" style="display:none">
  ${ui.restore ? `<div class="card" style="margin-top:12px;"><p class="paste-help" style="margin-top:0;">Replace all data in this app with <strong>${esc(ui.restore.name)}</strong>? It has ${ui.restore.data.months.length} month${ui.restore.data.months.length !== 1 ? "s" : ""}. What's here now is lost.</p>
    <div class="btn-row"><button class="btn danger" data-action="confirm-restore">Replace with backup</button><button class="btn ghost" data-action="cancel-restore">Cancel</button></div></div>` : ""}
  <div class="section-label">Share app</div>
  <p class="settings-meta">Send Duit Bijak to a friend. Only the link is shared, never your data.</p>
  <div class="btn-row" style="margin-top:0;"><button class="btn" data-action="share-app">Share link</button></div>
  <p class="settings-meta" style="margin-top:24px;"><a href="https://github.com/hurrymeow/duitbijak" target="_blank" rel="noopener">Duit Bijak</a> is a local-only finance ledger. Nothing you enter leaves your browser.</p>`;
}

// Installed apps hide the address bar, so this is the only way to find the link.
async function shareApp() {
  const url = new URL("./", location.href).href;
  if (navigator.share) {
    try { await navigator.share({ title: "Duit Bijak", url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); showToast("Link copied."); }
  catch (e) { showToast(url); }
}

// Opening "#setup?gemini=…" saves the key, then strips it from the address bar.
function consumeSetupLink() {
  const keys = DuitGemini.parseSetupFragment(location.hash);
  if (!keys) return false;
  try { DuitGemini.saveKeys({ ...DuitGemini.loadKeys(), ...keys }); } catch (e) { return false; }
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

async function readWithGemini(f) {
  f.geminiBusy = true; f.askConsent = false; f.geminiError = null;
  render();
  const res = await DuitGemini.parseWithGemini(f.pages, f.file, DuitGemini.loadKeys().gemini);
  const st = ui.pdfImport;
  const idx = st ? st.files.indexOf(f) : -1;
  if (idx === -1) return; // Import was cancelled meanwhile.
  if (res.error) { f.geminiBusy = false; f.geminiError = res.error; }
  else st.files[idx] = { ...res, include: res.checks.every(c => c.ok), open: false };
  render();
}

// Reads each picked PDF in turn (password prompts need to happen one at a
// time), then shows the review card. Nothing is saved until "Import".
async function startPdfImport(fileList) {
  const picked = Array.from(fileList);
  if (!picked.length) return;
  ui.syncError = null;
  ui.pdfImport = { busy: true, progress: "Loading the PDF reader…", files: [] };
  render();
  let lib;
  try { lib = await window.DuitPdfImport.loadPdfjs(); }
  catch (err) {
    ui.pdfImport = null;
    ui.syncError = navigator.onLine === false
      ? "PDF import needs a connection the first time it's used on this device. CSV import and paste work offline."
      : "Couldn't load the PDF reader: " + err.message;
    render(); return;
  }
  const results = [], seen = new Set();
  for (let i = 0; i < picked.length; i++) {
    const f = picked[i];
    if (seen.has(f.name)) { results.push({ file: f.name, error: "Picked twice. Only the first copy is used." }); continue; }
    seen.add(f.name);
    ui.pdfImport.progress = `Reading ${f.name} (${i + 1} of ${picked.length})…`;
    render();
    const data = new Uint8Array(await f.arrayBuffer());
    const ask = retry => window.prompt(retry ? `Wrong password for ${f.name}. Try again, or cancel to skip it:` : `${f.name} is password-protected. Enter its password, or cancel to skip it:`);
    results.push(await window.DuitPdfImport.parsePdf(lib, data, f.name, ask));
  }
  ui.pdfImport = { busy: false, files: results.map(r => ({ ...r, include: !r.error && r.checks.every(c => c.ok), open: false })) };
  render();
}

// Lives outside `ui` because clearing data resets `ui`, and these are about the app, not the data.
function renderAppPrompts() {
  let out = "";
  if (pwa.updateReady) out += `
  <div class="card promo" role="status">
    <p><strong>A new version of Duit Bijak is ready.</strong></p>
    <div class="btn-row"><button class="btn primary" data-action="apply-update">Update now</button></div>
  </div>`;
  if (pwa.installEvent && !pwa.installDeclined && !isStandalone()) out += `
  <div class="card promo">
    <p><strong>Put Duit Bijak on your home screen.</strong> Open it like any other app. It works offline too.</p>
    <div class="btn-row">
      <button class="btn primary" data-action="install-app">Install app</button>
      <button class="btn ghost" data-action="decline-install">Not now</button>
    </div>
  </div>`;
  return out;
}

function renderPastePanel() {
  return `
  <div class="card">
    <p class="paste-help">Paste a table with columns <strong>Statement File, Bank, Date, Description, Amount, Type, Category</strong>, tab- or comma-separated. Months in the table are replaced; other months already stored here are kept.</p>
    <textarea class="paste-area" id="paste-input" placeholder="Statement File&#9;Bank&#9;Date&#9;Description&#9;Amount&#9;Type&#9;Category&#10;…">${esc(ui.pasteDraft || "")}</textarea>
    <div class="btn-row">
      <button class="btn primary" data-action="process-paste">Process pasted data</button>
      <button class="btn ghost" data-action="open-sheet" data-sheet="add">Back</button>
    </div>
  </div>`;
}

function periodMonths() {
  const months = appData.months;
  const from = Math.min(ui.fromIdx, months.length - 1);
  const to = Math.min(ui.toIdx, months.length - 1);
  return { from, to, filtered: months.slice(from, to + 1) };
}
const PRESETS = [["3m", "3M"], ["6m", "6M"], ["ytd", "YTD"], ["all", "All"]];
// Presets end at the latest full month, so a pending or partial month never
// drags them. With no full month yet, fall back to the latest one.
function presetRange(key) {
  const months = appData.months;
  let last = months.length - 1;
  while (last > 0 && !isConfirmed(months[last])) last--;
  if (!isConfirmed(months[last])) last = months.length - 1;
  if (key === "3m") return [Math.max(0, last - 2), last];
  if (key === "6m") return [Math.max(0, last - 5), last];
  if (key === "ytd") { const year = months[last].month.split(" ")[1]; return [months.findIndex(m => m.month.split(" ")[1] === year), last]; }
  return [0, last];
}
function renderPeriod(from, to, count) {
  const months = appData.months;
  const preset = ui.customPeriod ? null : (PRESETS.find(([k]) => { const [f, t] = presetRange(k); return f === from && t === to; }) || [null])[0];
  const options = sel => months.map((m, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>${esc(m.month)}</option>`).join("");
  return `
  <div class="chips" role="group" aria-label="Period">
    ${PRESETS.map(([k, label]) => `<button class="chip ${preset === k ? "on" : ""}" data-action="set-preset" data-preset="${k}" aria-pressed="${preset === k}">${label}</button>`).join("")}
    <button class="chip ${preset ? "" : "on"}" data-action="custom-period" aria-pressed="${!preset}">Custom</button>
  </div>
  ${preset ? "" : `<div class="period-bar">
    <select id="from-select" aria-label="From">${options(from)}</select>
    <span style="font-size:14px;color:var(--text-2)">to</span>
    <select id="to-select" aria-label="To">${options(to)}</select>
  </div>`}
  <div class="period-range">${esc(months[from].month)} – ${esc(months[to].month)} &middot; ${count} month${count !== 1 ? "s" : ""}</div>`;
}

// A month whose card statements are missing reads as a big drop in spend.
// Spot it from the card statement sources seen in the three months before
// it. Sources, not cards: a new card on the same statement isn't missing.
function cardAccounts(m) { return new Set((m.transactions || []).map(t => t.account).filter(isCardAccount).map(DuitAccounts.sourceOf)); }
function missingCards(m) {
  if (!m.cardSpendAvailable || !(m.transactions || []).length) return [];
  const i = appData.months.findIndex(x => x.month === m.month);
  const seen = new Set();
  appData.months.slice(Math.max(0, i - 3), Math.max(0, i)).forEach(p => cardAccounts(p).forEach(a => seen.add(a)));
  const have = cardAccounts(m);
  return [...seen].filter(a => !have.has(a));
}
// Months whose Op-Ex is complete: a card statement, and no card missing.
// Averages use only these; a partial month would pull them down.
function isConfirmed(m) { return m.cardSpendAvailable && !missingCards(m).length; }
function partialMonths(months) { return months.filter(m => m.cardSpendAvailable && missingCards(m).length).map(m => m.month); }
// Which statements are in, from saved records plus older imports inferred
// from their transactions (statements.js).
const statementCoverage = () => DuitStatements.coverage(Object.values(appData.statements || {}), appData.months, null, { hidden: src => DuitAccounts.sourceHidden(src, appData.accounts) });
const shortDate = ms => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTH_ORDER[d.getUTCMonth()]}`; };
function renderStatementStrip() {
  const issues = DuitStatements.recentIssues(statementCoverage());
  if (!issues.length) return "";
  const shown = issues.slice(-4).reverse().map(x => `<strong>${esc(sourceLabel(x.account))}</strong> ${esc(x.month)} ${x.kind === "due" ? "due" : "missing"}`);
  const more = issues.length > 4 ? ` and ${issues.length - 4} more` : "";
  return `<div class="card nudge"><p>Statements to import: ${shown.join(" &middot; ")}${more}.</p><div class="btn-row" style="margin-top:0;"><button class="btn small" data-action="open-sheet" data-sheet="statements">View</button><button class="btn small primary" data-action="open-add">Import</button></div></div>`;
}
const CELL_LABEL = { ok: "Imported", inferred: "Imported before statements were tracked", warn: "Imported, but totals didn't match", gap: "Missing", due: "Overdue", none: "" };
function statementCell(cell) {
  const state = cell ? cell.state : "none", r = cell && cell.record;
  const title = [CELL_LABEL[state], r && r.file, r && `statement ${r.statementDate}`, r && `${r.rows} row${r.rows !== 1 ? "s" : ""}`].filter(Boolean).join(" · ");
  const mark = state === "ok" || state === "inferred" ? CHECK_ICON : state === "warn" ? WARN_ICON : state === "gap" ? CROSS_ICON : state === "due" ? "Due" : "·";
  return `<td class="stmt-cell ${state}" title="${esc(title)}">${mark}${title ? `<span class="sr-only">${esc(title)}</span>` : ""}</td>`;
}
function renderStatements() {
  const cov = statementCoverage();
  if (!cov.accounts.length) return `<div class="card"><p class="paste-help" style="margin:0;">No statements imported yet. Import a PDF and it shows up here.</p></div>`;
  const head = cov.accounts.map(a => `<th class="c">${esc(sourceLabel(a.name))}</th>`).join("");
  const body = cov.months.map(m => `<tr><th scope="row">${esc(m)}</th>${cov.accounts.map(a => statementCell(cov.cells[a.name][m])).join("")}</tr>`).join("");
  const summary = cov.accounts.map(a => `<div class="pdf-check ${a.overdue ? "bad" : "ok"}">${a.overdue ? CROSS_ICON : CHECK_ICON}<span><strong>${esc(sourceLabel(a.name))}</strong>: latest ${esc(a.last.statementDate)}${a.overdue ? ", next one overdue" : a.nextDue ? `, next around ${esc(shortDate(a.nextDue))}` : ""}</span></div>`).join("");
  return `
  <div class="card">
    <p class="paste-help">One row per statement, so a card statement covering several cards is one row. Each month is by statement date: a card cycle ending 12 Sep counts as Sep.</p>
    <div class="scroll-x ledger-wrap"><table class="ledger stmt-grid">
      <thead><tr><th>Month</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="stmt-legend">
      <span class="stmt-cell ok">${CHECK_ICON} imported</span>
      <span class="stmt-cell inferred">${CHECK_ICON} from older imports</span>
      <span class="stmt-cell warn">${WARN_ICON} totals didn't match</span>
      <span class="stmt-cell gap">${CROSS_ICON} missing</span>
      <span><span class="stmt-cell due">Due</span> overdue</span>
    </div>
    <div class="pdf-checks" style="margin:12px 0 0;">${summary}</div>
    <p class="paste-help" style="margin:12px 0 0;">Statements imported before this list existed are worked out from their transactions, dated by their latest one. Overdue means ${DuitStatements.GRACE_DAYS} days past the usual statement date.</p>
    <div class="btn-row"><button class="btn primary" data-action="open-add">Import statements</button></div>
  </div>`;
}

function renderBody() {
  if (!appData.months.length) return renderEmptyState();
  const { from, to, filtered } = periodMonths();
  return `
  ${renderPeriod(from, to, filtered.length)}
  ${ui.tab === "overview" ? renderStatementStrip() + renderOverview(filtered) : ""}
  ${ui.tab === "deepdive" ? renderDeepDive(filtered) : ""}
  ${ui.tab === "txns" ? renderTxns() : ""}
  `;
}

function renderEmptyState() {
  return `
  <div class="card empty-state">
    <h2>No data yet</h2>
    <p>Import your statement PDFs, or paste a ledger (Statement File, Bank, Date, Description, Amount, Type, Category columns), to build the dashboard. Everything you add stays in this browser only.</p>
    <div class="btn-row" style="justify-content:center;">
      <button class="btn primary" data-action="open-add">Add data</button>
    </div>
  </div>`;
}

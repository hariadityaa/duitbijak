// Chart bits and the render shell: header, nav, sheets, PDF review.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== chart bits ============================== */
// segAttrs(name) adds attributes to a segment, e.g. to make it tappable.
function stackedBar(entries, total, colorOf, segAttrs) {
  colorOf = colorOf || hashColor;
  if (!entries.length || total <= 0) return `<div class="stacked-bar empty"></div>`;
  const segs = entries.map(([name, val]) => {
    if (val <= 0) return "";
    const w = (val / total * 100).toFixed(2);
    return `<div class="seg" style="width:${w}%;background:${colorOf(name)}" title="${esc(name)}: ${esc(fmt(val))}" ${segAttrs ? segAttrs(name) : ""}></div>`;
  }).join("");
  return `<div class="stacked-bar">${segs}</div>`;
}

/* ============================== render: shell ============================== */
// The sheet keeps its scroll position across re-renders (PDF progress,
// toggling rows), and only animates in when it first opens.
let lastSheetKey = null;
function render() {
  const root = document.getElementById("app");
  const oldSheet = root.querySelector(".sheet");
  const sheetScroll = oldSheet ? oldSheet.scrollTop : 0;
  const sheet = renderSheet();
  root.innerHTML = renderHeader() + renderBody() + renderNav() + sheet.html;
  const el = root.querySelector(".sheet");
  if (el) { if (sheet.key === lastSheetKey) el.scrollTop = sheetScroll; else el.classList.add("enter"); }
  lastSheetKey = sheet.key;
  document.body.classList.toggle("sheet-open", !!sheet.key);
  wireOnce();
}

const ICON = (paths, size) => `<svg width="${size || 20}" height="${size || 20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  overview: '<path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z"/><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/>',
  detail: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  txns: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
};
const WARN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
function renderHeader() {
  const months = appData.months;
  return `
  <header class="topbar">
    <h1 class="app-title">Duit Bijak</h1>
    <div class="topbar-btns">
      <button class="icon-btn" data-action="toggle-income" aria-pressed="${!ui.hideIncome}" aria-label="${ui.hideIncome ? "Show income" : "Hide income"}" title="${ui.hideIncome ? "Show income" : "Hide income"}">${ICON(ui.hideIncome ? ICONS.eyeOff : ICONS.eye)}</button>
      <button class="icon-btn" data-action="open-settings" aria-label="Settings" title="Settings">${ICON(ICONS.settings)}</button>
    </div>
  </header>
  ${ui.storage === "local" && !months.length ? `<div class="banner warn">${WARN_ICON}<span>This data lives only in this browser's local storage — nothing is uploaded anywhere unless you choose to read a statement with Gemini. Each visitor (and each device) keeps their own separate ledger; tap + to add your own statements.</span></div>` : ""}
  ${ui.syncError ? `<div class="banner error">${WARN_ICON}<span>${esc(ui.syncError)}</span></div>` : ""}
  ${renderAppPrompts()}
  `;
}

const TABS = [["overview", "Overview", ICONS.overview], ["deepdive", "Detail", ICONS.detail], ["txns", "Transactions", ICONS.txns]];
function renderNav() {
  const nav = appData.months.length ? `
  <nav class="bottom-nav" aria-label="Sections"><div class="bottom-nav-inner">
    ${TABS.map(([key, label, icon]) => `<button class="nav-btn ${ui.tab === key ? "active" : ""}" data-action="set-tab" data-tab="${key}" ${ui.tab === key ? 'aria-current="page"' : ""}>${ICON(icon, 22)}<span>${label}</span></button>`).join("")}
  </div></nav>` : "";
  return `${nav}<button class="fab ${fabHidden ? "hidden" : ""}" data-action="open-add" aria-label="Add data" title="Add data">${ICON(ICONS.plus, 24)}</button>`;
}

// Which sheet shows. Settings and its rules sit over a PDF review, so a key
// can be added mid-import and closing Settings returns to the review.
function renderSheet() {
  let key = null, title = "", body = "", closable = true, back = false;
  if (ui.sheet === "settings") { key = "settings"; title = "Settings"; body = renderSettings(); }
  else if (ui.sheet === "rules" && ui.rulesDraft) { key = "rules"; title = "Transaction rules"; body = renderRules(); }
  else if (ui.sheet === "accounts") { key = "accounts"; title = "Accounts"; body = renderAccounts(); }
  else if (ui.sheet === "suggest" && ui.rulesDraft) { key = "suggest"; title = "Suggested fixed bills"; body = renderSuggestions(); }
  else if (ui.pdfImport) { key = "pdf"; title = "Review PDF import"; body = renderPdfReview(); closable = false; }
  else if (ui.sheet === "add") { key = "add"; title = "Add data"; body = renderAddMenu(); }
  else if (ui.sheet === "paste") { key = "paste"; title = "Paste or upload a table"; body = renderPastePanel(); }
  else if (ui.sheet === "month") { key = "month"; title = "Enter a month by hand"; body = renderAddMonth(); }
  else if (ui.sheet === "statements") { key = "statements"; title = "Statements"; body = renderStatements(); }
  else if (ui.sheet === "review" && appData.months.length) { key = "review"; title = "One-offs to review"; body = renderReview(); }
  else if (ui.sheet === "out" && appData.months.length) { key = "out"; title = `Total out · ${periodLabel(periodMonths().filtered)}`; body = renderOutSheet(); }
  else if (ui.drill.length && appData.months.length) {
    const d = ui.drill[ui.drill.length - 1];
    // The month filter isn't in the key, so picking a month keeps the scroll and skips the animation.
    key = `drill:${ui.drill.length}:${d.kind}:${d.kind === "cat" ? d.cat : d.month}`;
    back = ui.drill.length > 1;
    if (d.kind === "month") { title = `${d.month} · ${BUCKET_LABEL[d.bucket]}`; body = renderMonthDrill(d); }
    else { title = `${d.cat} · ${d.month || periodLabel(periodMonths().filtered)}`; body = renderCatDrill(d); }
  }
  if (!key) return { key: null, html: "" };
  const error = ui.syncError ? `<div class="banner error">${WARN_ICON}<span>${esc(ui.syncError)}</span></div>` : "";
  return { key, html: `
  <div class="sheet-backdrop" ${closable ? 'data-action="close-sheet"' : ""}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><div class="sheet-head-l">${back ? `<button class="icon-btn" data-action="drill-back" aria-label="Back">${ICON(ICONS.back)}</button>` : ""}<h2>${esc(title)}</h2></div>${closable ? `<button class="icon-btn" data-action="close-sheet" aria-label="Close">${ICON(ICONS.close)}</button>` : ""}</div>
      ${error}${body}
    </div>
  </div>` };
}
function renderAddMenu() {
  return `
  <button class="action-row" data-action="trigger-pdf-import">Import statement PDFs<span>UOB account, UOB cards, POSB, DBS cards. Read in this browser; you review rows before saving.</span></button>
  <input type="file" accept="application/pdf,.pdf" multiple id="pdf-file-input" style="display:none">
  <button class="action-row" data-action="trigger-csv-import">Import CSV file<span>Columns: Statement File, Bank, Date, Description, Amount, Type, Category.</span></button>
  <input type="file" accept=".csv,.tsv,text/csv" id="csv-file-input" style="display:none">
  <button class="action-row" data-action="open-sheet" data-sheet="paste">Paste a table<span>Copied straight out of a spreadsheet.</span></button>
  <button class="action-row" data-action="open-sheet" data-sheet="month">Enter a month by hand<span>Totals only, for a month without statements.</span></button>`;
}

const CHECK_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const CROSS_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
function pdfSelectedRows() {
  return ui.pdfImport.files.filter(f => f.include).flatMap(f => f.rows);
}
function renderPdfReview() {
  const st = ui.pdfImport;
  if (st.busy) return `
  <div class="card">
    <p class="card-title" style="border:none;margin-bottom:8px;padding-bottom:0;">Review PDF import</p>
    <p class="paste-help" role="status">${esc(st.progress)}</p>
  </div>`;
  const files = st.files.map((f, i) => {
    if (f.error) return `
    <div class="pdf-file">
      <div class="pdf-head"><input type="checkbox" disabled aria-label="Not importable"><strong>${esc(f.file)}</strong></div>
      <div class="pdf-checks"><div class="pdf-check bad">${CROSS_ICON}<span>${esc(f.error)}</span></div>${f.geminiError ? `<div class="pdf-check bad">${CROSS_ICON}<span>${esc(f.geminiError)}</span></div>` : ""}</div>
      ${f.pages ? renderGeminiOffer(f, i) : ""}
    </div>`;
    const allOk = f.checks.every(c => c.ok);
    const checks = f.checks.map(c => `<div class="pdf-check ${c.ok ? "ok" : "bad"}">${c.ok ? CHECK_ICON : CROSS_ICON}<span>${esc(c.label)}: statement <span class="num">${esc(c.expected)}</span>${c.ok ? "" : `, parsed <span class="num">${esc(c.actual)}</span>`}</span></div>`).join("");
    const table = f.open ? `
      <div class="scroll-x ledger-wrap" style="margin-top:8px;"><table class="ledger">
        <thead><tr><th>Date</th><th>Description</th><th class="r">Amount</th><th>Type</th><th>Category</th></tr></thead>
        <tbody>${f.rows.map(r => `<tr><td>${esc(r.date)}</td><td class="pdf-desc" title="${esc(r.description)}">${esc(r.description)}</td><td class="r">${esc(r.amount.toFixed(2))}</td><td>${esc(r.type)}</td><td class="guess">${esc(classifyOpex(r.description))}</td></tr>`).join("")}</tbody>
      </table></div>` : "";
    return `
    <div class="pdf-file">
      <label class="pdf-head"><input type="checkbox" data-action="pdf-toggle-file" data-idx="${i}" ${f.include ? "checked" : ""}><strong>${esc(f.file)}</strong></label>
      <div class="pdf-meta">${esc((f.accounts || []).map(a => (appData.accounts[a.id] || a).name).join(", ") || f.label)}${f.readBy === "gemini" ? ` <span class="pdf-tag" title="${esc(f.model)}">Read by Gemini</span>` : ""} &middot; statement ${esc(f.statementDate)} &middot; ${f.rows.length} row${f.rows.length !== 1 ? "s" : ""}${allOk ? "" : " &middot; <strong>totals don't match, so it's unticked</strong>"}</div>
      <div class="pdf-checks">${checks}</div>
      <button class="btn small ghost" data-action="pdf-toggle-rows" data-idx="${i}" style="margin-top:8px;">${f.open ? "Hide rows" : "Show rows"}</button>
      ${table}
    </div>`;
  }).join("");
  const rows = pdfSelectedRows();
  const plan = rows.length ? planImport(rows) : null;
  const summary = plan ? `
    <p class="paste-help" style="margin:12px 0 0;">Updates <strong>${esc(plan.monthKeys.join(", "))}</strong>. Rows from these files replace earlier copies of the same rows${plan.replaced ? ` (${plan.replaced} found)` : ""}; everything else in those months is kept.${plan.manual.length ? ` <strong>${esc(plan.manual.join(", "))}</strong> ${plan.manual.length > 1 ? "were" : "was"} entered by hand and will be rebuilt from these statements.` : ""}</p>` : "";
  return `
  <div class="card">
    <p class="card-title" style="border:none;margin-bottom:8px;padding-bottom:0;">Review PDF import</p>
    <p class="paste-help">Each file's rows are checked against the statement's own totals. Categories are guessed at import, as with CSV.${st.files.some(f => f.readBy === "gemini") ? " Check rows read by Gemini closely: a model can misread a statement." : ""}</p>
    ${files}
    ${summary}
    <div class="btn-row">
      <button class="btn primary" data-action="pdf-commit" ${rows.length ? "" : "disabled"}>Import ${rows.length} row${rows.length !== 1 ? "s" : ""}</button>
      <button class="btn ghost" data-action="pdf-cancel">Cancel</button>
    </div>
  </div>`;
}

// Shown on a file no built-in parser knows. Nothing is sent without a tap,
// and the first tap only shows the consent note.
function renderGeminiOffer(f, i) {
  if (f.geminiBusy) return `<p class="pdf-consent" role="status">Reading with Gemini… this can take up to a minute.</p>`;
  if (!DuitGemini.loadKeys().gemini) return `
      <button class="btn small" data-action="open-settings" style="margin-top:8px;">Add a Gemini key in Settings to read it</button>`;
  if (f.askConsent) return `
      <p class="pdf-consent">${GEMINI_CONSENT_TEXT}</p>
      <div class="btn-row" style="margin:8px 0 0 24px;">
        <button class="btn small primary" data-action="pdf-gemini-consent" data-idx="${i}">I agree, send it</button>
        <button class="btn small ghost" data-action="pdf-gemini-cancel" data-idx="${i}">Cancel</button>
      </div>`;
  return `
      <button class="btn small" data-action="pdf-gemini" data-idx="${i}" style="margin-top:8px;">Read with Gemini</button>`;
}
const GEMINI_CONSENT_TEXT = `<strong>This sends the statement's text to Google.</strong> On Gemini's free tier, Google may use it to improve its products (<a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener">terms</a>). Turning on billing for your key stops that. You'll only be asked once on this device.`;

function renderSettings() {
  const key = DuitGemini.loadKeys().gemini;
  const test = ui.keyTest;
  return `
  <div class="card" id="settings-card">
    <p class="card-title" style="border:none;margin-bottom:8px;padding-bottom:0;">Settings</p>
    <p class="paste-help"><strong>Gemini API key</strong>: reads statement PDFs the built-in parsers don't know, only when you tap "Read with Gemini". The key is kept in this browser only, never in your ledger data or sync. Get one free from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>.</p>
    <p class="paste-help" style="margin-top:0;">Saved key: <span class="num">${esc(DuitGemini.maskKey(key))}</span></p>
    <div class="key-row">
      <input type="password" id="gemini-key-input" aria-label="Gemini API key" placeholder="${key ? "Paste a new key to replace it" : "Paste your Gemini API key"}" autocomplete="off" spellcheck="false">
      <button class="btn primary" data-action="save-key">Save key</button>
    </div>
    <div class="btn-row">
      <button class="btn" data-action="test-key" ${key ? "" : "disabled"}>Test key</button>
      <button class="btn ghost" data-action="clear-key" ${key ? "" : "disabled"}>Clear key</button>
      <button class="btn ghost" data-action="copy-setup-link" ${key ? "" : "disabled"}>Copy setup link (secret)</button>
    </div>
    ${test ? `<p class="paste-help" role="status" style="margin:8px 0 0;">${test.busy ? "Testing…" : `${test.ok ? "Works" : "Failed"}: ${esc(test.message)}`}</p>` : ""}
    <p class="paste-help" style="margin:12px 0 0;">The setup link carries your key, so treat it like a password. Opening it on another device saves the key there and removes it from the address bar. Anyone holding it can spend your key.</p>
    <p class="paste-help" style="margin:8px 0 0;">${DuitGemini.hasConsent() ? "You've agreed to send statement text to Google on this device." : "You'll be asked before any statement text is first sent to Google."}</p>
  </div>
  <div class="section-label">Rules</div>
  <button class="action-row" data-action="open-rules">Transaction rules<span>Fixed bills, salary, one-offs, card payments and transfers.</span></button>
  <button class="action-row" data-action="open-sheet" data-sheet="accounts">Accounts<span>Rename your accounts and cards, or hide ones you've closed.</span></button>
  ${renderDataSettings()}`;
}

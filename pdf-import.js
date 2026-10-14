/* Duit Bijak: bank statement PDF import.
   Everything here runs in this browser. The PDF is read with a copy of pdf.js
   served from this site (vendor/), and nothing is sent anywhere.

   One parser per statement layout (POSB/DBS deposit, UOB account, DBS cards,
   UOB cards). Each works on text lines rebuilt from pdf.js text positions and
   returns rows in the app's import shape plus checks against the statement's
   own totals, so a misread shows up before anything is saved. */
(function (root) {
"use strict";

const PDFJS_BASE = "vendor/pdfjs-4.10.38/";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const AMOUNT_RE = /^-?[\d,]*\d\.\d\d(\s*CR)?$/i;
const DAY_MON_RE = /^(\d{1,2}) ([A-Za-z]{3})$/;
const DAY_MON_LEAD_RE = /^(\d{1,2}) ([A-Za-z]{3})\s+(.+)$/;
// Wrapped description lines sit ~8pt apart; the next row is 15pt+ away.
const CONTINUATION_GAP = 14;
const LINE_TOLERANCE = 2.5;

/* ---------------------------- loading pdf.js ---------------------------- */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    const base = new URL(PDFJS_BASE, document.baseURI).href;
    pdfjsPromise = import(base + "pdf.min.mjs").then(lib => {
      lib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
      return lib;
    }).catch(err => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

/* ---------------------------- text extraction ---------------------------- */
// onPassword(retry) returns the password, or null/"" to skip the file.
async function extractPages(pdfjs, data, onPassword) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  let skipped = false;
  task.onPassword = (update, reason) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    Promise.resolve(onPassword ? onPassword(retry) : null).then(pw => {
      if (pw) update(pw); else { skipped = true; task.destroy(); }
    });
  };
  let doc;
  try { doc = await task.promise; }
  catch (err) { if (skipped) throw new Error("Skipped: no password given."); throw err; }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ str: it.str.trim(), x: it.transform[4], xr: it.transform[4] + it.width, y: it.transform[5] }));
    pages.push(toLines(items));
  }
  await doc.destroy();
  return pages;
}

function toLines(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  sorted.forEach(it => {
    const line = lines[lines.length - 1];
    if (line && line.y - it.y <= LINE_TOLERANCE) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  });
  lines.forEach(l => {
    l.items.sort((a, b) => a.x - b.x);
    l.text = l.items.map(i => i.str).join(" ");
  });
  return lines;
}

/* ---------------------------- helpers ---------------------------- */
const cents = s => Math.round(parseFloat(String(s).replace(/[,\s]|CR$/gi, "")) * 100) * (/CR$/i.test(String(s).trim()) ? -1 : 1);
const isAmount = it => AMOUNT_RE.test(it.str);
const monthIdx = mon => MONTHS.findIndex(m => m.toLowerCase() === String(mon).toLowerCase());
const fmtCents = c => (c < 0 ? "-" : "") + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Statements print "DD Mon" with no year. A month after the statement month
// belongs to the year before (December charges on a January card statement).
function fullDate(day, mon, ctx) {
  const mi = monthIdx(mon);
  const year = mi > ctx.month ? ctx.year - 1 : ctx.year;
  return `${String(day).padStart(2, "0")} ${MONTHS[mi]} ${year}`;
}
function statementContext(text, re, label) {
  const m = text.match(re);
  if (!m || monthIdx(m[2]) === -1) throw new Error(`Couldn't find the ${label} on this statement.`);
  return { year: Number(m[3]), month: monthIdx(m[2]), label: `${m[1].padStart(2, "0")} ${MONTHS[monthIdx(m[2])]} ${m[3]}` };
}
// A row starts with a "DD Mon" date, either as its own item or leading one.
function leadingDate(line) {
  const first = line.items[0];
  if (!first) return null;
  let m = first.str.match(DAY_MON_RE);
  if (m && monthIdx(m[2]) !== -1) return { day: m[1], mon: m[2], rest: line.items.slice(1) };
  m = first.str.match(DAY_MON_LEAD_RE);
  if (m && monthIdx(m[2]) !== -1) return { day: m[1], mon: m[2], rest: [{ ...first, str: m[3] }].concat(line.items.slice(1)) };
  return null;
}
function itemByText(line, re) { return line.items.find(i => re.test(i.str)); }
function lastAmount(line) { const a = line.items.filter(isAmount); return a.length ? a[a.length - 1] : null; }
// Description is whatever sits left of the amounts. Card statements print "CR" as its own item.
function descriptionOf(items) { return items.filter(i => !isAmount(i) && !/^CR$/i.test(i.str)).map(i => i.str).join(" ").replace(/\s+/g, " ").trim(); }
function check(label, expected, actual) { return { label, expected: fmtCents(expected), actual: fmtCents(actual), ok: expected === actual }; }

// Tracks the row being built so wrapped description lines join it.
function continuation(state, line, descX) {
  const cur = state.cur;
  if (!cur) return false;
  const gap = state.lastY - line.y;
  if (gap <= 0 || gap > CONTINUATION_GAP) return false;
  if (line.items[0].x < descX - 4 || line.items.some(isAmount)) return false;
  state.lastY = line.y;
  if (/^Ref No\.?\s*:|^REF NO:/i.test(line.text)) return true;
  cur.description = (cur.description + " " + line.text).replace(/\s+/g, " ").trim();
  return true;
}

/* ---------------------------- bank accounts ---------------------------- */
// Columns are told apart by where each amount ends, against the header's
// right edges. The Total row and the balances then prove the split.
function nearestColumn(item, cols) {
  let best = null, bestD = Infinity;
  Object.entries(cols).forEach(([k, xr]) => { const d = Math.abs(item.xr - xr); if (d < bestD) { bestD = d; best = k; } });
  return best;
}
function bankAccountChecks(accounts, name) {
  const checks = [];
  Object.values(accounts).forEach(a => {
    const tag = Object.keys(accounts).length > 1 ? ` (${a.no})` : "";
    if (a.totalW != null) checks.push(check(`Withdrawals total${tag}`, a.totalW, a.sumW));
    if (a.totalD != null) checks.push(check(`Deposits total${tag}`, a.totalD, a.sumD));
    if (a.opening != null && a.closing != null) checks.push(check(`Closing balance${tag}`, a.closing, a.opening + a.sumD - a.sumW));
  });
  if (!checks.length) checks.push({ label: `${name} totals not found`, expected: "—", actual: "—", ok: false });
  return checks;
}

function parseBankTable(pages, opts) {
  const accounts = {}, rows = [];
  let acct = null, cols = null, descX = 0, inTable = false;
  const state = { cur: null, lastY: 0 };
  pages.forEach(lines => {
    inTable = false; state.cur = null;
    lines.forEach(line => {
      const t = line.text;
      const a = opts.account(line);
      if (a) { acct = accounts[a] = accounts[a] || { no: a, opening: null, closing: null, totalW: null, totalD: null, sumW: 0, sumD: 0 }; return; }
      const hw = itemByText(line, opts.headW), hd = itemByText(line, opts.headD), hb = itemByText(line, opts.headB);
      if (hw && hd && hb) {
        cols = { w: hw.xr, d: hd.xr, b: hb.xr };
        const hDesc = itemByText(line, opts.headDesc);
        descX = hDesc ? hDesc.x : hw.x / 3;
        inTable = true; state.cur = null; return;
      }
      if (!inTable || !acct) return;
      if (opts.stop.test(t)) { inTable = false; state.cur = null; return; }
      const amounts = line.items.filter(i => isAmount(i) && i.x > descX);
      const byCol = {};
      amounts.forEach(i => { byCol[nearestColumn(i, cols)] = cents(i.str); });
      if (opts.opening.test(t)) { if (acct.opening == null && byCol.b != null) acct.opening = byCol.b; state.cur = null; return; }
      if (opts.closing && opts.closing.test(t)) { if (byCol.b != null) acct.closing = byCol.b; inTable = false; state.cur = null; return; }
      if (opts.total.test(line.items[0].str)) {
        if (byCol.w != null) acct.totalW = byCol.w;
        if (byCol.d != null) acct.totalD = byCol.d;
        if (byCol.b != null && opts.closingOnTotal) acct.closing = byCol.b;
        state.cur = null; return;
      }
      const d = leadingDate(line);
      if (d && (byCol.w != null || byCol.d != null)) {
        const isDr = byCol.w != null;
        const amt = isDr ? byCol.w : byCol.d;
        if (isDr) acct.sumW += amt; else acct.sumD += amt;
        state.cur = { date: fullDate(d.day, d.mon, opts.ctx), description: descriptionOf(d.rest), amount: amt / 100, type: isDr ? "DR" : "CR" };
        rows.push(state.cur); state.lastY = line.y;
        return;
      }
      if (!continuation(state, line, descX)) state.cur = null;
    });
  });
  return { rows, checks: bankAccountChecks(accounts, opts.name) };
}

function parseDbsDeposit(pages, text) {
  const ctx = statementContext(text, /As at (\d{1,2}) ([A-Za-z]{3}) (\d{4})/, "statement date");
  const bank = /Details of Your POSB/.test(text) ? "POSB" : "DBS";
  const res = parseBankTable(pages, {
    ctx, name: bank,
    account: line => { const m = line.text.match(/^Details of Your .+?Account No\.:\s*([\d-]+)/); return m && m[1]; },
    headW: /^WITHDRAWAL/, headD: /^DEPOSIT/, headB: /^BALANCE/, headDesc: /^DETAILS OF TRANSACTIONS/,
    opening: /^Balance Brought Forward/, closing: /^Balance Carried Forward/, total: /^Total$/,
    stop: /^PDS_|^Message For You/,
  });
  return { bank, stmtType: "POSB", label: `${bank} account`, statementDate: ctx.label, ...res };
}

function parseUobAccount(pages, text) {
  const ctx = statementContext(text, /Period:.*?to (\d{1,2}) ([A-Za-z]{3}) (\d{4})/, "statement period");
  const res = parseBankTable(pages, {
    ctx, name: "UOB",
    account: line => { const m = line.text.match(/^[A-Za-z][A-Za-z ]*Account (\d{3}-\d{3}-\d{3}-\d)( \(continued\))?$/); return m && m[1]; },
    headW: /^Withdrawals$/, headD: /^Deposits$/, headB: /^Balance$/, headDesc: /^Description$/,
    opening: /BALANCE B\/F/, closing: null, total: /^Total$/, closingOnTotal: true,
    stop: /End of Transaction Details|^Page \d+ of \d+/,
  });
  return { bank: "UOB", stmtType: "UOB One", label: "UOB account", statementDate: ctx.label, ...res };
}

/* ---------------------------- credit cards ---------------------------- */
function cardChecks(cards, grand, grandLabel) {
  const checks = cards.map(c => check(`${c.name} balance`, c.total == null ? NaN : c.total, c.prev - c.cr + c.dr));
  checks.forEach((c, i) => { if (cards[i].total == null) { c.expected = "not found"; c.ok = false; } });
  if (grand != null) checks.push(check(grandLabel, grand, cards.reduce((s, c) => s + (c.total || 0), 0)));
  if (!cards.length) checks.push({ label: "No card sections found", expected: "—", actual: "—", ok: false });
  return checks;
}
function addCardRow(state, card, d, line, ctx) {
  const amt = lastAmount(line);
  if (!amt) return false;
  const crItem = line.items.find(i => /^CR$/i.test(i.str) && i.x >= amt.x);
  const signed = cents(amt.str) * (crItem ? -1 : 1);
  if (signed < 0) card.cr -= signed; else card.dr += signed;
  state.cur = { date: fullDate(d.day, d.mon, ctx), description: descriptionOf(d.rest), amount: Math.abs(signed) / 100, type: signed < 0 ? "CR" : "DR" };
  state.lastY = line.y;
  return state.cur;
}

function parseDbsCard(pages, text) {
  const ctx = statementContext(text, /STATEMENT DATE[\s\S]*?(\d{1,2}) ([A-Za-z]{3}) (\d{4})/, "statement date");
  const cards = [], rows = [];
  let card = null, descX = 90, grand = null, done = false;
  const state = { cur: null, lastY: 0 };
  pages.forEach(lines => {
    state.cur = null;
    lines.forEach(line => {
      if (done) return;
      const t = line.text;
      const hDesc = /^DATE DESCRIPTION/.test(t) && itemByText(line, /^DESCRIPTION$/);
      if (hDesc) { descX = hDesc.x; return; }
      const cm = t.match(/^(.*?)\s*CARD NO\.:\s*([\d ]+)$/);
      if (cm) { card = { name: cm[1].trim() || cm[2].trim(), prev: 0, cr: 0, dr: 0, total: null }; cards.push(card); state.cur = null; return; }
      if (/GRAND TOTAL FOR ALL CARD ACCOUNTS/.test(t)) { const a = lastAmount(line); if (a) grand = cents(a.str); done = true; return; }
      if (!card) return;
      if (/^PREVIOUS BALANCE/.test(t)) { const a = lastAmount(line); if (a) card.prev = cents(a.str) * (/CR$/i.test(t) ? -1 : 1); state.cur = null; return; }
      if (line.items[0].str === "TOTAL:") { const a = lastAmount(line); if (a) card.total = cents(a.str) * (/CR$/i.test(t) ? -1 : 1); card = null; state.cur = null; return; }
      if (/SUB-TOTAL:/.test(t)) { state.cur = null; return; }
      const d = leadingDate(line);
      if (d) { const row = addCardRow(state, card, d, line, ctx); if (row) { rows.push(row); return; } }
      if (!continuation(state, line, descX)) state.cur = null;
    });
  });
  return { bank: "DBS", stmtType: "DBS CC", label: "DBS cards", statementDate: ctx.label, rows, checks: cardChecks(cards, grand, "Grand total for all cards") };
}

function parseUobCard(pages, text) {
  const ctx = statementContext(text, /Statement Date\s+(\d{1,2}) ([A-Za-z]{3}) (\d{4})/i, "statement date");
  const amountToPay = text.match(/Amount to Pay\s+SGD\s+([\d,]+\.\d\d)/);
  const cards = {}, order = [], rows = [];
  let card = null, descX = 140, inTable = false, done = false, pendingTotal = false;
  const state = { cur: null, lastY: 0 };
  pages.forEach(lines => {
    inTable = false; state.cur = null;
    lines.forEach(line => {
      if (done) return;
      const t = line.text;
      if (/End of Transaction Details/.test(t)) { done = true; return; }
      const cm = line.items[0].str.match(/^(\d{4}-\d{4}-\d{4}-\d{4})/);
      if (cm) {
        if (!cards[cm[1]]) { cards[cm[1]] = { name: cm[1], prev: 0, cr: 0, dr: 0, total: null }; order.push(cm[1]); }
        card = cards[cm[1]]; inTable = false; state.cur = null;
        return;
      }
      if (/^Post Trans Description/.test(t)) {
        const h = itemByText(line, /^Description/);
        if (h) descX = h.x;
        inTable = true; state.cur = null; return;
      }
      if (!inTable || !card) return;
      if (/^PREVIOUS BALANCE/.test(t)) { const a = lastAmount(line); if (a) card.prev = cents(a.str); state.cur = null; return; }
      // "TOTAL BALANCE FOR <card name>" labels the card's checks; its amount can land on the next line.
      if (/^TOTAL BALANCE FOR /.test(t)) {
        card.label = t.replace(/^TOTAL BALANCE FOR /, "").replace(/\s+[\d,]+\.\d\d.*$/, "");
        const a = lastAmount(line);
        if (a) card.total = cents(a.str); else pendingTotal = true;
        state.cur = null; return;
      }
      if (pendingTotal) { const a = lastAmount(line); if (a && line.items.length === 1) { card.total = cents(a.str); pendingTotal = false; return; } pendingTotal = false; }
      if (/^SUB TOTAL/.test(t)) { state.cur = null; return; }
      if (/^Please note that you are bound|^United Overseas Bank Limited/.test(t)) { inTable = false; state.cur = null; return; }
      const d = leadingDate(line);
      if (d) {
        // Post date, then transaction date. The transaction date is the one that counts.
        const d2 = leadingDate({ items: d.rest });
        const row = addCardRow(state, card, d2 || d, line, ctx);
        if (row) { rows.push(row); return; }
      }
      if (!continuation(state, line, descX)) state.cur = null;
    });
  });
  const list = order.map(k => ({ ...cards[k], name: cards[k].label || cards[k].name }));
  return { bank: "UOB", stmtType: "UOB Card", label: "UOB cards", statementDate: ctx.label, rows, checks: cardChecks(list, amountToPay ? cents(amountToPay[1]) : null, "Amount to pay") };
}

/* ---------------------------- entry points ---------------------------- */
const PARSERS = [
  { test: t => /Details of Your (POSB|DBS)/.test(t), parse: parseDbsDeposit },
  { test: t => /CARD NO\.:/.test(t) && /DBS Cards/.test(t), parse: parseDbsCard },
  { test: t => /TOTAL BALANCE FOR|Credit Card\(s\) Statement/.test(t) && /United Overseas Bank|UOB/.test(t), parse: parseUobCard },
  { test: t => /Account Transaction Details/.test(t) && /United Overseas Bank|UOB/.test(t), parse: parseUobAccount },
];

// pages: arrays of lines from extractPages (or a test fixture). Returns
// { file, bank, stmtType, label, statementDate, rows, checks } or { file, error }.
function parseStatement(pages, fileName) {
  const text = pages.map(lines => lines.map(l => l.text).join("\n")).join("\n");
  const parser = PARSERS.find(p => p.test(text));
  if (!parser) return { file: fileName, error: "Not a statement layout this app knows (UOB account, UOB cards, POSB, DBS cards)." };
  try {
    const res = parser.parse(pages, text);
    if (!res.rows.length) return { file: fileName, error: `Read this as a ${res.label} statement, but found no transactions.` };
    res.rows = res.rows.map(r => ({ file: fileName, bank: res.bank, date: r.date, description: r.description, amount: r.amount, type: r.type, category: "", stmtType: res.stmtType }));
    return { file: fileName, ...res };
  } catch (err) {
    return { file: fileName, error: err.message };
  }
}

async function parsePdf(pdfjs, data, fileName, onPassword) {
  let pages;
  try { pages = await extractPages(pdfjs, data, onPassword); }
  catch (err) { return { file: fileName, error: /Skipped/.test(err.message) ? err.message : `Couldn't open this PDF (${err.message}).` }; }
  return parseStatement(pages, fileName);
}

const api = { loadPdfjs, extractPages, toLines, parseStatement, parsePdf };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitPdfImport = api;
})(typeof self !== "undefined" ? self : this);

/* Duit Bijak: Gemini fallback for statement layouts the built-in parsers
   don't know (pdf-import.js). Opt-in and per file: nothing is sent until the
   user taps "Read with Gemini" and has agreed to the one-time consent note.

   What leaves the browser: the statement's text lines (not the PDF), sent to
   Google's Gemini API with the user's own key. The key lives in this
   browser's localStorage under KEYS_STORE only. It is never part of the
   ledger data, sync, exports or logs, and never goes in a URL.

   The model's answer is treated as untrusted: every row is checked in code,
   and the statement's own totals must reconcile before the file is ticked. */
(function (root) {
"use strict";

const pdfImport = typeof module === "object" && module.exports ? require("./pdf-import.js") : root.DuitPdfImport;
const { check, MONTHS, finishStatement } = pdfImport;

// All model ids live here. Logic never names a model. Tried top to bottom;
// the next model runs on 429, 5xx, network errors, timeouts and bad JSON.
// Any other 4xx (bad key, bad request) stops the chain.
const CONFIG = {
  endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
  chain: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
  timeoutMs: 60000,
};
const KEYS_STORE = "duit-bijak.keys";
const CONSENT_STORE = "duit-bijak.geminiConsent";

/* ---------------------------- keys ---------------------------- */
// Parses "#setup?gemini=..." into { gemini }. Null when it isn't a setup link.
function parseSetupFragment(hash) {
  if (!hash || !hash.startsWith("#setup")) return null;
  const params = new URLSearchParams(hash.slice("#setup".length).replace(/^[?&]/, ""));
  const gemini = (params.get("gemini") || "").trim();
  return gemini ? { gemini } : null;
}
function buildSetupLink(baseUrl, keys) {
  const params = new URLSearchParams();
  if (keys.gemini) params.set("gemini", keys.gemini);
  return `${baseUrl.split("#")[0]}#setup?${params.toString()}`;
}
function loadKeys(storage) {
  try { return JSON.parse((storage || root.localStorage).getItem(KEYS_STORE)) || {}; }
  catch (e) { return {}; }
}
function saveKeys(keys, storage) {
  const clean = {};
  if (keys.gemini) clean.gemini = String(keys.gemini).trim();
  (storage || root.localStorage).setItem(KEYS_STORE, JSON.stringify(clean));
  return clean;
}
function clearKeys(storage) { (storage || root.localStorage).removeItem(KEYS_STORE); }
function maskKey(k) {
  if (!k) return "not set";
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}
function hasConsent(storage) {
  try { return (storage || root.localStorage).getItem(CONSENT_STORE) === "1"; } catch (e) { return false; }
}
function giveConsent(storage) { (storage || root.localStorage).setItem(CONSENT_STORE, "1"); }

/* ---------------------------- request ---------------------------- */
const money = { type: "NUMBER", nullable: true };
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    bank: { type: "STRING" },
    accountKind: { type: "STRING", enum: ["account", "card"] },
    statementDate: { type: "STRING", description: "YYYY-MM-DD" },
    currency: { type: "STRING", description: "ISO 4217 code, e.g. SGD" },
    accountLast4: { type: "STRING", nullable: true, description: "Last 4 digits of the account or card number. Null if not printed." },
    openingBalance: { ...money, description: "Account: balance brought forward. Card: previous balance, negative if in credit. Null if not printed." },
    closingBalance: { ...money, description: "Account: balance carried forward. Null if not printed." },
    statementTotal: { ...money, description: "Card: total balance or amount due as printed. Null if not printed." },
    rows: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          date: { type: "STRING", description: "YYYY-MM-DD" },
          description: { type: "STRING" },
          amount: { type: "NUMBER", description: "Positive" },
          type: { type: "STRING", enum: ["DR", "CR"] },
          accountLast4: { type: "STRING", nullable: true, description: "Last 4 digits of the account or card this row is listed under, when the statement covers several. Else null." },
        },
        required: ["date", "description", "amount", "type"],
      },
    },
  },
  required: ["bank", "accountKind", "statementDate", "currency", "rows"],
};

const SYSTEM_PROMPT = [
  "You read one bank or credit card statement, given as text lines from its PDF, and return its transactions as JSON.",
  "Rules:",
  "- One row per transaction. Join wrapped description lines into one description.",
  "- Leave out balance brought/carried forward, previous balance, sub-totals, totals and summary lines. They are not transactions.",
  "- date is YYYY-MM-DD. If the statement prints no year, take it from the statement date; a month after the statement month belongs to the year before.",
  "- amount is always positive. type is DR for money out (withdrawals, purchases, fees, charges) and CR for money in (deposits, payments to the card, refunds).",
  "- accountKind is \"card\" for a credit or charge card statement, else \"account\".",
  "- currency is the statement's own currency as an ISO code.",
  "- accountLast4 is the last 4 digits of the account or card number as printed. On a statement covering several cards or accounts, set it on each row for the one the row is listed under.",
  "- Copy openingBalance, closingBalance and statementTotal exactly as printed. Never compute them. Use null when not printed.",
  "- Copy numbers exactly. Do not invent or guess transactions.",
].join("\n");

// pages: arrays of lines from DuitPdfImport.extractPages.
function statementText(pages) {
  return pages.map((lines, i) => `--- Page ${i + 1} ---\n` + lines.map(l => l.text).join("\n")).join("\n\n");
}

function buildRequest(model, text, key) {
  return {
    url: `${CONFIG.endpoint}/${encodeURIComponent(model)}:generateContent`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0 },
      }),
    },
  };
}

/* ---------------------------- errors ---------------------------- */
class GeminiError extends Error {
  constructor(message, opts) {
    super(message);
    this.status = (opts && opts.status) || 0;
    this.retryable = !!(opts && opts.retryable);
  }
}
function httpError(status, detail) {
  return new GeminiError(`HTTP ${status}${detail ? `: ${detail}` : ""}`, { status, retryable: status === 429 || status >= 500 });
}

/* ---------------------------- response ---------------------------- */
// Joins the answer's text parts, skipping thinking parts. Bad output is
// retryable: the next model may do better.
function extractText(json) {
  const cand = json && json.candidates && json.candidates[0];
  if (!cand) {
    const reason = json && json.promptFeedback && json.promptFeedback.blockReason;
    throw new GeminiError(reason ? `Blocked: ${reason}` : "No answer returned", { retryable: true });
  }
  const text = ((cand.content && cand.content.parts) || [])
    .filter(p => typeof p.text === "string" && !p.thought)
    .map(p => p.text).join("");
  if (!text) throw new GeminiError(`Empty answer (${cand.finishReason || "unknown"})`, { retryable: true });
  return text;
}
function parseJson(text) {
  let obj;
  try { obj = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
  catch (e) { throw new GeminiError("Answer was not valid JSON", { retryable: true }); }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.rows)) throw new GeminiError("Answer had no rows list", { retryable: true });
  return obj;
}

// "2027-01-31" -> "31 Jan 2027", the app's date format. Null if not a real date.
function isoToApp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]} ${MONTHS[mo - 1]} ${m[1]}`;
}
const toCents = n => Math.round(n * 100);
const isMoney = v => typeof v === "number" && isFinite(v);

const last4Of = v => (typeof v === "string" && /^\d{4}$/.test(v.trim()) ? v.trim() : null);

// Checks every row. Returns { rows, dropped }: rows in the app's shape
// (amount rounded to cents), and the reasons for any row that failed.
function validateRows(raw) {
  const rows = [], dropped = [];
  raw.forEach((r, i) => {
    const why = [];
    const date = r && isoToApp(r.date);
    if (!date) why.push("bad date");
    const description = r && typeof r.description === "string" ? r.description.replace(/\s+/g, " ").trim() : "";
    if (!description) why.push("no description");
    if (!r || !isMoney(r.amount) || toCents(r.amount) <= 0) why.push("bad amount");
    if (!r || (r.type !== "DR" && r.type !== "CR")) why.push("bad type");
    if (why.length) { dropped.push(`Row ${i + 1}: ${why.join(", ")}`); return; }
    // A bad number is dropped, not the row: it only decides which account.
    rows.push({ date, description, amount: toCents(r.amount) / 100, type: r.type, number: last4Of(r.accountLast4) });
  });
  return { rows, dropped };
}

// Totals the model copied from the statement against the rows it listed.
// Missing totals fail: a model's rows are never trusted unchecked.
function statementChecks(obj, rows, dropped) {
  const dr = rows.filter(r => r.type === "DR").reduce((s, r) => s + toCents(r.amount), 0);
  const cr = rows.filter(r => r.type === "CR").reduce((s, r) => s + toCents(r.amount), 0);
  const checks = [];
  if (obj.accountKind === "card") {
    // A card's total includes the previous balance, so it counts when printed.
    const prev = isMoney(obj.openingBalance) ? toCents(obj.openingBalance) : 0;
    if (isMoney(obj.statementTotal)) checks.push(check("Statement total", toCents(obj.statementTotal), prev + dr - cr));
  } else if (isMoney(obj.openingBalance) && isMoney(obj.closingBalance)) {
    checks.push(check("Closing balance", toCents(obj.closingBalance), toCents(obj.openingBalance) + cr - dr));
  }
  if (!checks.length) checks.push({ label: "No statement totals to verify against", expected: "—", actual: "—", ok: false });
  if (dropped.length) checks.push({ label: `Rows dropped as unreadable (${dropped.join("; ")})`, expected: "0", actual: String(dropped.length), ok: false });
  return checks;
}

// The model's JSON -> parseStatement's shape, or { file, error }.
function toStatement(obj, fileName, model) {
  const currency = String(obj.currency || "").trim().toUpperCase();
  if (currency !== "SGD") return { file: fileName, error: `This statement is in ${currency || "an unknown currency"}. Only SGD statements can be imported for now.` };
  const kind = obj.accountKind === "card" ? "card" : obj.accountKind === "account" ? "account" : null;
  if (!kind) return { file: fileName, error: "Gemini couldn't tell whether this is an account or a card statement." };
  const statementDate = isoToApp(obj.statementDate);
  if (!statementDate) return { file: fileName, error: "Gemini returned no valid statement date." };
  const bank = (typeof obj.bank === "string" && obj.bank.trim().slice(0, 40)) || "Other";
  const { rows, dropped } = validateRows(obj.rows);
  if (!rows.length) return { file: fileName, error: "Gemini found no transactions on this statement." };
  // Rows without a number take the statement's, or the one number the
  // other rows agree on, so a single card doesn't split in two.
  const top = last4Of(obj.accountLast4);
  const seen = [...new Set(rows.map(r => r.number).filter(Boolean))];
  const fallback = top || (seen.length === 1 ? seen[0] : null);
  const appKind = kind === "card" ? "card" : "bank";
  return {
    ...finishStatement(fileName, {
      bank, kind: appKind, label: `${bank} ${kind}`, statementDate,
      rows: rows.map(r => ({ ...r, number: r.number || fallback })),
      numbers: top ? [top] : [],
      checks: statementChecks({ ...obj, accountKind: kind }, rows, dropped),
    }),
    readBy: "gemini", model,
  };
}

/* ---------------------------- calling ---------------------------- */
async function callModel(model, text, key, opts) {
  const fetchFn = opts.fetchFn || root.fetch.bind(root);
  const { url, init } = buildRequest(model, text, key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || CONFIG.timeoutMs);
  let res;
  try { res = await fetchFn(url, { ...init, signal: ctrl.signal }); }
  catch (e) {
    throw new GeminiError(e && e.name === "AbortError" ? "Timed out" : `Network error: ${(e && e.message) || e}`, { retryable: true });
  } finally { clearTimeout(timer); }
  let json = null;
  try { json = await res.json(); } catch (e) { /* handled below */ }
  if (!res.ok) throw httpError(res.status, json && json.error && json.error.message);
  if (!json) throw new GeminiError("Response was not JSON", { retryable: true });
  return parseJson(extractText(json));
}

// Walks the model chain. Returns parseStatement's shape, or { file, error }.
// error never contains the key: only status codes and Google's message.
async function parseWithGemini(pages, fileName, key, opts) {
  opts = opts || {};
  if (!key) return { file: fileName, error: "Add a Gemini key in Settings first." };
  const text = statementText(pages);
  const failures = [];
  for (const model of opts.chain || CONFIG.chain) {
    try {
      return toStatement(await callModel(model, text, key, opts), fileName, model);
    } catch (e) {
      failures.push(`${model}: ${e.message}`);
      if (!(e instanceof GeminiError) || !e.retryable) break;
    }
  }
  return { file: fileName, error: `Gemini couldn't read this statement. ${failures.join(". ")}.` };
}

// Checks the key against the primary model's metadata. No tokens spent.
async function testKey(key, opts) {
  opts = opts || {};
  const model = CONFIG.chain[0];
  const fetchFn = opts.fetchFn || root.fetch.bind(root);
  try {
    const res = await fetchFn(`${CONFIG.endpoint}/${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": key } });
    let json = null;
    try { json = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) return { ok: false, message: `${model}: ${httpError(res.status, json && json.error && json.error.message).message}` };
    return { ok: true, message: `Key works with ${model}.` };
  } catch (e) {
    return { ok: false, message: `Network error: ${(e && e.message) || e}` };
  }
}

const api = {
  CONFIG, KEYS_STORE, CONSENT_STORE, RESPONSE_SCHEMA,
  parseSetupFragment, buildSetupLink, loadKeys, saveKeys, clearKeys, maskKey, hasConsent, giveConsent,
  statementText, buildRequest, extractText, validateRows, statementChecks, toStatement, parseWithGemini, testKey, GeminiError,
};
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitGemini = api;
})(typeof self !== "undefined" ? self : this);

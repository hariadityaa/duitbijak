// Gemini fallback tests with a fake fetch: no network, no key, no deps.
// Run: node tests/gemini-parse.test.js
"use strict";
const assert = require("assert");
const G = require("../gemini-parse.js");
const { toLines, parseStatement } = require("../pdf-import.js");

const KEY = "AIzaFAKEKEY1234567890";
const pages = [toLines([{ str: "Some Other Bank SGD statement", x: 50, xr: 200, y: 700 }])];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A fetch that answers each call in turn and records what it was sent.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers[calls.length - 1];
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
  };
  fn.calls = calls;
  return fn;
}
const answer = obj => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: JSON.stringify(obj) }] }, finishReason: "STOP" }] } });
const account = {
  bank: "Test Bank", accountKind: "account", statementDate: "2027-01-31", currency: "SGD",
  openingBalance: 1000, closingBalance: 1029.9, statementTotal: null,
  rows: [
    { date: "2027-01-03", description: "Salary", amount: 50.1, type: "CR" },
    { date: "2027-01-05", description: "  Coffee   shop ", amount: 20.2, type: "DR" },
  ],
};
const card = {
  bank: "Test Card", accountKind: "card", statementDate: "2027-02-10", currency: "SGD",
  openingBalance: 500, closingBalance: null, statementTotal: 120.5,
  rows: [
    { date: "2027-01-28", description: "Payment thank you", amount: 500, type: "CR" },
    { date: "2027-02-01", description: "Groceries", amount: 100.25, type: "DR" },
    { date: "2027-02-02", description: "Taxi", amount: 20.25, type: "DR" },
  ],
};

test("unknown layout error is marked so the fallback can offer itself", () => {
  const res = parseStatement(pages, "x.pdf");
  assert(res.unknownLayout && /Not a statement layout/.test(res.error));
});

test("request: key in header only, native endpoint, schema, temperature 0", async () => {
  const f = fakeFetch([answer(account)]);
  await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f });
  const { url, init, body } = f.calls[0];
  assert.strictEqual(url, `${G.CONFIG.endpoint}/${G.CONFIG.chain[0]}:generateContent`);
  assert(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//.test(url));
  assert(!url.includes(KEY) && !/key=/.test(url), "key must not be in the URL");
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.headers["x-goog-api-key"], KEY);
  assert(!init.body.includes(KEY), "key must not be in the body");
  assert.strictEqual(body.generationConfig.responseMimeType, "application/json");
  assert.strictEqual(body.generationConfig.temperature, 0);
  assert.deepStrictEqual(body.generationConfig.responseSchema, G.RESPONSE_SCHEMA);
  assert.deepStrictEqual(G.RESPONSE_SCHEMA.properties.rows.items.properties.type.enum, ["DR", "CR"]);
  assert.deepStrictEqual(G.RESPONSE_SCHEMA.properties.accountKind.enum, ["account", "card"]);
  assert(body.contents[0].parts[0].text.includes("Some Other Bank SGD statement"), "sends the page text");
  assert(!/openai/i.test(url));
});

test("account: same shape as parseStatement, closing balance check passes", async () => {
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: fakeFetch([answer(account)]) });
  assert.ifError(res.error);
  assert.strictEqual(res.kind, "bank");
  assert.strictEqual(res.source, "bank-testbank");
  assert.strictEqual(res.statementDate, "31 Jan 2027");
  assert.strictEqual(res.readBy, "gemini");
  assert.deepStrictEqual(Object.keys(res).sort(), ["accounts", "bank", "checks", "file", "kind", "label", "model", "readBy", "rows", "source", "statementDate"]);
  // No number printed: one account with none, not a guess.
  assert.deepStrictEqual(res.accounts.map(a => [a.id, a.name]), [["bank-testbank", "Test Bank account"]]);
  assert.deepStrictEqual(res.rows[1], { file: "a.pdf", bank: "Test Bank", date: "05 Jan 2027", description: "Coffee shop", amount: 20.2, type: "DR", category: "", account: "bank-testbank" });
  // 1000.00 + 50.10 - 20.20 = 1029.90, in cents so no float drift.
  assert.deepStrictEqual(res.checks, [{ label: "Closing balance", expected: "1,029.90", actual: "1,029.90", ok: true }]);
});

test("account: a wrong closing balance fails the check", async () => {
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: fakeFetch([answer({ ...account, closingBalance: 1030 })]) });
  assert.strictEqual(res.checks[0].ok, false);
  assert.strictEqual(res.checks[0].actual, "1,029.90");
});

test("card: previous balance + DR - CR = statement total", async () => {
  const res = await G.parseWithGemini(pages, "c.pdf", KEY, { fetchFn: fakeFetch([answer(card)]) });
  assert.strictEqual(res.source, "card-testcard");
  assert.strictEqual(res.rows[0].date, "28 Jan 2027");
  assert.deepStrictEqual(res.checks, [{ label: "Statement total", expected: "120.50", actual: "120.50", ok: true }]);
  // No previous balance printed: plain DR - CR.
  const noPrev = G.statementChecks({ accountKind: "card", statementTotal: -379.5 }, G.validateRows(card.rows).rows, []);
  assert.deepStrictEqual(noPrev.map(c => c.ok), [true]);
});

test("account numbers: statement-wide, per row, and bad ones dropped", async () => {
  assert.strictEqual(G.RESPONSE_SCHEMA.properties.accountLast4.nullable, true);
  assert(G.RESPONSE_SCHEMA.properties.rows.items.properties.accountLast4);
  const one = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: fakeFetch([answer({ ...account, accountLast4: "4321" })]) });
  assert.deepStrictEqual(one.accounts.map(a => a.name), ["Test Bank account ·4321"]);
  assert(one.rows.every(r => r.account === "bank-testbank-4321"));
  // Two cards on one statement; a row with no number takes the statement's.
  const rows = card.rows.map((r, i) => ({ ...r, accountLast4: ["1111", "2222", null][i] }));
  const two = await G.parseWithGemini(pages, "c.pdf", KEY, { fetchFn: fakeFetch([answer({ ...card, accountLast4: "1111", rows })]) });
  assert.deepStrictEqual(two.accounts.map(a => a.id), ["card-testcard-1111", "card-testcard-2222"]);
  assert.deepStrictEqual(two.rows.map(r => r.account), ["card-testcard-1111", "card-testcard-2222", "card-testcard-1111"]);
  // One number across rows, none at the top: the other rows join it.
  const lone = card.rows.map((r, i) => ({ ...r, accountLast4: i === 1 ? "7777" : null }));
  const three = await G.parseWithGemini(pages, "c.pdf", KEY, { fetchFn: fakeFetch([answer({ ...card, rows: lone })]) });
  assert.deepStrictEqual(three.accounts.map(a => a.id), ["card-testcard-7777"]);
  // A malformed number keeps the row, without a number.
  const bad = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: fakeFetch([answer({ ...account, accountLast4: "12x4" })]) });
  assert.strictEqual(bad.rows.length, 2);
  assert.deepStrictEqual(bad.accounts.map(a => a.id), ["bank-testbank"]);
});

test("no totals: one failing check, never an auto-pass", async () => {
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: fakeFetch([answer({ ...account, openingBalance: null, closingBalance: null })]) });
  assert.deepStrictEqual(res.checks.map(c => [c.label, c.ok]), [["No statement totals to verify against", false]]);
  const c = G.statementChecks({ accountKind: "card", statementTotal: null }, [], []);
  assert.deepStrictEqual(c.map(x => [x.label, x.ok]), [["No statement totals to verify against", false]]);
});

test("row validation drops bad rows and flags them", () => {
  const { rows, dropped } = G.validateRows([
    { date: "2027-02-30", description: "Bad day", amount: 1, type: "DR" },
    { date: "2027-02-01", description: "", amount: 1, type: "DR" },
    { date: "2027-02-01", description: "Negative", amount: -5, type: "DR" },
    { date: "2027-02-01", description: "Text amount", amount: "5.00", type: "DR" },
    { date: "2027-02-01", description: "Bad type", amount: 5, type: "DEBIT" },
    { date: "01 Feb 2027", description: "Wrong date format", amount: 5, type: "CR" },
    null,
    { date: "2027-02-01", description: "Good", amount: 5.01, type: "CR" },
  ]);
  assert.strictEqual(dropped.length, 7);
  assert.deepStrictEqual(rows, [{ date: "01 Feb 2027", description: "Good", amount: 5.01, type: "CR", number: null }]);
  const checks = G.statementChecks({ accountKind: "account", openingBalance: 0, closingBalance: 5.01 }, rows, dropped);
  assert.deepStrictEqual(checks.map(c => c.ok), [true, false], "dropped rows fail the file");
});

test("non-SGD statements are rejected", async () => {
  const res = await G.parseWithGemini(pages, "u.pdf", KEY, { fetchFn: fakeFetch([answer({ ...account, currency: "usd" })]) });
  assert(res.error && /USD/.test(res.error) && /Only SGD/.test(res.error));
});

test("falls back to flash-lite on 429", async () => {
  const f = fakeFetch([{ status: 429, json: { error: { message: "Quota" } } }, answer(account)]);
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f });
  assert.ifError(res.error);
  assert.deepStrictEqual(f.calls.map(c => c.url.split("/").pop()), G.CONFIG.chain.map(m => `${m}:generateContent`));
  assert.strictEqual(res.model, G.CONFIG.chain[1]);
});

test("falls back on 5xx, network error and bad JSON", async () => {
  for (const first of [{ status: 503, json: null }, new Error("offline"), { status: 200, json: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } }]) {
    const f = fakeFetch([first, answer(account)]);
    const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f });
    assert.ifError(res.error);
    assert.strictEqual(f.calls.length, 2);
  }
});

test("falls back on timeout", async () => {
  let n = 0;
  const f = (url, init) => (++n === 1
    ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))
    : Promise.resolve({ ok: true, status: 200, json: async () => answer(account).json }));
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f, timeoutMs: 20 });
  assert.ifError(res.error);
  assert.strictEqual(n, 2);
});

test("stops on 401 and doesn't leak the key", async () => {
  const f = fakeFetch([{ status: 401, json: { error: { message: "API key not valid." } } }, answer(account)]);
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f });
  assert.strictEqual(f.calls.length, 1);
  assert(/HTTP 401/.test(res.error) && /API key not valid/.test(res.error));
  assert(!res.error.includes(KEY));
});

test("all models failing returns an error", async () => {
  const f = fakeFetch([{ status: 429, json: null }, { status: 500, json: null }]);
  const res = await G.parseWithGemini(pages, "a.pdf", KEY, { fetchFn: f });
  assert(/couldn't read/.test(res.error) && /HTTP 429/.test(res.error) && /HTTP 500/.test(res.error));
});

test("keys: setup link round trip, storage, mask", () => {
  const store = {};
  const storage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const link = G.buildSetupLink("https://x.github.io/duitbijak/#old", { gemini: KEY });
  assert.strictEqual(link, `https://x.github.io/duitbijak/#setup?gemini=${KEY}`);
  assert.deepStrictEqual(G.parseSetupFragment(link.slice(link.indexOf("#"))), { gemini: KEY });
  assert.strictEqual(G.parseSetupFragment("#overview"), null);
  assert.strictEqual(G.parseSetupFragment("#setup?gemini="), null);
  G.saveKeys({ gemini: ` ${KEY} ` }, storage);
  assert.deepStrictEqual(Object.keys(store), ["duit-bijak.keys"]);
  assert.strictEqual(G.loadKeys(storage).gemini, KEY);
  assert.strictEqual(G.maskKey(KEY), "AIza••••7890");
  assert.strictEqual(G.hasConsent(storage), false);
  G.giveConsent(storage);
  assert.strictEqual(G.hasConsent(storage), true);
  G.clearKeys(storage);
  assert.deepStrictEqual(G.loadKeys(storage), {});
});

test("test key: header only, reports status", async () => {
  const f = fakeFetch([{ status: 200, json: { name: "models/x" } }, { status: 400, json: { error: { message: "API key not valid." } } }]);
  assert.strictEqual((await G.testKey(KEY, { fetchFn: f })).ok, true);
  const bad = await G.testKey(KEY, { fetchFn: f });
  assert(!bad.ok && /400/.test(bad.message));
  f.calls.forEach(c => { assert(!c.url.includes(KEY)); assert.strictEqual(c.init.headers["x-goog-api-key"], KEY); });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); }
    catch (err) { failed++; console.log("FAIL " + name + "\n     " + err.message); }
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
})();

// Statement coverage tests on made-up records. Run: node tests/statements.test.js
"use strict";
const assert = require("assert");
const { coverage, recentIssues, recordFromImport, supersededBy, inferRecords, parseDate } = require("../statements.js");
const { makeAccount } = require("../accounts.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const at = s => parseDate(s);
// source is kind-bank, as accounts.js builds it: bank-posb, card-dbs.
const rec = (source, statementDate, extra) => recordFromImport({ source, bank: "X", kind: source.split("-")[0], accounts: [], file: `${source} ${statementDate}.pdf`, statementDate, rows: [{}], checks: [{ ok: true }], ...extra }, "2026-01-01T00:00:00Z");
const tx = (account, date, file) => ({ account, date, file: file || null, description: "x", withdrawal: 1 });

test("import record is keyed by source, statement month and account numbers", () => {
  const r = rec("card-dbs", "12 Sep 2026");
  assert.strictEqual(r.month, "Sep 2026");
  assert.strictEqual(r.id, "card-dbs|Sep_2026");
  assert.strictEqual(r.source, "card-dbs");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(rec("card-dbs", "12 Sep 2026", { checks: [{ ok: true }, { ok: false }] }).ok, false);
  assert.strictEqual(recordFromImport({ source: "bank-posb", statementDate: "bad", rows: [], checks: [] }), null);
  const two = rec("card-dbs", "12 Sep 2026", { accounts: [makeAccount("DBS", "card", "0009"), makeAccount("DBS", "card", "0001")] });
  assert.strictEqual(two.id, "card-dbs|Sep_2026|0001+0009");
  assert.deepStrictEqual(two.accounts, ["card-dbs-0009", "card-dbs-0001"]);
});

test("a re-import supersedes the same file and pre-number records, not another statement", () => {
  const legacy = { id: "card-dbs|Sep_2026", source: "card-dbs", month: "Sep 2026", file: "old.pdf", accounts: [] };
  const other = { id: "card-dbs|Sep_2026|5555", source: "card-dbs", month: "Sep 2026", file: "joint.pdf", accounts: ["card-dbs-5555"] };
  const sameFile = { id: "card-dbs|Sep_2026|0001", source: "card-dbs", month: "Sep 2026", file: "new.pdf", accounts: ["card-dbs-0001"] };
  const otherMonth = { id: "card-dbs|Aug_2026", source: "card-dbs", month: "Aug 2026", file: "aug.pdf", accounts: [] };
  const fresh = rec("card-dbs", "12 Sep 2026", { file: "new.pdf", accounts: [makeAccount("DBS", "card", "0001"), makeAccount("DBS", "card", "0009")] });
  assert.deepStrictEqual(supersededBy([legacy, other, sameFile, otherMonth, fresh], fresh), [legacy.id, sameFile.id]);
});

test("gap between two statements, due after the latest", () => {
  const cov = coverage([rec("bank-posb", "31 Jul 2026"), rec("bank-posb", "30 Sep 2026")], [], at("14 Nov 2026"));
  const row = cov.cells["bank-posb"];
  assert.strictEqual(row["Jul 2026"].state, "ok");
  assert.strictEqual(row["Aug 2026"].state, "gap");
  // Oct's statement (30 Oct) is past its 7-day grace; Nov's isn't issued yet.
  assert.strictEqual(row["Oct 2026"].state, "due");
  assert.ok(!row["Nov 2026"]);
  assert.deepStrictEqual(cov.months, ["Nov 2026", "Oct 2026", "Sep 2026", "Aug 2026", "Jul 2026"]);
  assert.ok(cov.accounts[0].overdue);
  assert.strictEqual(cov.accounts[0].nextDue, Date.UTC(2026, 10, 30));
});

test("not overdue inside the grace period", () => {
  const cov = coverage([rec("card-dbs", "12 Sep 2026")], [], at("18 Oct 2026"));
  assert.ok(!cov.cells["card-dbs"]["Oct 2026"]);
  assert.ok(!cov.accounts[0].overdue);
  assert.strictEqual(coverage([rec("card-dbs", "12 Sep 2026")], [], at("20 Oct 2026")).cells["card-dbs"]["Oct 2026"].state, "due");
});

test("statement date on the 31st clamps to short months", () => {
  const cov = coverage([rec("bank-uob", "31 Jan 2026")], [], at("08 Mar 2026"));
  assert.strictEqual(cov.cells["bank-uob"]["Feb 2026"].state, "due");
  assert.strictEqual(cov.accounts[0].nextDue, Date.UTC(2026, 2, 31));
});

test("totals mismatch shows as warn", () => {
  const cov = coverage([rec("card-uob", "20 Sep 2026", { checks: [{ ok: false }] })], [], at("01 Oct 2026"));
  assert.strictEqual(cov.cells["card-uob"]["Sep 2026"].state, "warn");
});

test("inferred from transactions: by file, then by calendar month", () => {
  const months = [
    // Two cards on one statement file are one inferred statement.
    { transactions: [tx("card-dbs-0001", "14 Aug 2026", "a.pdf"), tx("card-dbs-0009", "10 Sep 2026", "a.pdf")] },
    // A legacy statement type still infers, as its source.
    { transactions: [tx("bank-posb", "03 Jul 2026"), tx("POSB", "29 Jul 2026"), tx("bank-posb-2223", "02 Aug 2026")] },
    { transactions: [tx("Unknown", "02 Aug 2026")] },
  ];
  const got = inferRecords(months, []).map(r => `${r.source} ${r.month} ${r.rows}`).sort();
  assert.deepStrictEqual(got, ["bank-posb Aug 2026 1", "bank-posb Jul 2026 2", "card-dbs Sep 2026 2"]);
});

test("saved records beat inferred ones, and their files aren't inferred again", () => {
  const months = [{ transactions: [tx("card-dbs-0001", "30 Sep 2026", "card-dbs 02 Oct 2026.pdf"), tx("card-dbs", "10 Aug 2026", "old.pdf")] }];
  const cov = coverage([rec("card-dbs", "02 Oct 2026")], months, at("05 Oct 2026"));
  const row = cov.cells["card-dbs"];
  assert.strictEqual(row["Oct 2026"].state, "ok");
  assert.strictEqual(row["Sep 2026"].state, "gap");
  assert.strictEqual(row["Aug 2026"].state, "inferred");
});

test("rows: bank accounts first, then cards, each by bank; hidden sources left out", () => {
  const recs = [rec("card-uob", "01 Sep 2026"), rec("card-citi", "01 Sep 2026"), rec("bank-uob", "01 Sep 2026"), rec("bank-posb", "01 Sep 2026")];
  assert.deepStrictEqual(coverage(recs, [], at("02 Sep 2026")).accounts.map(a => a.name), ["bank-posb", "bank-uob", "card-citi", "card-uob"]);
  const cov = coverage(recs, [], at("02 Oct 2026"), { hidden: s => s === "card-citi" });
  assert.deepStrictEqual(cov.accounts.map(a => a.name), ["bank-posb", "bank-uob", "card-uob"]);
  assert(!cov.issues.some(x => x.account === "card-citi"));
});

test("two statements from one source in a month: one cell, the worse state", () => {
  const a = rec("bank-posb", "31 Aug 2026", { accounts: [makeAccount("POSB", "bank", "1111")] });
  const b = rec("bank-posb", "31 Aug 2026", { accounts: [makeAccount("POSB", "bank", "2222")], checks: [{ ok: false }] });
  const cov = coverage([a, b], [], at("01 Sep 2026"));
  assert.strictEqual(cov.accounts.length, 1);
  assert.strictEqual(cov.cells["bank-posb"]["Aug 2026"].state, "warn");
});

test("recent issues keep everything due, but only recent gaps", () => {
  const cov = coverage([rec("bank-posb", "31 Jan 2026"), rec("bank-posb", "31 Mar 2026"), rec("bank-posb", "31 Jul 2026"), rec("bank-posb", "31 Aug 2026")], [], at("14 Oct 2026"));
  assert.deepStrictEqual(cov.issues.map(x => `${x.kind} ${x.month}`), ["gap Feb 2026", "gap Apr 2026", "gap May 2026", "gap Jun 2026", "due Sep 2026"]);
  assert.deepStrictEqual(recentIssues(cov, at("14 Oct 2026")).map(x => x.month), ["Sep 2026"]);
});

test("no data, no accounts", () => {
  assert.deepStrictEqual(coverage([], [], at("01 Jan 2026")), { accounts: [], months: [], cells: {}, issues: [] });
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
});
if (failed) { console.log(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

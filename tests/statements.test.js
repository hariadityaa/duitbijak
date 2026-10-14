// Statement coverage tests on made-up records. Run: node tests/statements.test.js
"use strict";
const assert = require("assert");
const { coverage, recentIssues, recordFromImport, inferRecords, parseDate } = require("../statements.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const at = s => parseDate(s);
const rec = (account, statementDate, extra) => recordFromImport({ stmtType: account, bank: "X", label: account, file: `${account} ${statementDate}.pdf`, statementDate, rows: [{}], checks: [{ ok: true }], ...extra }, "2026-01-01T00:00:00Z");
const tx = (account, date, file) => ({ account, date, file: file || null, description: "x", withdrawal: 1 });

test("import record is keyed by account and statement month", () => {
  const r = rec("DBS CC", "12 Sep 2026");
  assert.strictEqual(r.month, "Sep 2026");
  assert.strictEqual(r.id, "DBS_CC|Sep_2026");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(rec("DBS CC", "12 Sep 2026", { checks: [{ ok: true }, { ok: false }] }).ok, false);
  assert.strictEqual(recordFromImport({ stmtType: "POSB", statementDate: "bad", rows: [], checks: [] }), null);
});

test("Gemini statements are named by their label, not Other", () => {
  assert.strictEqual(rec("Other card", "05 Sep 2026", { label: "Citi card" }).account, "Citi card");
});

test("gap between two statements, due after the latest", () => {
  const cov = coverage([rec("POSB", "31 Jul 2026"), rec("POSB", "30 Sep 2026")], [], at("14 Nov 2026"));
  const row = cov.cells.POSB;
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
  const cov = coverage([rec("DBS CC", "12 Sep 2026")], [], at("18 Oct 2026"));
  assert.ok(!cov.cells["DBS CC"]["Oct 2026"]);
  assert.ok(!cov.accounts[0].overdue);
  assert.strictEqual(coverage([rec("DBS CC", "12 Sep 2026")], [], at("20 Oct 2026")).cells["DBS CC"]["Oct 2026"].state, "due");
});

test("statement date on the 31st clamps to short months", () => {
  const cov = coverage([rec("UOB One", "31 Jan 2026")], [], at("08 Mar 2026"));
  assert.strictEqual(cov.cells["UOB One"]["Feb 2026"].state, "due");
  assert.strictEqual(cov.accounts[0].nextDue, Date.UTC(2026, 2, 31));
});

test("totals mismatch shows as warn", () => {
  const cov = coverage([rec("UOB Card", "20 Sep 2026", { checks: [{ ok: false }] })], [], at("01 Oct 2026"));
  assert.strictEqual(cov.cells["UOB Card"]["Sep 2026"].state, "warn");
});

test("inferred from transactions: by file, then by calendar month", () => {
  const months = [
    { transactions: [tx("DBS CC", "14 Aug 2026", "a.pdf"), tx("DBS CC", "10 Sep 2026", "a.pdf")] },
    { transactions: [tx("POSB", "03 Jul 2026"), tx("POSB", "29 Jul 2026"), tx("POSB", "02 Aug 2026")] },
    { transactions: [tx("Unknown", "02 Aug 2026")] },
  ];
  const got = inferRecords(months, []).map(r => `${r.account} ${r.month} ${r.rows}`).sort();
  assert.deepStrictEqual(got, ["DBS CC Sep 2026 2", "POSB Aug 2026 1", "POSB Jul 2026 2"]);
});

test("saved records beat inferred ones, and their files aren't inferred again", () => {
  const months = [{ transactions: [tx("DBS CC", "30 Sep 2026", "DBS CC 02 Oct 2026.pdf"), tx("DBS CC", "10 Aug 2026", "old.pdf")] }];
  const cov = coverage([rec("DBS CC", "02 Oct 2026")], months, at("05 Oct 2026"));
  const row = cov.cells["DBS CC"];
  assert.strictEqual(row["Oct 2026"].state, "ok");
  assert.strictEqual(row["Sep 2026"].state, "gap");
  assert.strictEqual(row["Aug 2026"].state, "inferred");
});

test("accounts sort in the known order, then by name", () => {
  const cov = coverage([rec("UOB Card", "01 Sep 2026"), rec("Other card", "01 Sep 2026", { label: "Citi card" }), rec("UOB One", "01 Sep 2026")], [], at("02 Sep 2026"));
  assert.deepStrictEqual(cov.accounts.map(a => a.name), ["UOB One", "UOB Card", "Citi card"]);
});

test("recent issues keep everything due, but only recent gaps", () => {
  const cov = coverage([rec("POSB", "31 Jan 2026"), rec("POSB", "31 Mar 2026"), rec("POSB", "31 Jul 2026"), rec("POSB", "31 Aug 2026")], [], at("14 Oct 2026"));
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

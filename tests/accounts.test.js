// Account ids, names, the legacy migration and re-import matching, on
// made-up data. Run: node tests/accounts.test.js
"use strict";
const assert = require("assert");
const A = require("../accounts.js");
const { coverage, parseDate } = require("../statements.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tx = (account, date, desc, amt, extra) => ({ date, account, description: desc, withdrawal: amt, deposit: null, category: null, file: null, ...extra });

test("ids, kinds, sources and default names", () => {
  assert.strictEqual(A.last4("111-22222-3"), "2223");
  assert.strictEqual(A.last4("4000 0000 0000 0001"), "0001");
  assert.strictEqual(A.last4("12"), null);
  const a = A.makeAccount("POSB", "bank", "2223");
  assert.deepStrictEqual(a, { id: "bank-posb-2223", bank: "POSB", kind: "bank", number: "2223", name: "POSB account ·2223" });
  assert.strictEqual(A.makeAccount("Standard Chartered", "card", null).id, "card-standardchartered");
  assert.strictEqual(A.makeAccount("Standard Chartered", "card", null).name, "Standard Chartered card");
  assert.strictEqual(A.kindOf("card-dbs-0001"), "card");
  assert.strictEqual(A.kindOf("bank-uob"), "bank");
  assert.strictEqual(A.kindOf("DBS CC"), "card");
  assert.strictEqual(A.kindOf("Unknown"), null);
  assert.strictEqual(A.sourceOf("card-dbs-0001"), "card-dbs");
  assert.strictEqual(A.sourceOf("UOB One"), "bank-uob");
});

test("names: renamed account, source label, hidden source, unknown id", () => {
  let reg = A.register({}, [A.makeAccount("DBS", "card", "0001"), A.makeAccount("DBS", "card", "0009")]).registry;
  assert.strictEqual(A.sourceName("card-dbs", reg), "DBS cards");
  reg["card-dbs-0009"] = { ...reg["card-dbs-0009"], name: "Wife's card", hidden: true };
  // One visible account left: the row takes its name.
  assert.strictEqual(A.sourceName("card-dbs", reg), "DBS card ·0001");
  assert.strictEqual(A.accountName("card-dbs-0009", reg), "Wife's card");
  assert.strictEqual(A.sourceHidden("card-dbs", reg), false);
  reg["card-dbs-0001"] = { ...reg["card-dbs-0001"], hidden: true };
  assert.strictEqual(A.sourceHidden("card-dbs", reg), true);
  // Not in the registry yet (a synced row): a name from the id, never blank.
  assert.strictEqual(A.accountName("bank-uob-7776", {}), "UOB account ·7776");
  // register keeps names already set.
  const again = A.register(reg, [A.makeAccount("DBS", "card", "0009")]);
  assert.strictEqual(again.added.length, 0);
  assert.strictEqual(again.registry["card-dbs-0009"].name, "Wife's card");
});

// Saved data as the app stored it before accounts: stmtType strings on
// transactions, records keyed by stmtType or Gemini label.
function legacyData() {
  return {
    months: [
      { month: "Aug 2026", cardSpend: 70, transactions: [
        tx("UOB One", "01 Aug 2026", "GIRO SALA", null, { deposit: 5000, withdrawal: null }),
        tx("POSB", "03 Aug 2026", "PAYLAH TOP UP", 20),
        tx("DBS CC", "05 Aug 2026", "SHOP A", 40, { category: "Groceries", file: "dbs-aug.pdf" }),
        tx("UOB Card", "06 Aug 2026", "CAFE 123", 10, { category: "Dining" }),
        tx("Other card", "07 Aug 2026", "CITI THING", 20, { file: "citi-aug.pdf" }),
        tx("Unknown", "08 Aug 2026", "MYSTERY", 1),
      ] },
      { month: "Jul 2026", cardSpend: 0, transactions: [] },
    ],
    statements: {
      "DBS_CC|Aug_2026": { id: "DBS_CC|Aug_2026", account: "DBS CC", stmtType: "DBS CC", bank: "DBS", statementDate: "12 Aug 2026", month: "Aug 2026", file: "dbs-aug.pdf", rows: 1, ok: true, importedAt: "2026-08-13T00:00:00Z" },
      "Citi_card|Aug_2026": { id: "Citi_card|Aug_2026", account: "Citi card", stmtType: "Other card", bank: "Citi", statementDate: "20 Aug 2026", month: "Aug 2026", file: "citi-aug.pdf", rows: 1, ok: false, importedAt: "2026-08-21T00:00:00Z" },
    },
    accounts: {},
  };
}

test("migrate: transactions get accounts, categories and totals untouched", () => {
  const before = legacyData();
  const res = A.migrate(before);
  assert(res.changed);
  const aug = res.months[0].transactions;
  assert.deepStrictEqual(aug.map(t => t.account), ["bank-uob", "bank-posb", "card-dbs", "card-uob", "card-citi", "Unknown"]);
  assert.deepStrictEqual(aug.map(t => t.category), [null, null, "Groceries", "Dining", null, null]);
  assert.strictEqual(res.months[0].cardSpend, 70);
  assert.strictEqual(res.months[1], before.months[1], "months with nothing legacy are left as they are");
  assert.deepStrictEqual(res.changedMonths, ["Aug 2026"]);
  assert.deepStrictEqual(Object.keys(res.accounts).sort(), ["bank-posb", "bank-uob", "card-citi", "card-dbs", "card-uob"]);
  assert.strictEqual(res.accounts["card-citi"].name, "Citi card");
  assert.strictEqual(res.accounts["bank-uob"].name, "UOB account");
  // Input not mutated.
  assert.strictEqual(before.months[0].transactions[0].account, "UOB One");
});

test("migrate: statement records re-keyed by source, nothing else lost", () => {
  const res = A.migrate(legacyData());
  assert.deepStrictEqual(Object.keys(res.statements).sort(), ["card-citi|Aug_2026", "card-dbs|Aug_2026"]);
  assert.deepStrictEqual(res.removedStatements.sort(), ["Citi_card|Aug_2026", "DBS_CC|Aug_2026"]);
  const dbs = res.statements["card-dbs|Aug_2026"];
  assert.deepStrictEqual(
    { source: dbs.source, file: dbs.file, ok: dbs.ok, rows: dbs.rows, statementDate: dbs.statementDate, importedAt: dbs.importedAt, accounts: dbs.accounts },
    { source: "card-dbs", file: "dbs-aug.pdf", ok: true, rows: 1, statementDate: "12 Aug 2026", importedAt: "2026-08-13T00:00:00Z", accounts: [] });
  assert.strictEqual(res.statements["card-citi|Aug_2026"].ok, false);
  // The tracker reads the migrated records as one row per source.
  const cov = coverage(Object.values(res.statements), res.months, parseDate("25 Aug 2026"));
  assert.deepStrictEqual(cov.accounts.map(a => a.name), ["bank-posb", "bank-uob", "card-citi", "card-dbs", "card-uob"]);
  assert.strictEqual(cov.cells["card-dbs"]["Aug 2026"].state, "ok");
  assert.strictEqual(cov.cells["card-citi"]["Aug 2026"].state, "warn");
});

test("migrate: idempotent, and keeps names already set", () => {
  const once = A.migrate(legacyData());
  once.accounts["card-dbs"] = { ...once.accounts["card-dbs"], name: "Old DBS cards" };
  const twice = A.migrate(once);
  assert.strictEqual(twice.changed, false);
  assert.deepStrictEqual(twice.months, once.months);
  assert.deepStrictEqual(twice.statements, once.statements);
  assert.strictEqual(twice.accounts["card-dbs"].name, "Old DBS cards");
});

test("re-import after migration: rows move to numbered accounts, no duplicates, categories kept", () => {
  const m = A.migrate(legacyData()).months[0];
  // The DBS statement comes back, now read with card numbers. Same file.
  const dbs = [
    { file: "dbs-aug.pdf", date: "05 Aug 2026", description: "SHOP A", amount: 40, type: "DR", category: "", account: "card-dbs-0001" },
    { file: "dbs-aug.pdf", date: "05 Aug 2026", description: "SHOP A", amount: 40, type: "DR", category: "", account: "card-dbs-0009" },
  ];
  const r1 = A.mergeMonth(m.transactions, dbs, new Set(["dbs-aug.pdf"]));
  assert.strictEqual(r1.rows.length, m.transactions.length + 1, "second card's row is new; the old one is replaced, not doubled");
  assert.strictEqual(r1.rows.filter(r => /^card-dbs/.test(r.account)).length, 2);
  assert(!r1.rows.some(r => r.account === "card-dbs"));
  assert.strictEqual(r1.rows.find(r => r.account === "card-dbs-0001").category, "Groceries");
  // A CSV-era UOB card row (no file) matched by description, and by source
  // when the description changed.
  const uob = [
    { file: "uob-aug.pdf", date: "06 Aug 2026", description: "CAFE 456", amount: 10, type: "DR", category: "", account: "card-uob-0002" },
  ];
  const r2 = A.mergeMonth(m.transactions, uob, new Set(["uob-aug.pdf"]));
  assert.strictEqual(r2.rows.length, m.transactions.length);
  assert.strictEqual(r2.replaced, 1);
  assert.strictEqual(r2.rows.find(r => r.account === "card-uob-0002").category, "Dining");
  const renamed = [{ ...uob[0], description: "CAFE SINGAPORE" }];
  const r3 = A.mergeMonth(m.transactions, renamed, new Set(["uob-aug.pdf"]));
  assert.strictEqual(r3.rows.length, m.transactions.length);
  assert.strictEqual(r3.rows.find(r => r.account === "card-uob-0002").category, "Dining");
  // Importing the same file twice changes nothing.
  const r4 = A.mergeMonth(r1.rows.map(r => ({ ...r, withdrawal: r.type === "DR" ? r.amount : null, deposit: r.type === "CR" ? r.amount : null })), dbs, new Set(["dbs-aug.pdf"]));
  assert.strictEqual(r4.rows.length, r1.rows.length);
});

test("re-import: two POSB accounts stay two; a legacy row matches only once", () => {
  const saved = A.migrate({ months: [{ month: "Aug 2026", transactions: [tx("POSB", "03 Aug 2026", "COFFEE", 5)] }], statements: {} }).months[0].transactions;
  const incoming = [
    { file: "posb-aug.pdf", date: "03 Aug 2026", description: "COFFEE", amount: 5, type: "DR", category: "", account: "bank-posb-2223" },
    { file: "posb-aug.pdf", date: "03 Aug 2026", description: "COFFEE", amount: 5, type: "DR", category: "", account: "bank-posb-5556" },
  ];
  const r = A.mergeMonth(saved, incoming, new Set(["posb-aug.pdf"]));
  assert.deepStrictEqual(r.rows.map(x => x.account).sort(), ["bank-posb-2223", "bank-posb-5556"]);
  assert.strictEqual(r.replaced, 1);
  // A card row never matches a bank row on the source tier.
  const card = [{ file: "x.pdf", date: "03 Aug 2026", description: "SOMETHING ELSE", amount: 5, type: "DR", category: "", account: "card-posb-1111" }];
  assert.strictEqual(A.mergeMonth(saved, card, new Set(["x.pdf"])).rows.length, 2);
});

test("record ids sort account numbers and stay safe as doc ids", () => {
  assert.strictEqual(A.recordId("card-dbs", "Sep 2026", ["0009", "0001", null]), "card-dbs|Sep_2026|0001+0009");
  assert.strictEqual(A.recordId("card-dbs", "Sep 2026"), "card-dbs|Sep_2026");
});

test("re-import keeps one-off flags; a CSV match carries flags but not categories", () => {
  const saved = [
    { date: "02 Aug 2026", account: "card-dbs-0001", description: "ACME PC PTE LTD", withdrawal: 2050, deposit: null, category: "Electronics", file: "dbs-aug.pdf", spendType: "asset", life: 24 },
    { date: "10 Aug 2026", account: "card-dbs-0001", description: "ANNUAL FEE", withdrawal: 360, deposit: null, category: "", file: "dbs-aug.pdf", suggestDismissed: true },
  ];
  const incoming = [
    { file: "dbs-aug.pdf", date: "02 Aug 2026", description: "ACME PC PTE LTD", amount: 2050, type: "DR", category: "", account: "card-dbs-0001" },
    { file: "dbs-aug.pdf", date: "10 Aug 2026", description: "ANNUAL FEE", amount: 360, type: "DR", category: "", account: "card-dbs-0001" },
  ];
  const r = A.mergeMonth(saved, incoming, new Set(["dbs-aug.pdf"]));
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].spendType, "asset");
  assert.strictEqual(r.rows[0].life, 24);
  assert.strictEqual(r.rows[1].suggestDismissed, true);
  assert.ok(!("spendType" in r.rows[1]));
  const csv = [{ file: "x", date: "02 Aug 2026", description: "ACME PC PTE LTD", amount: 2050, type: "DR", category: "" }];
  A.matchOldRows(csv, saved.map(A.txToRow), true);
  assert.strictEqual(csv[0].spendType, "asset");
  assert.strictEqual(csv[0].category, "");
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
});
if (failed) { console.log(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

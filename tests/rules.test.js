// Transaction rule tests on made-up rows. Run: node tests/rules.test.js
"use strict";
const assert = require("assert");
const R = require("../rules.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const bank = (type, description) => ({ type, description });

test("plain text matches anywhere, any case, across padded spaces", () => {
  const { re } = R.compilePattern("giro sala");
  assert.ok(re.test("INWARD CR GIRO   SALA ACME PTE"));
  assert.ok(!re.test("GIROSALA"));
  assert.ok(R.compilePattern("BUS/MRT").re.test("bus/mrt 123"), "a slash inside is plain text");
  assert.ok(R.compilePattern("a.b").re.test("A.B") && !R.compilePattern("a.b").re.test("AXB"));
});

test("/…/ is a regex; a bad one reports an error", () => {
  assert.ok(R.compilePattern("/HDB.*LOAN/").re.test("hdb housing loan"));
  assert.strictEqual(R.patternError("/(oops/"), "Not a valid regex");
  assert.strictEqual(R.patternError("  "), "Empty");
  assert.strictEqual(R.patternError("IRAS"), null);
});

test("never saved means defaults; saved lists stay as saved", () => {
  assert.deepStrictEqual(R.normaliseRules(null), R.DEFAULT_RULES);
  const r = R.normaliseRules({ fixedBills: [], salary: [], oneOffCategories: ["Reimbursement", "Renovation", " renovation "] });
  assert.deepStrictEqual(r.fixedBills, []);
  assert.deepStrictEqual(r.salary, []);
  assert.deepStrictEqual(r.oneOffCategories, ["Renovation"], "built-in and duplicates dropped");
  assert.deepStrictEqual(r.cardBillPayments, R.DEFAULT_RULES.cardBillPayments, "a missing list falls back");
});

test("savings: Investment by default; a label in both lists counts as savings", () => {
  assert.deepStrictEqual(R.DEFAULT_RULES.savingsCategories, ["Investment"]);
  const old = R.normaliseRules({ oneOffCategories: ["Internal Transfer", "Investment", "Renovation"] });
  assert.deepStrictEqual(old.oneOffCategories, ["Internal Transfer", "Renovation"], "rules saved before savings move Investment over");
  assert.deepStrictEqual(old.savingsCategories, ["Investment"]);
  const r = R.normaliseRules({ oneOffCategories: ["CPF Top-up"], savingsCategories: ["cpf top-up", "Reimbursement"] });
  assert.deepStrictEqual(r.oneOffCategories, [], "matched in any case");
  assert.deepStrictEqual(r.savingsCategories, ["cpf top-up"], "built-in one-off can't be savings");
  assert.deepStrictEqual(R.normaliseRules({ savingsCategories: [] }).savingsCategories, [], "an emptied list stays empty");
  const c = R.compileRules(null);
  assert.ok(c.isSavings("Investment") && c.isOneOff("Investment"), "savings stays out of op-ex");
  assert.ok(!c.isSavings("Internal Transfer") && c.isOneOff("Internal Transfer"));
});

test("fixed bills need a name and a match, unique by name", () => {
  const r = R.normaliseRules({ fixedBills: [{ name: "Rent", match: "LANDLORD" }, { name: "rent", match: "X" }, { name: "", match: "Y" }, { name: "Gym" }] });
  assert.deepStrictEqual(r.fixedBills, [{ name: "Rent", match: "LANDLORD" }]);
});

test("defaults carry no single person's wording", () => {
  const text = JSON.stringify(R.DEFAULT_RULES);
  ["TMLS", "iFAST", "Renovation", "Family Support", "Salary Payment"].forEach(w => assert.ok(!text.includes(w), w));
});

test("bank rows route in order: transfer, card bill, fixed, income, spend", () => {
  const c = R.compileRules({ fixedBills: [{ name: "Rent", match: "LANDLORD" }], salary: ["SALARY"], cardBillPayments: ["mBK-UOB Cards"], internalTransfers: ["Funds Trf"] });
  assert.deepStrictEqual(R.routeBankTx(bank("CR", "Funds Trf SALARY"), c), { kind: "skip" });
  assert.deepStrictEqual(R.routeBankTx(bank("DR", "mBK-UOB Cards 1234"), c), { kind: "skip" });
  assert.deepStrictEqual(R.routeBankTx(bank("CR", "mBK-UOB Cards refund"), c), { kind: "otherIn" }, "card bill only skips debits");
  assert.deepStrictEqual(R.routeBankTx(bank("DR", "GIRO LANDLORD MAR"), c), { kind: "fixed", name: "Rent" });
  assert.deepStrictEqual(R.routeBankTx(bank("CR", "LANDLORD deposit back"), c), { kind: "otherIn" }, "fixed bills only match debits");
  assert.deepStrictEqual(R.routeBankTx(bank("CR", "ACME SALARY"), c), { kind: "salary" });
  assert.deepStrictEqual(R.routeBankTx(bank("DR", "NTUC FAIRPRICE"), c), { kind: "spend" });
});

test("card rows skip bill payments in either direction", () => {
  const c = R.compileRules(null);
  assert.deepStrictEqual(R.routeCardTx({ type: "CR", description: "PAYMENT - THANK YOU" }, c), { kind: "skip" });
  assert.deepStrictEqual(R.routeCardTx({ type: "DR", description: "GRAB*RIDE" }, c), { kind: "spend" });
});

test("one-off includes the built-in Reimbursement", () => {
  const c = R.compileRules({ oneOffCategories: ["Renovation"] });
  assert.ok(c.isOneOff("Renovation") && c.isOneOff("Reimbursement") && !c.isOneOff("Dining & Food"));
});

test("an invalid saved pattern is ignored, not thrown", () => {
  const c = R.compileRules({ salary: ["/(bad/", "PAY"] });
  assert.ok(c.isSalary("MONTHLY PAY") && !c.isSalary("(bad"));
});

/* ---------------------------- suggestions ---------------------------- */
const dr = (date, description, withdrawal, account) => ({ date, description, withdrawal, account: account || "POSB" });
const isBank = a => a === "POSB";

test("suggests a monthly debit at a steady amount", () => {
  const txs = [
    dr("03 Jan 2026", "INWARD DR - GIRO SINGTEL MOBILE 8812301", 45.1),
    dr("03 Feb 2026", "INWARD DR - GIRO SINGTEL MOBILE 8812302", 47.0),
    dr("04 Mar 2026", "INWARD DR - GIRO SINGTEL MOBILE 8812303", 44.2),
    dr("05 Mar 2026", "NTUC FAIRPRICE 12", 80),
  ];
  const s = R.suggestFixedBills(txs, { fixedBills: [] }, { isBank });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].match, "SINGTEL MOBILE");
  assert.strictEqual(s[0].name, "Singtel Mobile");
  assert.strictEqual(s[0].months, 3);
  assert.strictEqual(s[0].avg, 45.43);
  assert.ok(R.compilePattern(s[0].match).re.test(txs[0].description));
});

test("no suggestion for uneven amounts, too few months, or twice a month", () => {
  const uneven = ["Jan", "Feb", "Mar"].map((m, i) => dr(`01 ${m} 2026`, "GIRO ACME GYM", [50, 50, 80][i]));
  const few = ["Jan", "Feb"].map(m => dr(`01 ${m} 2026`, "GIRO ACME GYM", 50));
  const twice = ["Jan", "Feb", "Mar", "Mar"].map(m => dr(`01 ${m} 2026`, "GIRO ACME GYM", 50));
  [uneven, few, twice].forEach(txs => assert.deepStrictEqual(R.suggestFixedBills(txs, { fixedBills: [] }, { isBank }), []));
});

test("skips rows a rule covers, card rows and credits", () => {
  const months = ["Jan", "Feb", "Mar"];
  const covered = months.map(m => dr(`01 ${m} 2026`, "HDB HOUSING LOAN 99", 1200));
  const card = months.map(m => dr(`01 ${m} 2026`, "NETFLIX.COM", 20, "DBS CC"));
  const credits = months.map(m => ({ date: `01 ${m} 2026`, description: "ACME REBATE", deposit: 10, withdrawal: null, account: "POSB" }));
  assert.deepStrictEqual(R.suggestFixedBills(covered.concat(card, credits), null, { isBank }), []);
});

test("falls back to a regex when no shared plain keyword fits", () => {
  const txs = ["Jan", "Feb", "Mar"].map((m, i) => dr(`02 ${m} 2026`, ["ACME-INSURE POLICY", "ACME INSURE POLICY", "ACME/INSURE POLICY"][i], 99));
  const [s] = R.suggestFixedBills(txs, { fixedBills: [] }, { isBank });
  assert.ok(s.match.startsWith("/"), s.match);
  txs.forEach(t => assert.ok(R.compilePattern(s.match).re.test(t.description)));
  assert.strictEqual(s.name, "Acme Insure");
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
});
if (failed) { console.log(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

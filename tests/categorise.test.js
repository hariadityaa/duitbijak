// Categoriser tests on synthetic descriptions: same shapes as real statement
// lines, made-up merchants, refs and amounts. Run: node tests/categorise.test.js
"use strict";
const assert = require("assert");
const { merchantKey, buildCategoryHistory, classifyOpex, resolveCategory, canonCategory, canonCategoryTotals } = require("../categorise.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("merchant key strips bank prefixes, refs and digits", () => {
  assert.strictEqual(merchantKey("Misc DR-Debit Card 12 JAN 1234 FOO BAR NOODLE HOUSE"), merchantKey("FOO BAR CAFE 0042 SINGAPORE"));
  assert.strictEqual(merchantKey("PAYNOW-FAST PIB2601010000000001 ACME TRADING PTE. LTD. OTHR Transfer"), "ACME TRADING");
  assert.strictEqual(merchantKey("NETS Debit-Consumer ACME FOODS12345678 xxxxxx0000"), "ACME");
  assert.strictEqual(merchantKey("Grab* A-1ABCDEF2GHIJAV Singapore"), "GRAB");
  assert.strictEqual(merchantKey("7 ELEVEN-BLK 100 BEDOK Singapore"), merchantKey("7 ELEVEN-BLK 200 BEDOK Singapore"));
  assert.strictEqual(merchantKey("12345 67890"), "");
});

test("history: latest saved label wins and old labels are folded in", () => {
  const h = buildCategoryHistory([
    { description: "ZEBRA MART 01 SINGAPORE", category: "Groceries" },
    { description: "ZEBRA MART 02 SINGAPORE", category: "Other" },
    { description: "QUOKKA RIDES 9X SINGAPORE", category: "Transport - Ride-Hail" },
    { description: "NO LABEL HERE", category: "" },
  ]);
  assert.strictEqual(h.get("ZEBRA MART"), "Other");
  assert.strictEqual(h.get("QUOKKA RIDES"), "Transport");
  assert.ok(!h.has("NO LABEL"));
});

test("history beats rules, rules fill the gaps", () => {
  const h = buildCategoryHistory([{ description: "SHOPEE SINGAPORE MP", category: "Fashion" }]);
  assert.strictEqual(classifyOpex("SHOPEE SINGAPORE MP", h), "Fashion");
  assert.strictEqual(classifyOpex("SHOPEE SINGAPORE MP"), "Shopping/Online");
  assert.strictEqual(classifyOpex("UNSEEN PLACE 99", h), "Uncategorized");
});

test("pinned 7-Eleven rule beats history and saved labels", () => {
  const h = buildCategoryHistory([{ description: "7-ELEVEN -SOME ST Singapore", category: "Groceries" }]);
  assert.strictEqual(classifyOpex("7-ELEVEN -SOME ST Singapore", h), "Convenience Stores");
  assert.strictEqual(resolveCategory("7 ELEVEN-BLK 1 Singapore", "Groceries", h), "Convenience Stores");
});

test("rules: agreed labels and new merchants", () => {
  const cases = [
    ["BUS/MRT SINGAPORE", "Transport"],
    ["Grab* A-1ABCDEF2GHIJAV Singapore", "Transport"],
    ["Grab Subscription* v4-abcSINGAPORE", "Subscriptions"],
    ["SubscriptionGrab* 1a2b3cSingapore", "Subscriptions"],
    ["PAYMT THRU E-BANK/HOMEB/CYBERB (EP12)", "Credit Card Payment"],
    ["One Bonus Interest", "Interest Income"],
    ["Interest Credit", "Interest Income"],
    ["ESSO CHEERS-SOMEWHERE SINGAPORE", "Convenience Stores"],
    ["PLAYTOMIC SOMEWHERE", "Sports"],
    ["GOOGLE*PLAY PASS g.co/HelpPay#", "Subscriptions"],
    ["www trip com SINGAPORE", "Travel"],
    ["MADEUP THAI EATERY SINGAPORE", "Dining & Food"],
  ];
  cases.forEach(([d, want]) => assert.strictEqual(classifyOpex(d), want, d));
});

test("saved label wins over a guess, and is canonicalised", () => {
  assert.strictEqual(resolveCategory("BUS/MRT SINGAPORE", "Transport - SMRT"), "Transport");
  assert.strictEqual(resolveCategory("SHOPEE SINGAPORE MP", "Home & Furniture"), "Home & Furniture");
  assert.strictEqual(resolveCategory("BUS/MRT SINGAPORE", ""), "Transport");
  assert.strictEqual(canonCategory("Sports/Padel"), "Sports");
  assert.strictEqual(canonCategory("Dining & Food"), "Dining & Food");
});

test("month totals fold old labels together", () => {
  assert.deepStrictEqual(
    canonCategoryTotals({ "Transport - SMRT": 10.1, "Transport - Ride-Hail": 5.2, "Transport": 1, "7-Eleven": 3, "Groceries": 4 }),
    { "Transport": 16.3, "Convenience Stores": 3, "Groceries": 4 });
  assert.strictEqual(canonCategoryTotals(null), null);
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
});
if (failed) { console.log(`${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

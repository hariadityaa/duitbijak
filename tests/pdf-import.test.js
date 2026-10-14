// Parser tests on synthetic statements: same layouts as the real PDFs,
// made-up names, numbers and amounts. Run: node tests/pdf-import.test.js
"use strict";
const assert = require("assert");
const { toLines, parseStatement } = require("../pdf-import.js");

// One page from [y, [[x, text, xRight?], ...]] lines. Right edges default to
// a rough width so only amounts and headers need real ones.
function page(lines) {
  const items = [];
  lines.forEach(([y, cells]) => cells.forEach(([x, str, xr]) => items.push({ str, x, xr: xr == null ? x + str.length * 5 : xr, y })));
  return toLines(items);
}
const keyOf = r => `${r.date}|${r.type}|${r.amount.toFixed(2)}|${r.description}`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("POSB: columns, wrapped descriptions, page breaks, totals", () => {
  const header = [[37, "DATE"], [97, "DETAILS OF TRANSACTIONS"], [313, "WITHDRAWAL($)", 362], [408, "DEPOSIT($)", 442], [485, "BALANCE($)", 521]];
  const p1 = page([
    [702, [[423, "Page 1 of 2"]]],
    [566, [[443, "As at 31 Jan 2027"]]],
    [543, [[37, "Details of Your POSB Everyday Savings Account"], [409, "Account No.: 111-22222-3"]]],
    [523, header],
    [493, [[97, "Balance Brought Forward"], [486, "1,000.00", 521]]],
    [477, [[37, "03 Jan"], [97, "FAST Payment / Receipt"], [419, "50.00", 442], [486, "1,050.00", 521]]],
    [469, [[102, "From: SOMEONE"]]],
    [461, [[102, "Other"]]],
    [445, [[37, "05 Jan"], [97, "Funds Transfer"], [340, "20.00", 362]]],
    [437, [[102, "TOP-UP TO PAYLAH! :"]]],
    [421, [[37, "05 Jan"], [97, "HDB Housing Loan"], [335, "300.00", 362], [486, "730.00", 521]]],
    [46, [[97, "Balance Carried Forward"], [486, "730.00", 521]]],
    [12, [[209, "PDS_FAKEFOOTER_0001"]]],
  ]);
  const p2 = page([
    [543, [[37, "Details of Your POSB Everyday Savings Account"], [409, "Account No.: 111-22222-3"]]],
    [523, header],
    [493, [[97, "Balance Brought Forward"], [486, "730.00", 521]]],
    [477, [[37, "31 Jan"], [97, "Interest Earned"], [437, "0.12", 442], [486, "730.12", 521]]],
    [469, [[97, "Total"], [335, "320.00", 362], [414, "50.12", 442]]],
    [461, [[97, "Balance Carried Forward"], [486, "730.12", 521]]],
  ]);
  const res = parseStatement([p1, p2], "posb.pdf");
  assert.ifError(res.error);
  assert.strictEqual(res.kind, "bank");
  assert.strictEqual(res.source, "bank-posb");
  assert.deepStrictEqual(res.accounts.map(a => [a.id, a.number, a.name]), [["bank-posb-2223", "2223", "POSB account ·2223"]]);
  assert(res.rows.every(r => r.account === "bank-posb-2223"));
  assert.deepStrictEqual(res.rows.map(keyOf), [
    "03 Jan 2027|CR|50.00|FAST Payment / Receipt From: SOMEONE Other",
    "05 Jan 2027|DR|20.00|Funds Transfer TOP-UP TO PAYLAH! :",
    "05 Jan 2027|DR|300.00|HDB Housing Loan",
    "31 Jan 2027|CR|0.12|Interest Earned",
  ]);
  assert(res.rows.every(r => r.bank === "POSB" && r.file === "posb.pdf" && r.category === ""));
  assert(res.checks.length === 3 && res.checks.every(c => c.ok), JSON.stringify(res.checks));
});

test("UOB account: Total row carries the closing balance; a wrong total is flagged", () => {
  const build = closing => [page([
    [700, [[61, "Period: 01 Mar 2027 to 31 Mar 2027"]]],
    [660, [[52, "Account Transaction Details"]]],
    [640, [[52, "One Account 999-888-777-6"]]],
    [620, [[52, "Date"], [120, "Description"], [344, "Withdrawals", 380], [435, "Deposits", 465], [517, "Balance", 545]]],
    [610, [[344, "SGD", 380], [435, "SGD", 465], [517, "SGD", 545]]],
    [590, [[52, "01 Mar"], [120, "BALANCE B/F"], [510, "2,000.00", 545]]],
    [575, [[52, "02 Mar"], [120, "PAYNOW-FAST"], [362, "9.20", 380], [510, "1,990.80", 545]]],
    [567, [[120, "SOME HAWKER"]]],
    [559, [[120, "MBK0000000000"]]],
    [544, [[52, "24 Mar"], [120, "Inward CR - GIRO"], [440, "5,000.00", 465], [510, "6,990.80", 545]]],
    [536, [[120, "SALA Salary Payment"]]],
    [520, [[52, "Total"], [356, "9.20", 380], [440, "5,000.00", 465], [510, closing, 545]]],
    [500, [[52, "------ End of Transaction Details ------"]]],
    [480, [[52, "UOB's Fair Dealing Commitment"]]],
  ])];
  const ok = parseStatement(build("6,990.80"), "uob.pdf");
  assert.ifError(ok.error);
  assert.strictEqual(ok.source, "bank-uob");
  assert.deepStrictEqual(ok.accounts.map(a => a.id), ["bank-uob-7776"]);
  assert(ok.rows.every(r => r.account === "bank-uob-7776"));
  assert.deepStrictEqual(ok.rows.map(keyOf), [
    "02 Mar 2027|DR|9.20|PAYNOW-FAST SOME HAWKER MBK0000000000",
    "24 Mar 2027|CR|5000.00|Inward CR - GIRO SALA Salary Payment",
  ]);
  assert(ok.checks.every(c => c.ok), JSON.stringify(ok.checks));
  const bad = parseStatement(build("6,999.80"), "uob.pdf");
  const closing = bad.checks.find(c => /Closing/.test(c.label));
  assert(closing && !closing.ok && closing.expected === "6,999.80" && closing.actual === "6,990.80");
});

test("DBS cards: CR payments, REF NO dropped, December rows on a January statement", () => {
  const res = parseStatement([page([
    [760, [[95, "STATEMENT DATE"], [224, "CREDIT LIMIT"]]],
    [748, [[95, "12 Jan 2027"], [224, "$10,000.00"]]],
    [700, [[400, "DBS Cards P.O. Box 000"]]],
    [600, [[54, "DATE"], [95, "DESCRIPTION"], [480, "AMOUNT (S$)"]]],
    [580, [[54, "DBS TEST VISA CARD NO.: 4000 0000 0000 0001"]]],
    [560, [[96, "PREVIOUS BALANCE"], [520, "100.00", 551]]],
    [545, [[54, "26 DEC"], [95, "BILL PAYMENT - DBS INTERNET/WIRELESS"], [520, "100.00", 551], [553, "CR"]]],
    [537, [[95, "REF NO: 0000000000"]]],
    [520, [[54, "NEW TRANSACTIONS TEST USER"]]],
    [505, [[54, "20 DEC"], [95, "SOME SHOP"], [525, "40.00", 551]]],
    [490, [[54, "05 JAN"], [95, "OTHER SHOP"], [521, "1,060.00", 551]]],
    [475, [[412, "SUB-TOTAL:"], [521, "1,100.00", 551]]],
    [460, [[429, "TOTAL:"], [521, "1,100.00", 551]]],
    [440, [[54, "INSTALMENT PLANS SUMMARY"]]],
    [420, [[200, "GRAND TOTAL FOR ALL CARD ACCOUNTS:"], [521, "1,100.00", 551]]],
  ])], "dbs.pdf");
  assert.ifError(res.error);
  assert.strictEqual(res.source, "card-dbs");
  assert.deepStrictEqual(res.accounts.map(a => [a.id, a.name]), [["card-dbs-0001", "DBS card ·0001"]]);
  assert(res.rows.every(r => r.account === "card-dbs-0001"));
  assert.deepStrictEqual(res.rows.map(keyOf), [
    "26 Dec 2026|CR|100.00|BILL PAYMENT - DBS INTERNET/WIRELESS",
    "20 Dec 2026|DR|40.00|SOME SHOP",
    "05 Jan 2027|DR|1060.00|OTHER SHOP",
  ]);
  assert(res.checks.length === 2 && res.checks.every(c => c.ok), JSON.stringify(res.checks));
});

test("UOB cards: transaction date, Ref No dropped, total on the next line, payment slip ignored", () => {
  const header = [[63, "Post"], [103, "Trans"], [149, "Description of Transaction"], [474, "Transaction Amount", 546]];
  const p1 = page([
    [710, [[380, "Statement Date"], [505, "12 FEB 2027"]]],
    [672, [[380, "Amount to Pay"], [506, "SGD 60.50", 556]]],
    [645, [[47, "Credit Card(s) Statement"]]],
    [583, [[61, "TEST CARD"], [152, "4000-0000-0000-0002"], [428, "60.50", 452]]],
    [508, [[61, "TEST CARD"]]],
    [487, [[61, "4000-0000-0000-0002 TEST USER"]]],
    [468, header],
    [438, [[149, "PREVIOUS BALANCE"], [515, "30.00", 546]]],
    [417, [[61, "27 JAN"], [103, "26 JAN"], [149, "PAYMT THRU E-BANK/HOMEB/CYBERB (EP00)"], [515, "30.00 CR", 560]]],
    [396, [[61, "02 FEB"], [103, "31 JAN"], [149, "SOME CAFE SINGAPORE"], [530, "10.50", 546]]],
    [387, [[149, "Ref No. : 00000000000000000000001"]]],
    [46, [[36, "Please note that you are bound by a duty under the rules governing the operation of this account"]]],
    [18, [[36, "United Overseas Bank Limited"]]],
  ]);
  const p2 = page([
    [735, [[61, "TEST CARD"]]],
    [714, [[61, "4000-0000-0000-0002 TEST USER (continued)"]]],
    [695, header],
    [665, [[61, "10 FEB"], [103, "09 FEB"], [149, "TOWN"], [530, "50.00", 546]]],
    [656, [[149, "USD 37.00"]]],
    [215, [[149, "SUB TOTAL"], [521, "60.50", 546]]],
    [194.5, [[149, "TOTAL BALANCE FOR TEST CARD"]]],
    [191, [[521, "60.50", 546]]],
    [150, [[50, "------ End of Transaction Details ------"]]],
    [100, [[61, "4000-0000-0000-0002"], [300, "60.50", 330]]],
  ]);
  const res = parseStatement([p1, p2], "uobcc.pdf");
  assert.ifError(res.error);
  assert.strictEqual(res.source, "card-uob");
  assert.deepStrictEqual(res.accounts.map(a => a.id), ["card-uob-0002"]);
  assert(res.rows.every(r => r.account === "card-uob-0002"));
  assert.deepStrictEqual(res.rows.map(keyOf), [
    "26 Jan 2027|CR|30.00|PAYMT THRU E-BANK/HOMEB/CYBERB (EP00)",
    "31 Jan 2027|DR|10.50|SOME CAFE SINGAPORE",
    "09 Feb 2027|DR|50.00|TOWN USD 37.00",
  ]);
  assert.deepStrictEqual(res.checks.map(c => [c.label, c.ok]), [["TEST CARD balance", true], ["Amount to pay", true]]);
});

test("POSB: two accounts on one statement become two accounts", () => {
  const header = [[37, "DATE"], [97, "DETAILS OF TRANSACTIONS"], [313, "WITHDRAWAL($)", 362], [408, "DEPOSIT($)", 442], [485, "BALANCE($)", 521]];
  const res = parseStatement([page([
    [566, [[443, "As at 31 Jan 2027"]]],
    [543, [[37, "Details of Your POSB Everyday Savings Account"], [409, "Account No.: 111-22222-3"]]],
    [523, header],
    [493, [[97, "Balance Brought Forward"], [486, "100.00", 521]]],
    [477, [[37, "03 Jan"], [97, "Coffee"], [340, "5.00", 362], [486, "95.00", 521]]],
    [461, [[97, "Total"], [340, "5.00", 362]]],
    [445, [[97, "Balance Carried Forward"], [486, "95.00", 521]]],
    [400, [[37, "Details of Your POSB Savings Account"], [409, "Account No.: 444-55555-6"]]],
    [380, header],
    [360, [[97, "Balance Brought Forward"], [486, "200.00", 521]]],
    [344, [[37, "04 Jan"], [97, "Coffee"], [340, "5.00", 362], [486, "195.00", 521]]],
    [328, [[97, "Total"], [340, "5.00", 362]]],
    [312, [[97, "Balance Carried Forward"], [486, "195.00", 521]]],
  ])], "posb2.pdf");
  assert.ifError(res.error);
  assert.deepStrictEqual(res.accounts.map(a => a.id), ["bank-posb-2223", "bank-posb-5556"]);
  assert.deepStrictEqual(res.rows.map(r => [r.date, r.account]), [["03 Jan 2027", "bank-posb-2223"], ["04 Jan 2027", "bank-posb-5556"]]);
  assert.strictEqual(res.source, "bank-posb");
  assert(res.checks.every(c => c.ok), JSON.stringify(res.checks));
});

test("DBS cards: two cards on one statement, one source, rows on each card", () => {
  const res = parseStatement([page([
    [760, [[95, "STATEMENT DATE"]]],
    [748, [[95, "12 Jan 2027"]]],
    [700, [[400, "DBS Cards P.O. Box 000"]]],
    [600, [[54, "DATE"], [95, "DESCRIPTION"], [480, "AMOUNT (S$)"]]],
    [580, [[54, "DBS TEST VISA CARD NO.: 4000 0000 0000 0001"]]],
    [505, [[54, "05 JAN"], [95, "SHOP A"], [525, "40.00", 551]]],
    [460, [[429, "TOTAL:"], [525, "40.00", 551]]],
    [440, [[54, "DBS TEST MASTERCARD CARD NO.: 5000 0000 0000 0009"]]],
    [420, [[54, "06 JAN"], [95, "SHOP B"], [525, "10.00", 551]]],
    [400, [[429, "TOTAL:"], [525, "10.00", 551]]],
    [380, [[200, "GRAND TOTAL FOR ALL CARD ACCOUNTS:"], [525, "50.00", 551]]],
  ])], "dbs2.pdf");
  assert.ifError(res.error);
  assert.strictEqual(res.source, "card-dbs");
  assert.deepStrictEqual(res.accounts.map(a => a.name), ["DBS card ·0001", "DBS card ·0009"]);
  assert.deepStrictEqual(res.rows.map(r => r.account), ["card-dbs-0001", "card-dbs-0009"]);
  assert(res.checks.every(c => c.ok), JSON.stringify(res.checks));
});

test("unknown layouts are rejected, not guessed", () => {
  const res = parseStatement([page([[700, [[50, "Some other bank statement"]]]])], "other.pdf");
  assert(res.error && /Not a statement layout/.test(res.error));
});

let failed = 0;
tests.forEach(([name, fn]) => {
  try { fn(); console.log("ok   " + name); }
  catch (err) { failed++; console.log("FAIL " + name + "\n     " + err.message); }
});
if (failed) { console.log(`${failed} failed`); process.exit(1); }

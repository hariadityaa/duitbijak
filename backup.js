/* Duit Bijak: backup and restore.
   A JSON backup holds the whole ledger (months, rules, accounts, statements,
   fixed bills) and restores it exactly. The CSV is for reading in a
   spreadsheet: one row per transaction, with the category the app shows. */
(function (root) {
"use strict";

const BACKUP_APP = "duit-bijak";
const BACKUP_VERSION = 1;
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

function buildBackup(data, exportedAt) {
  return {
    app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: exportedAt || new Date().toISOString(),
    data: {
      months: data.months || [], fixedCommitments: data.fixedCommitments || {},
      statements: data.statements || {}, rules: data.rules || null, accounts: data.accounts || {},
    },
  };
}

// Returns the ledger in a backup file, or throws with a reason a person can act on.
function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error("That file isn't valid JSON."); }
  if (!isObj(obj) || obj.app !== BACKUP_APP || !isObj(obj.data)) throw new Error("That file isn't a Duit Bijak backup.");
  if (!(obj.version <= BACKUP_VERSION)) throw new Error("That backup is from a newer version of the app. Reload and try again.");
  const d = obj.data;
  if (!Array.isArray(d.months) || d.months.some(m => !isObj(m) || typeof m.month !== "string")) throw new Error("The backup's months are unreadable.");
  return {
    months: d.months, fixedCommitments: isObj(d.fixedCommitments) ? d.fixedCommitments : {},
    statements: isObj(d.statements) ? d.statements : {}, rules: isObj(d.rules) ? d.rules : null,
    accounts: isObj(d.accounts) ? d.accounts : {},
  };
}

const csvField = v => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const CSV_HEADER = ["Month", "Date", "Account", "Description", "Amount", "Type", "Category", "Category source", "Spend type"];

// opts.accountName(id) and opts.category(tx) give what the app shows.
function transactionsCsv(months, opts) {
  const lines = [CSV_HEADER.join(",")];
  (months || []).forEach(m => (m.transactions || []).forEach(tx => {
    const out = tx.withdrawal != null;
    lines.push([
      m.month, tx.date, opts.accountName(tx.account), tx.description,
      (out ? tx.withdrawal : tx.deposit || 0).toFixed(2), out ? "DR" : "CR",
      opts.category(tx), tx.category ? "saved" : "guessed", tx.spendType || "",
    ].map(csvField).join(","));
  }));
  return lines.join("\r\n") + "\r\n";
}

// "duit-bijak-backup-2026-10-14.json"
const backupFileName = (ext, date) => `duit-bijak-backup-${(date || new Date()).toISOString().slice(0, 10)}.${ext}`;

const api = { BACKUP_VERSION, buildBackup, parseBackup, transactionsCsv, backupFileName };
if (typeof module === "object" && module.exports) module.exports = api;
else root.DuitBackup = api;
})(typeof self !== "undefined" ? self : this);

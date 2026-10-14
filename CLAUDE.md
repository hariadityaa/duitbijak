# Duit Bijak

Personal finance PWA. Static files on GitHub Pages, no build step, no framework.
Node is used only for checks and tests.

## Commands
- `npm test`: syntax and wiring checks, then every `tests/*.test.js`. Run before pushing.
- `npm run check`: checks only.

## Do not read
- `vendor/`: minified pdf.js (1.8 MB). Exclude it from grep and search.
- `docs/*.png`: screenshots.
- Read `index.html` by section, not whole. Use the map below with `offset` and `limit`.

## File map
- `index.html`: markup, CSS, and one inline script (the app). About 2,500 lines.
  Find a section with `grep -n '^/\* =====' index.html`. Sections in order:
  constants, utilities, CSV/TSV parsing, aggregation, one-off spend, persistence,
  chart bits, render (shell, accounts, rules, Overview, drill-downs, Transactions),
  install and updates.
- `accounts.js`: account ids (bank, kind, last 4), migration from statement types, month merging.
- `pdf-import.js`: in-browser bank statement PDF parsers (uses `vendor/pdfjs-*`).
- `gemini-parse.js`: fallback parser for unknown layouts, on tap, with the user's own key.
- `categorise.js`: category guesses from built-in rules and saved history.
- `rules.js`: user rules (fixed bills, salary, one-offs, transfers), edited in Settings.
- `statements.js`: which statements are imported and which are missing.
- `backup.js`: JSON backup/restore and CSV export.
- `sw.js`: service worker and app-shell precache.
- `tests/*.test.js`: plain Node scripts, one per module. No test framework.

Modules are UMD-style (`(function (root) {...})`) so they load in the browser and in `require`.

## Rules
- **Bump `CACHE_NAME` in `sw.js`** on any change to `index.html`, a root `.js` file, `manifest.json`, `icons/` or `vendor/`. CI fails otherwise. Without it, installed copies never update.
- **New root `.js` module**: add a `<script src>` in `index.html` and an entry in `APP_SHELL` in `sw.js`. `npm run check` fails if either is missing.
- UI is built from `innerHTML` strings. Escape every interpolated value that came from a statement, CSV or user input with `esc()`.
- Keep pure logic in the modules so it stays testable. Add a test with it.

## Workflow
Branch, push, open a PR, wait for CI, squash-merge when green, confirm the Pages deploy.

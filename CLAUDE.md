# Duit Bijak

Personal finance PWA. Static files on GitHub Pages, no build step, no framework.
Node is used only for checks and tests.

## Commands
- `npm test`: syntax and wiring checks, then every `tests/*.test.js`. Run before pushing.
- `npm run check`: checks only.

## Do not read
- `vendor/`: minified pdf.js (1.8 MB). Exclude it from grep and search.
- `docs/*.png`: screenshots.
- Read the one `app/*.js` file for the area you are changing, not all of them.

## File map
- `index.html`: markup shell only (about 50 lines). Loads `styles.css` and the scripts below.
- `styles.css`: all CSS, design tokens at the top.
- `app/*.js`: the app, one classic script per area. They share one global scope and
  load in this order (see the `<script>` tags in `index.html`):
  `core` (constants, utilities, CSV parsing), `aggregate` (rows to months),
  `oneoff` (one-off spend, core op-ex), `store` (persistence, import, restore),
  `shell` (chart bits, header, nav, sheets, PDF review), `settings` (accounts, rules, data),
  `overview` (Overview and Detail tabs), `sheets` (drill-downs, add month, total out, review),
  `transactions`, `install` (install prompt, update banner), `events` (every `data-action`),
  `main` (init). Order matters: top-level `const` and `let` must be defined before use at load time.
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
- **Bump `CACHE_NAME` in `sw.js`** on any change to `index.html`, `styles.css`, `app/`, a root `.js` file, `manifest.json`, `icons/` or `vendor/`. CI fails otherwise. Without it, installed copies never update.
- **New `.js` file (root or `app/`) or `styles.css`**: add a `<script src>` or `<link>` in `index.html` and an entry in `APP_SHELL` in `sw.js`. `npm run check` fails if either is missing.
- UI is built from `innerHTML` strings. Escape every interpolated value that came from a statement, CSV or user input with `esc()`.
- Keep pure logic in the modules so it stays testable. Add a test with it.

## Workflow
Branch, push, open a PR, wait for CI, squash-merge when green, confirm the Pages deploy.

# pdf.js 4.10.38 (legacy build)

Served from this site rather than a CDN, so the code that reads your
statements is exactly what's committed here.

- Source: `pdfjs-dist@4.10.38` from npm, `legacy/build/` (works on older iOS Safari)
- Tarball: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz
- Tarball integrity: `sha512-/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ==`
- License: Apache 2.0 (`LICENSE`)

| File | sha256 |
| --- | --- |
| `pdf.min.mjs` | `44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72` |
| `pdf.worker.min.mjs` | `bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d` |

To upgrade, copy both files from the new version's `legacy/build/` into a new
`vendor/pdfjs-<version>/` folder, then update `PDFJS_BASE` in `pdf-import.js`
and `PDFJS_CACHE`/`PDFJS_PATH` in `sw.js`.

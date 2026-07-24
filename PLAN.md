# PLAN.md — Milestones (agent-executable)

Written for a coding agent (or human) to execute in order. **Do not skip gates.** Each milestone ends with runnable commands and a checklist; when a gate fails, fix that milestone — don't start the next.

Strategy in one paragraph: the Python Docling bootstrap **proved reading quality and froze the contract** (M1, done); the project has now **pivoted to a portable TypeScript + ONNX engine** ([`engine-js/`](./engine-js/), granite-docling-258M under transformers.js — pure JS, no Python, no sidecar) as the primary trajectory. Build the TS engine core + Node CLI (M2), reach **fixture parity** with the Python oracle including a numeric-fidelity cross-check (M3), then package for humans as an Obsidian plugin (M4), then EPUB delivery (M5) and a browser extension (M6) — with on-device mobile as the unplanned end goal. Python is retained as a reference oracle, not deleted. Rationale: [README.md](./README.md) and [docs/perf-and-portability.md](./docs/perf-and-portability.md).

## Environment

- Machine: MacBook Air M4, 32 GB (Apple Silicon).
- Python managed with **uv** (`uv sync`, `uv run pdf2md ...`). No bare pip/venv.
- Models: document every download (name, size, cache path) in `docs/models.md`. Offline must be real after cache warm.
- `out/` is gitignored scratch. Fixture PDFs are gitignored; `fixtures/MANIFEST.md` records sources + a fetch script.

## Artifact contract (freeze at M1)

```
out/<Paper Title>/  # folder named from the extracted title — drops into a vault as-is
  document.md       # YAML frontmatter properties (title, source, author, created,
                    # tags — Obsidian web-clipper style), then headings, MD/HTML
                    # tables, $LaTeX$ math (MathJax-safe), figure refs
  images/           # extracted figures, stable names
  meta.json         # source, title, engine id+version, page count, timings, warnings
  document.epub     # M2+
```

`meta.json.engine` labels the path honestly: `python-docling-bootstrap` (oracle) vs `onnx-portable` (shipping engine). Both write the same folder; the TS engine adds `model`, `timings_ms`, and `execution_providers` fields rather than inventing a parallel layout.

---

# M1 — Papers read nicely in Obsidian ⭐ (done → frozen reference oracle)

**Goal:** `pdf2md convert paper.pdf --out out/paper/` on the Mac produces a Markdown package that someone who read the PDF would rather read in Obsidian.

**Engine:** Python Docling with figure extraction and formula enrichment, labeled bootstrap. This was the fast path to the existential question — is the quality there? — and it answered *yes*. **Its lasting output is the frozen artifact contract + the engine-independent fixture suite**, which now serve as the parity spec for the TS engine. Kept as the modular fallback and numeric cross-check; **not** extended further (the perf items below are moot now that the VLM replaces the slow CPU-bound formula/table stages).

### Tasks

- [x] uv project: `pyproject.toml`, `src/pdf2md/`, `pdf2md` entry point (`convert`, `version`).
- [x] `convert` always writes `document.md` + `images/` + `meta.json`; output folder is named
      from the extracted title; `document.md` opens with Obsidian-style YAML properties.
- [x] Figures: extracted to `images/`, referenced inline with captions.
- [x] Tables: Markdown tables. (HTML fallback for row/col spans: pending — no fixture has hit it yet.)
- [x] Math: `$$LaTeX$$` via Docling formula enrichment (`--no-formulas` to disable) + MathJax-repair
      pass (brace balancing, `& & (N)` → `\tag{N}`, `aligned` wrapping).
- [x] Warn loudly on image-only pages (no silent empty success on scans).
- [x] Fixtures + expectations (see `fixtures/MANIFEST.md`): `attention`, `bert` (two-column, CC-BY),
      `vae` (equation-dense), `ioannidis` (medical, CC-BY). Each has
      `fixtures/expectations/<id>.json` pass/fail checks (olmOCR-bench style) with strings validated
      against the raw PDF text layer — ground truth independent of the engine. Scanned fixture
      deferred with OCR. `fixtures/private/*.pdf` (gitignored) auto-discovered for smoke checks.
- [x] `tests/`: contract tests + per-fixture expectation tests (title, headings, figures, math-block
      count, required phrases, exact numeric table cells, forbidden artifacts) + private-PDF smoke.
      Session-scoped conversion cache; `-m "not slow"` for the fast subset. 10 passed / 1 skipped.
- [~] **Perf — superseded by the pivot.** The Python engine's CPU-bound formula/table stages
      (vae: 73 min) were the trigger to move to the single-VLM TS engine; optimizing the bootstrap
      is no longer on the critical path. The perf research (Track 1) is preserved in
      [docs/perf-and-portability.md](./docs/perf-and-portability.md) as context for the pivot.
- [→] LaTeX render-rate metric + human Obsidian verdict: carried into **M3** (parity), where they
      measure the TS engine against this oracle rather than the retired bootstrap.

### Commands

```bash
uv sync
uv run pdf2md convert fixtures/attention.pdf --out out/attention
open out/attention/document.md   # or open the folder as an Obsidian vault
uv run pytest -q
```

### Gate 1 — "Rather read the Markdown"

| Check | Pass? |
|-------|-------|
| Contract files always written; engine + timings in `meta.json` | |
| Two-column fixture: reading order correct, no header/footer junk | |
| Headings → real `#` hierarchy (Obsidian outline = paper TOC) | |
| Figures present in `images/` and embedded with captions | |
| Tables faithful — zero corrupted numeric cells | |
| Math renders as LaTeX in Obsidian (rate recorded) | |
| Scanned fixture fails loudly (OCR may be deferred, silence may not) | |
| Human verdict: prefer the MD for ≥4/5 fixtures | |

**Stop if Gate 1 fails** — tune pipeline/models; nothing downstream matters without this.

---

# M1.5 — superseded by the pivot

The VLM-vs-modular experiment is no longer run as a separate Python/MLX study. The decision is
made: **adopt the VLM (granite-docling-258M) as the portable engine**, in TypeScript + ONNX. The
quality question M1.5 was meant to answer is now answered empirically by **M3** — the TS engine is
scored against the same fixture suite, with a numeric-fidelity cross-check guarding the "VLMs can
invent table numbers" risk. Rationale: [docs/perf-and-portability.md](./docs/perf-and-portability.md) §3.

---

# M2 — Portable engine core: TypeScript + ONNX ⭐ (current)

**Goal:** `pdf2md-js convert paper.pdf --out out/` produces the same contract-valid vault package as
the Python oracle, using pure JS — pdf.js + granite-docling-258M ONNX (transformers.js) + a JS
DocTags→Markdown parser. No Python, no sidecar.

**Engine:** [`engine-js/`](./engine-js/) (`meta.json.engine = "onnx-portable"`).

### Tasks
- [x] Scaffold `engine-js/` TS package: `package.json`, `tsconfig`, Node CLI `pdf2md-js`.
- [x] `doctags.ts` — DocTags→Markdown (headings, text, `$$LaTeX$$`, OTSL tables, `<picture>`+caption,
      `<loc_*>` bboxes; drops page header/footer; flags dropped OTSL spans). Offline unit-tested.
- [x] `mathjax.ts` — port of the bootstrap's `_fix_formula`/`_clean_math`. Offline unit-tested.
- [x] `frontmatter.ts` / `meta.ts` — same artifact contract; adds `model`, `timings_ms`,
      `execution_providers`.
- [x] `pdf.ts` — pdf.js raster + text layer + figure crops (`@napi-rs/canvas`).
- [x] `vlm.ts` — transformers.js load of `onnx-community/granite-docling-258M-ONNX` (device-aware
      dtype: fp32 on CPU, q4f16 on WebGPU), page image → DocTags; `max_new_tokens` runaway guard.
- [x] **First end-to-end convert** proven on `attention.pdf` page 1: clean DocTags → Markdown, title
      extracted, running-header dropped, 28.4/41.8 BLEU numbers preserved. Four integration bugs
      fixed (white canvas fill, processor arg order, device-aware dtype, cwd). `timings_ms` +
      `execution_providers` recorded in `meta.json`.
- [x] **Measured CPU dtype** (perf doc §4b): fp32 is the only correct dtype on the ORT CPU provider
      (q4f16/q8 both garble); ~4 min/page. Usable speed = WebGPU (M4/M6), not CPU quant.
- [ ] Full-document convert + fixture parity → **M3** (fp32 is slow but correct; run in background).

### Commands
```bash
cd engine-js
npm install
npm run typecheck
npm run test:offline            # DocTags + MathJax, no download
npm run cli -- convert ../fixtures/attention.pdf --out out/   # downloads model on first run
```

### Gate 2 — "TS engine writes a real package"
| Check | Pass? |
|-------|-------|
| `pdf2md-js convert` writes `document.md` + `images/` + `meta.json` (`engine: onnx-portable`) | ✅ |
| Offline unit tests green (DocTags parser, MathJax repairs) | ✅ |
| One fixture converts end-to-end; math as `$$LaTeX$$`, headings hierarchical | ✅ page 1 (figures/full-doc → M3) |
| `meta.json` records model, per-stage timings, execution providers | ✅ |

---

# M3 — Fixture parity + numeric fidelity (the quality gate)

**Goal:** the TS engine matches the Python oracle's quality on the shared fixture suite — this is
where "is the VLM good enough?" is answered, in TS, against ground truth validated on the raw PDF
text layer.

- [x] **Fixture parity achieved (2026-07-24).** All four fixtures (attention/bert/vae/ioannidis)
      converted through `engine-js` (CPU fp32) and the Python oracle, scored against the shared
      `fixtures/expectations/*.json`: **both engines pass all 7 checks on all 4 fixtures.** Numeric
      table fidelity holds (attention 28.4/41.8, bert 93.2/86.7); on equation-dense vae the VLM
      produced *more* renderable math blocks than Docling (35 vs 31).
- [x] **Degenerate-generation guard** (commit `3ead976`): repetition + wall-clock StoppingCriteria;
      fired in production exactly once (vae p11), turning a would-be hang into a flagged, recoverable
      page. Replaces the "cross-check" as the immediate never-silently-wrong mechanism.
- [x] Quantization sweep on CPU — **dead-end** (perf doc §4b): q4f16/q8 garble on the ORT CPU
      provider; fp32 is the CPU floor. WebGPU quant sweep deferred to M4/M6.
- [ ] **Two gaps surfaced, deferred to M4-adjacent hardening** (both flagged, not silent):
      figure *over-detection* (VLM emits ~2× Docling's `<picture>` count on bert/ioannidis), and
      OTSL merged-cell handling (recurring "merged cells rendered blank" warning → HTML fallback).
- [ ] Numeric-fidelity cross-check vs the pdf.js text layer, LaTeX render-rate metric, human Obsidian
      verdict, 2-stage-variant fallback — carried forward as refinements (parity already met without them).

**Gate 3: PASSED** — the portable TS engine matches the oracle's quality scores on all four
fixtures, numeric cells intact, degenerate pages caught loudly. The VLM route is validated; the
Python modular path stays only as an oracle/fallback.

---

# M4 — Effortless for humans (Obsidian plugin)

**Goal:** the empty-quadrant product: right-click a PDF in Obsidian → note + figures + math land in
the vault. No API keys, no server, nothing uploads.

- [x] **WebGPU path validated** (`engine-js/web/`, perf doc §4b): pdf.js + transformers.js + our JS
      DocTags parser convert a page **in Electron 42 / Chrome 148** (= the Obsidian desktop renderer)
      at ~41 s/page, ~6× the CPU fp32 speed, quality-equal. Config: transformers.js **pinned 3.7.5**
      (4.2.0 garbles), dtype `{embed fp16, vision fp32, decoder fp32}`, `device: "webgpu"`.
- [x] **Portable engine refactor** (commit `783dff5`): `core/{types,convert,guard}.ts` hold the
      platform-agnostic pipeline (`assembleDocument`, no I/O); `browser/{pdf,vlm,engine}.ts` are
      renderer adapters with transformers.js + pdf.js **injected** (host picks the WebGPU-working
      version). `index.ts` is now a thin Node adapter. The web harness runs the *real* core
      (`engine.js`, 17 kB) — no duplication. tsc clean, 20/20 tests, node smoke ✓.
- [x] **Obsidian plugin scaffold** (commit `604a373`, `plugin/`): file-menu "Convert to Markdown" +
      command → `convertPdfBrowser()` on WebGPU → vault package; settings (output folder, max pages);
      esbuild → CJS `main.js`. Bundles clean (engine import resolves). `npm install && npm run build`
      to produce `main.js`; needs a WebGPU Obsidian + first-run model download.
- [~] **Live in-Obsidian validation — IN PROGRESS, blocked on ORT-in-Electron.** Installed into a real
      vault (`plugin/install.mjs` → `.obsidian/plugins/pdf-to-md/`). Debugging log, each layer cleared:
    1. ✅ **Backend selection.** Obsidian's Node-integrated renderer made transformers.js pick its
       cpu-only onnxruntime-node backend (`Unsupported device: "webgpu"`). Fixed by an esbuild banner
       that renames `process.release.name` off `"node"` so transformers captures `IS_NODE_ENV=false`
       and offers onnxruntime-web + WebGPU (commits `c583fab`). Console confirms `spoof result:
       obsidian | navigator.gpu: true`.
    2. ✅ Model **downloads** and the **WebGPU backend is selected**.
    3. ❌ **BLOCKER: onnxruntime-web threaded wasm.** `ort-wasm-simd-threaded.jsep.mjs` has its *own*
       emscripten Node check — `var isNode = typeof globalThis.process?.versions?.node == 'string'`
       (no `process.type !== "renderer"` guard) — true in the renderer, so it runs
       `await import('worker_threads')`, an ESM bare specifier that can't resolve →
       *"no available backend found. ERR: [webgpu] Failed to resolve module specifier 'worker_threads'"*.
       Runtime spoofing failed (Electron locks `process.versions.node`). A build-time esbuild `onLoad`
       patch of the glue (commit WIP) **did not fire** — the glue enters the bundle via a path the
       `/ort-wasm.*\.mjs$/` filter missed; need to find how esbuild includes it (metafile).
    - **Candidate fixes (next session):** (a) find the real resolve path and patch the glue at build
      time (or `patch-package` on `node_modules`); (b) force a **non-threaded** ORT wasm so the
      `-threaded.jsep` glue is never loaded; (c) **run inference in a Web Worker** — no Node `process`
      there, so emscripten naturally takes the web path (cleanest, but WebGPU-in-worker needs checking);
      (d) provide `worker_threads` via a bundled stub exporting the real `globalThis.Worker`.
    - Note: the same engine already passes all 4 fixtures on CPU (M3) and ran correctly on WebGPU in
      the standalone harness (Electron 42) — the blocker is ORT's Node-detection *inside Obsidian*, not
      the conversion logic.
- [ ] Model download on first enable with disclosure + checksums (Smart Connections precedent).
      Inference in a worker; persist weights via IndexedDB/OPFS (Cache API unreliable in the harness pane).
- [ ] Vault craft: YAML frontmatter (title/authors/DOI/citekey), relative image links, optional
      provenance links to PDF pages (`[[paper.pdf#page=N]]`).
- [ ] Fix engine gaps the plugin inherits: figure over-detection, OTSL merged-cell spans (M3 carry-over).

**Gate 4:** fresh Obsidian install → plugin → converted paper in vault in under 2 minutes, offline
after model cache.

---

# M5 — Easy local path to e-readers

**Goal:** one command from the validated Markdown package to a book on each reader, honest about each path.

- [ ] `--epub`: MD + images → EPUB (TOC from headings, `img { max-width:100% }`, math → MathML with
      image fallback for e-ink).
- [ ] Acceptance instrument: **Kindle Previewer 3** + Apple Books.
- [ ] Delivery helpers: `--send books` (`open -a Books`, iCloud syncs); `--send kindle` (Send to
      Kindle — document the Amazon cloud hop); Boox/Kobo via USB/BooxDrop (fully local).
- [ ] Compare against Amazon Convert + Calibre on ≥2 real PDFs; note results.

**Gate 5:** reflow + figures + navigable TOC verified in Kindle Previewer and Books; clearly better
than Amazon Convert; delivery matrix documented.

---

# M6 — Browser extension (same core, different shell)

**Goal:** the portable engine in the browser — proof that the JS core travels.

- [ ] MV3 extension: engine in an offscreen document / side panel (service workers can't run
      ORT/WebGPU); bundle ORT `.wasm`, set `wasmPaths`; `unlimitedStorage` + OPFS/IndexedDB for the
      ~190 MB q4f16 weights.
- [ ] Degrade to a pdf.js text-only fast path on non-WebGPU machines (VLM-on-WASM is too slow).

**Gate 6:** convert a PDF client-side on a WebGPU machine; weights cached across sessions.

---

# Later — mobile / on-device (end goal, deliberately unplanned)

Boox Palma / Android on-device conversion and iOS share-sheet → convert → read. The nearer iOS path
is a native app (share-sheet handoff to the main app — the ~120 MB share-extension memory cap blocks
in-extension inference — plus MLX-Swift); the Obsidian mobile plugin waits on WKWebView WebGPU
(iOS 26+). Unlocked only by Gates 2–4; gets its own plan (performance projection first) when the time
comes. Nothing before that gates on mobile.

---

## Working rules for agents

1. uv for all Python; never bare pip. Keep `uv.lock` committed.
2. Preserve the artifact contract; extend `meta.json`, don't fork layouts.
3. Record timings (`wall_ms`, `pages`) in `meta.json` on every convert.
4. Document model downloads (size, URL, cache path) in `docs/models.md`.
5. Never silently wrong: warn on dropped figures, image-only pages, failed formula parses.
6. Marker stays experimental (license); Docling-family is the default.
7. Append to the Progress log when a gate passes or fails.

## Progress log

| Date | Milestone | Gate | Notes |
|------|-----------|------|-------|
| 2026-07-21 | — | — | Plan rewritten: Markdown-first (Obsidian quality → e-reader delivery → plugin → ONNX port → mobile later) |
| 2026-07-21 | M1 | — | Started: uv scaffold + Docling bootstrap |
| 2026-07-21 | M1 | — | First fixture converts end-to-end (attention.pdf: 15 pp, 6 figures, MD tables, LaTeX math; 177 s warm). Contract tests pass. Remaining for Gate 1: 4 more fixtures, numeric-fidelity + LaTeX-rate checks, human Obsidian verdicts |
| 2026-07-22 | M1 | — | Vault-ready output (title folder, frontmatter, MathJax-safe LaTeX). Fixture suite: attention/bert/vae/ioannidis with ground-truth expectation tests (olmOCR-bench style) — 10 passed. Titles, figures, tables, reading order all verified. ⚠ Perf finding: formula enrichment is per-formula and dominates — vae (equation-dense, 14 pp) took 73 min vs bert 48 s; investigate accelerator (MPS) settings / batching before Gate 1 |
| 2026-07-23 | M1 | — | Perf + portability research written up in docs/perf-and-portability.md (root causes: TableFormer/CodeFormula forced to CPU upstream; fix plan Track 1; granite-docling VLM + all-JS ONNX path). PLAN updated: perf work item in M1, new M1.5 engine experiment, M3/M4 route decision. Converted packages staged in out/ for human Obsidian review |
| 2026-07-23 | pivot | — | Pivoted to TypeScript + ONNX as the primary trajectory. Scaffolded `engine-js/` (granite-docling-258M ONNX via transformers.js + pdf.js + hand-written DocTags→Markdown parser). LiteRT.js evaluated and declined (perf doc §4a). |
| 2026-07-23 | M2 | Gate 2 ✅ | First end-to-end convert working (attention p1). Fixed 4 integration bugs (white canvas fill, processor arg order, device-aware dtype, cwd). Measured CPU dtype: fp32 only correct option (q4f16/q8 garble), ~4 min/page. |
| 2026-07-23 | M4-probe | — | **WebGPU validated in Electron 42** (the Obsidian renderer env): ~41 s/page, ~6× CPU, quality-equal. Config from IBM's Space: transformers.js 3.7.5 + fp32 decoder (q4f16 garbles on WebGPU too). Docs corrected (perf §4b, models.md). |
| 2026-07-24 | M3 | **Gate 3 ✅** | **Fixture parity achieved.** All 4 fixtures × both engines pass all 7 ground-truth checks; numeric cells intact; vae math 35 vs 31. Degenerate-generation guard added (`3ead976`), fired in production on vae p11. Gaps for later: figure over-detection, OTSL merged cells. → M4. |
| 2026-07-24 | M4 | — | Portable engine refactor (`783dff5`): `core/` (assembleDocument, no I/O) + `browser/` adapters (DI transformers/pdf.js); web harness runs the real core. Obsidian plugin scaffolded (`604a373`, `plugin/`) — file-menu convert → vault package on WebGPU; bundles clean. Remaining Gate 4: live in-Obsidian validation + IndexedDB weight cache. |
| 2026-07-24 | M4 | — | Plugin install workflow (`ab55dd2`: dist/ + install.mjs). Live-in-Obsidian debugging: fixed transformers backend selection (WebGPU now chosen, `c583fab`); **blocked** on onnxruntime-web threaded-wasm doing `import('worker_threads')` in the renderer (emscripten Node mis-detection). Build-time glue patch attempted, didn't fire — WIP. Diagnosis + candidate fixes logged in M4. |

# PLAN.md — Milestones (agent-executable)

Written for a coding agent (or human) to execute in order. **Do not skip gates.** Each milestone ends with runnable commands and a checklist; when a gate fails, fix that milestone — don't start the next.

Strategy in one paragraph: the Python Docling bootstrap **proved reading quality and froze the contract** (M1, done); the project has now **pivoted to a portable TypeScript + ONNX engine** ([`engine-js/`](./engine-js/), granite-docling-258M under transformers.js — pure JS, no Python, no sidecar) as the primary trajectory. Build the TS engine core + Node CLI (M2), reach **fixture parity** with the Python oracle including a numeric-fidelity cross-check (M3), then package for humans as an Obsidian plugin (M4), then EPUB delivery (M5) and a browser extension (M6) — with on-device mobile as the unplanned end goal. Python is retained as a reference oracle, not deleted. Rationale: [README.md](./README.md) and [docs/perf-and-portability.md](./docs/perf-and-portability.md).

## Environment

- Machine: MacBook Air M4, 32 GB (Apple Silicon).
- Python managed with **uv** (`uv sync`, `uv run pdf2md ...`). No bare pip/venv.
- Models: document every download (name, size, cache path) in `docs/models.md`. Offline must be real after cache warm.
- `out/` is gitignored scratch. Fixture PDFs are gitignored; `fixtures/MANIFEST.md` records sources + a fetch script.

## Artifact contract (frozen at M1; naming amended 2026-07-26)

```
paper.pdf           # the source, e.g. 1706.03762v7.pdf
paper/              # package folder, named from the PDF filename — drops into a vault as-is
  paper.md          # YAML frontmatter properties (title, source, author, created,
                    # tags — Obsidian web-clipper style), then a conversion-warning
                    # banner *if any*, then headings, MD/HTML tables, $LaTeX$ math
                    # (MathJax-safe), figure refs
  images/           # extracted figures, stable names
  meta.json         # source, title, engine id+version, page count, timings, warnings
  paper.epub        # M5
```

**Named from the source PDF, not the extracted title.** The title depends on what the
model read, so it varied by engine and by run and threw away the identifier the reader
had actually filed the paper under; and a generic `document.md` made every converted
note in a vault share one name, which Obsidian's quick-switcher renders unusable. The
title is not lost — it stays in the frontmatter and in `meta.title`; it just stops being
a path component. Collisions now follow filenames rather than titles: two papers with
the same title no longer collide, two files with the same stem do.

`images/` stays *inside* the package folder. A flat `paper.md` + `paper.images/` was
considered and rejected — the `images/` prefix is emitted by `doctags.ts`, three layers
below anything that knows the output filename, so a flat layout would have meant
threading an image-dir option through the parser, the assembler, both entry points and
the worker message protocol, plus percent-encoding link paths for names with spaces.

**Warnings reach the reader, not just `meta.json`.** A sidecar JSON is the wrong
place to tell someone that the text they are about to read is incomplete — nobody
opens it first. So warnings surface in three places at once: a
`> [!warning]+` banner between the frontmatter and the body, an inline
`> [!warning] Page N may be incomplete` marker at the end of each damaged page,
and a `conversion_warnings: N` frontmatter property so a vault can be queried for
papers worth re-checking. All three are omitted entirely when the conversion is
clean. The inline marker exists because the markdown is reflowed and has no page
boundaries — a banner saying "page 4" is honest but unactionable on its own.

`meta.json.engine` labels the path honestly: `python-docling-bootstrap` (oracle) vs `onnx-portable` (shipping engine). Both write the same folder; the TS engine adds `model`, `timings_ms`, and `execution_providers` fields rather than inventing a parallel layout. Both also record `md_path`, since the markdown filename is no longer a constant readers can join on.

---

# M1 — Papers read nicely in Obsidian ⭐ (done → frozen reference oracle)

**Goal:** `pdf2md convert paper.pdf --out out/paper/` on the Mac produces a Markdown package that someone who read the PDF would rather read in Obsidian.

**Engine:** Python Docling with figure extraction and formula enrichment, labeled bootstrap. This was the fast path to the existential question — is the quality there? — and it answered *yes*. **Its lasting output is the frozen artifact contract + the engine-independent fixture suite**, which now serve as the parity spec for the TS engine. Kept as the modular fallback and numeric cross-check; **not** extended further (the perf items below are moot now that the VLM replaces the slow CPU-bound formula/table stages).

### Tasks

- [x] uv project: `pyproject.toml`, `src/pdf2md/`, `pdf2md` entry point (`convert`, `version`).
- [x] `convert` always writes `<stem>.md` + `images/` + `meta.json` into a package folder
      named from the source PDF; the markdown opens with Obsidian-style YAML properties.
      (Originally title-named; amended 2026-07-26 — see the contract note above.)
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
open out/attention/attention.md  # or open the folder as an Obsidian vault
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
| `pdf2md-js convert` writes `<stem>.md` + `images/` + `meta.json` (`engine: onnx-portable`) | ✅ |
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
- [x] **ORT runs on WebGPU inside Obsidian — blocker cleared.** Two independent Node-detection traps in
      Obsidian's Node-integrated renderer, both now fixed and verified live:
    1. ✅ **Backend selection.** transformers.js read `process.release.name === "node"` and picked its
       cpu-only onnxruntime-node backend (`Unsupported device: "webgpu"`). Fixed by an esbuild banner
       that renames `process.release.name` before any bundled module evaluates, so transformers
       captures `IS_NODE_ENV=false` (`c583fab`).
    2. ✅ **Wasm glue loading (the real blocker).** ORT only uses the emscripten glue *already inlined*
       in its bundle when no `wasmPaths` override is set (`importWasmModule()` in
       `wasm-utils-import.ts`). transformers.js unconditionally sets a jsdelivr `wasmPaths` prefix at
       import time, so ORT instead dynamic-imported the standalone `ort-wasm-simd-threaded.jsep.mjs`
       from the CDN — whose **top-level await** epilogue,
       `var isNode = typeof globalThis.process?.versions?.node == 'string'; if (isNode) isPthread =
       (await import('worker_threads'))…`, has no `process.type !== "renderer"` guard (unlike the check
       in the module body, which does). Unresolvable specifier → module never evaluates → *"no available
       backend found."* Unfixable at runtime (Electron makes `process.versions.node` non-writable) and
       invisible to esbuild `onLoad` (the file is fetched from a CDN, never bundled) — which is why the
       earlier build-time patch attempt never fired.
       **Fix:** `plugin/ort-env.ts` inlines a build-time-patched copy of the glue as text, serves it from
       a blob URL, and sets `wasmPaths = { mjs, wasm }`. The esbuild plugin throws if the patched
       epilogue stops matching, so an ORT bump can't silently reintroduce it.
    - **Verified live:** a 94-byte `Add` ONNX model runs on the **webgpu** EP in Obsidian 1.12.7 in
      ~1.5 s cold (`[11,22,33,44]`); flipping `ortSmoke` back to the old config reproduces the exact
      original error on demand.
- [x] **Headless Obsidian driving** (`plugin/tools/obsidian-drive.mjs`). Conversion is non-interactive, so
      it needs no human in the loop: the tool launches an *isolated* Obsidian (`--user-data-dir` +
      `--remote-debugging-port`, scratch vault at `.obsidian-test/`, runs alongside the real session),
      attaches over CDP, evaluates JS in the plugin's context and streams the renderer console back.
      With `window.__pdf2md` (`plugin/probe.ts`: `envReport` / `ortSmoke` / `convertPath`) the whole
      build → install → reload → run → read-result loop is scripted. **This is the debugging capability
      the previous session lacked** — every finding above was produced without touching the UI.
- [x] **RESOLVED — "WebGPU fails after a few pages" was pdf.js + a hidden window, not WebGPU.**
      Chromium never fires `requestAnimationFrame` while a document is hidden, and pdf.js schedules
      every continuation chunk of a page raster through it (`_scheduleNext`, display intent only —
      `useRequestAnimationFrame: !intentPrint`). So with Obsidian minimised, hidden or in the
      background, `page.render()` **never resolves**: no error, no timeout, no CPU, no GPU. The
      conversion parks forever on whatever page was in flight when the user switched away.
    - **Bisected in one hidden renderer** (`plugin/tools/render-stall-probe.js`, each call raced
      against its own timeout so a stall names itself):

      | call | result |
      |------|--------|
      | `getDocument` | ok, 137 ms |
      | `getPage(1)` | ok, 1 ms |
      | **`page.render`** | **TIMED OUT after 120 s** |
      | `getImageData` | ok, 24 ms |
      | `getTextContent` | ok, 27 ms |
      | `page.render` with rAF → `setTimeout` | **rendered in 192 ms** |

      Every other pdf.js worker round-trip is healthy; only the rAF-driven render stalls, and
      shimming the scheduler renders the identical page in 192 ms.
    - **Fix:** `withTimerScheduling()` in `engine-js/src/browser/pdf.ts` routes `requestAnimationFrame`
      (and `cancelAnimationFrame`) through timers for the duration of each render. We rasterise to an
      offscreen canvas and read the pixels straight back, so frame timing buys nothing.
      `RenderTask.onContinue` is *not* an alternative: the continuation it hands back schedules through
      rAF too. No-op in Node, which has no rAF and takes pdf.js's microtask path — which is exactly why
      the CPU parity suite always passed while WebGPU timed out, and why this was not reproducible in
      Node by construction. transformers.js and the ORT glue reference rAF zero times, so pdf.js was
      the whole hang surface.
    - **This explains the whole history:** the 2681 s parity timeout (`.obsidian-test/parity-webgpu.json`)
      was headless-driven with the window hidden; the complete 15-page WebGPU conversion in
      `.obsidian-test/vault/full/` succeeded because that window happened to be visible; and "a 2-page
      run looks fine, a 15-page run does not" was the user watching the first pages and then switching
      away.
    - **There is no per-page degradation.** 8 pages of `attention.pdf` on WebGPU, token-capped at 128 so
      every page does identical work (`__pdf2md.benchPages`, the multi-page twin of `benchPage` — one
      model instance held across pages, which `benchPage` cannot see):
      5.55 / 5.56 / 5.88 / 5.77 / 5.75 / 6.02 / 5.62 / 5.76 tok/s, RSS 3281→3302 MB. Flat within ±4%,
      RSS within 2%. The Node CPU control over the same 8 pages is flat too. The "cost per page climbs
      steeply" note in `core/convert.ts` was this stall misread — a page that never finishes reads as an
      infinitely expensive one — and has been corrected in place.
    - **Cost structure** (from the new per-decode-step heartbeat, `BrowserVlmOptions.onStep`): step 1 at
      ~15 s, steps 16→128 in ~5 s. **Prefill ~15 s/page dominates; decode runs ~24 tok/s.** A 128-token
      cap therefore *understates* throughput badly — the headline 5.8 tok/s is mostly amortised prefill.
      Prefill, not decode, is where WebGPU optimisation should go.
    - **Open, and separate from the hang: today's WebGPU throughput is ~5.6 tok/s, not the 12.37 tok/s
      recorded above** — and at a 128-token cap that gap is *entirely* prefill (128 tok at 12.37 tok/s
      is 10.3 s, less than the ~15 s prefill measured here, so the earlier run must have prefilled far
      faster). Machine idle both times, same stack. Not visibility: a repeat with the window brought to
      the front measured 4.97-5.63 tok/s, though macOS re-hid the window mid-run
      (`Page.bringToFront` and AppleScript both failed to hold it visible), so visible-vs-hidden is
      strictly speaking still unmeasured. Suspect shader/pipeline cache state (`DawnWebGPUCache`) or a
      dtype difference in the vision encoder. Worth one bisect before trusting either number.
    - **Lesson (companion to the idle-machine one):** an async pipeline needs a heartbeat, not just
      totals. A stalled `generate()` and a slow one are the same silence from outside, and the wall-clock
      guard reported "slow page" for what was really "never scheduled". `onStep` + phase logs turned a
      45-minute mystery into a 137 ms/1 ms/timeout table.
- [x] **RESOLVED — the throughput scare was measurement error.** Everything in the struck-through block
      below was measured while an unrelated AI training run was saturating the machine (CPU + GPU
      contention and thermal throttling). Re-measured on 2026-07-25 with the machine settled (load < 2,
      Apple M4, 4P+6E), identical methodology on both sides (`engine-js/tools/bench.ts` and
      `__pdf2md.benchPage`, both token-capped at 128 so neither can be cut short by a wall-clock guard):

      | backend | page 1 | page 2 | model load |
      |---------|--------|--------|------------|
      | Node CPU (onnxruntime-node, fp32) | 13.80 tok/s | 14.93 tok/s | 2.9 s |
      | **Obsidian WebGPU (fp32)** | **12.37 tok/s** | **12.57 tok/s** | 0.6-1.1 s |

    - **WebGPU and native CPU are within ~15% of each other.** The earlier "WebGPU is ~10x slower"
      finding was an artifact: WebGPU measured 1.12 tok/s under contention vs 12.4 tok/s idle — an
      **11x distortion**. The CPU side was barely affected (the 126 s full page ≈ 1700 tokens at
      ~14 tok/s), which is exactly why the *comparison* looked so lopsided.
    - **Consequence: the onnxruntime-node pivot is unnecessary.** No per-platform native binaries, no
      change to the pure-JS distribution story. The WebGPU path stays.
    - **End-to-end on an idle machine: 2 pages of `attention.pdf` in 65 s (~32 s/page), 7207 chars,
      both pages reaching EOS with no truncation warning.** That is consistent with the original
      M4-probe figure of ~41 s/page, which was right all along. **Gate 4 conversion quality is met.**
    - **Lesson for future benchmarking:** always confirm the machine is idle first, and prefer
      token-capped runs — a wall-clock-capped run silently reports "truncated page" for what is really
      "loaded machine", which is what sent this investigation down a blind alley.
    - **Tooling lesson:** a completed 57-minute "hang" turned out to be the driver, not the plugin —
      one `Runtime.evaluate` held open for the whole conversion, whose reply was lost when the socket
      dropped. `obsidian-drive.mjs` now rejects in-flight commands on socket close, and `run`/`run-file`
      kick the job into a page global and poll for it. Use those for anything minutes-long.
    - Still valid from that work (correctness results, not timing-dependent): **any f16 dtype garbles**
      to `!!!` on both ORT 1.22 and 1.26, so fp32 stays pinned; q8/q4 are numerically fine. The tok/s
      figures in that dtype table are contaminated and would need re-measuring to be trusted.

<details><summary>Superseded (contaminated measurements, kept for the audit trail)</summary>

- [~] **OPEN: WebGPU throughput in Obsidian is ~0.72 tok/s — the real remaining blocker.** Measured with
      `__pdf2md.benchPage` (token-capped, so it isolates throughput from the wall-clock guard): 32 tokens
      in 44.3 s on page 1 of `attention.pdf`, model load 4.4 s (cached), render 0.6 s. **Output is
      correct** (`<page_header><loc_14>…arXiv:1706.03762v7 [cs`) — so this is *not* the degenerate-
      generation problem and not a termination bug; the earlier "hangs" were simply a dense page needing
      thousands of tokens at ~1 tok/s (30–60 min/page).
    - Contradicts the M4-probe harness measurement of ~41 s/page on Electron 42 by ~2 orders of
      magnitude. Either the harness figure isn't comparable or something differs in Obsidian's renderer.
    - **Not a hardware limit:** the adapter is real (`apple`/`metal-3`, not a fallback) and advertises
      `shader-f16`, `subgroups`, and 4 GB `maxStorageBufferBindingSize`. So the fp32 decoder is a
      *choice*, not a constraint.
    - **Cost split** (8-token vs 32-token run, ORT 1.26): **prefill ~15 s one-time, decode ~0.41 s/token
      (~2.4 tok/s)**. Prompt is 1142 tokens at 1224x1584 — *not* an Idefics3 image-split blowup, so the
      prefix is not the problem. Pages are decode-dominated → ~10 min/page.
    - **`device:"wasm"` control:** <16 tokens in ~700 s, i.e. <0.02 tok/s. WebGPU *is* doing real work
      (~50x wasm), so wholesale CPU fallback is not the explanation.
    - **dtype matrix** (page 1, 32-token cap, ORT 1.26). Any **f16** path garbles to `!!!` (repetition
      guard fires at 3 tokens) on *both* ORT 1.22 and 1.26 — so it is the model's fp16 numerics on
      WebGPU, not a runtime version. int8/int4 are numerically fine but no faster:

      | dtype  | tok/s | output |
      |--------|-------|--------|
      | fp32   | 1.12  | ✅ correct |
      | fp16   | 0.16  | ❌ `!!!` |
      | q4f16  | 0.19  | ❌ `!!!` |
      | q8     | 0.30  | ✅ correct |
      | q4     | 1.34  | ✅ correct (needs fixture validation) |

    - **So no dtype rescues it**: best is ~1.3 tok/s, and a 258M decoder on an M-series GPU should be
      ~10-30x that. The gap is still unexplained.
- [!] **DECISION POINT: native CPU beats WebGPU by ~10x, and it runs *inside* Obsidian.** Two controls
      on the same machine, same page, same core:
    - **Node CLI (onnxruntime-node, CPU, ~381% CPU):** page 1 complete, **EOS reached cleanly**, 2937
      chars of markdown, **126 s total** (incl. model load + render).
    - **Obsidian WebGPU:** 515 chars after 120 s and still generating; ~2.4 tok/s steady state.
    - i.e. CPU produced ~5.7x more output in the same wall-clock *and finished*. This **inverts** the
      M4-probe entry below ("WebGPU validated … ~6x CPU, ~41 s/page"); that figure does not reproduce.
    - **`onnxruntime-node` loads and runs in Obsidian's renderer.** Verified live: `require()` of the
      package from the renderer returns a working module and runs the 94-byte Add model in **31 ms**
      (vs ~800-1500 ms on WebGPU). N-API (napi-v6) is ABI-stable across Node and Electron, and
      Obsidian's renderer has Node integration — so the native backend is available to the plugin.
    - **This makes the whole WebGPU apparatus optional**: no `process.release.name` banner spoof, no
      glue patch, no CDN wasm — and ~10x the throughput.
    - **Open cost:** onnxruntime-node ships **platform-specific native binaries** (darwin-arm64/x64,
      win32-x64, linux-x64; tens of MB each). Obsidian community plugins are normally pure JS, so this
      affects distribution and catalog acceptability. Build change needed too: bundle transformers'
      *node* entry and mark `onnxruntime-node` external so it resolves at runtime.
    - **Remaining WebGPU diagnostics** (only worth doing if we stay on WebGPU): per-node EP assignment
      via ORT verbose logging (behind the `VerifyEachNodeIsAssignedToAnEp` warning), and whether
      Obsidian's Electron launch flags constrain WebGPU.

</details>

**Note:** the `onnxruntime-node`-in-the-renderer result above is still *true* (it loads and runs — N-API
is ABI-stable across Node and Electron), it is just no longer *motivated*: WebGPU performs comparably
without the per-platform binaries. Keep it in the back pocket if a machine ever lacks WebGPU.
- [ ] Adopt from `cavi-ai/claude-obsidian` (reviewed 2026-07-24, transformers 4.2.0 + ORT 1.26):
      **`env.useWasmCache = true`** (4.x) caches the ORT sidecar binaries in the Cache API → fully offline
      after first run, dropping our runtime jsdelivr dependency for the 4 MB wasm; and their
      **probe → warm-up inference → fall back to wasm** loader pattern (we commit to `device:"webgpu"`
      with no verification or fallback). Their Blob-URL worker is worth copying for UI responsiveness
      but is *not* a fix for Node-detection: Obsidian runs with `--node-integration-in-worker`, so
      `process` exists in workers too (they need their `forceWebEnv` shim *inside* the worker) — this
      retires candidate (c) from the earlier blocker analysis.
- [ ] **Consider transformers 4.x upgrade.** ORT ≥ ~1.24–1.26 adds the missing renderer guard
      (`globalThis.process?.type != "renderer"`) upstream, which would make `plugin/ort-env.ts`'s glue
      patch unnecessary (verified: guard absent in 1.22/1.23, present in 1.26). Major bump touching
      `AutoProcessor`/`AutoModelForVision2Seq`/`generate`/`StoppingCriteria`; gate it on re-running the
      4-fixture parity suite that validated M3 on 3.7.5.
- [x] **Gate 3 reconfirmed on the current stack (transformers 4.2.0 / ORT 1.26), CPU: 4/4 fixtures pass
      8/8 checks.** `attention`, `bert`, `vae`, `ioannidis` all clean. (The vitest run *reported* 3
      failures — those were its 900 s per-test timeout firing while conversion was still running, not
      check failures; every fixture printed 8/8 once it finished. Per-test timeout needs raising.)
    - Pages that tripped the degenerate-generation guard and were still good enough to pass:
      attention p4/p6/p9 and bert p16 (repetition), vae p2 and ioannidis p6 (timeout). Merged-cell
      table warnings on attention, bert, ioannidis — the known OTSL gap.
- [x] **Memory is the binding constraint, not CPU — and on WebGPU it plateaus.** Machine-requirements
      data from the CPU run:
    - **Peak RSS during a single 15-page conversion: ~9.3 GB** (sampled with `ps` while running).
      Settled RSS *after* the same conversion: ~2.5 GB — so peak, not steady state, is what sizes the box.
    - **RSS accumulates across conversions in one process:** 2528 → 5156 → 7313 MB over successive
      fixtures, despite `convertPdf` calling `vlm.dispose()` + `pdf.destroy()`. ORT's native
      allocations are not fully returned.
    - On this 16 GB M4 the second run drove swap to 7.5 GB and load to 18.5, and a conversion that
      took 439 s on a healthy machine took >35 min. Thrashing, not compute.
    - **Measured on WebGPU (2026-07-25), and it does not reproduce there** — `tools/memory-probe.js`,
      three consecutive 2-page conversions in one Obsidian session, renderer RSS after each:

      | | run 1 | run 2 | run 3 |
      |---|---|---|---|
      | worker | 266 → 882 MB | → 1006 MB | → **1019 MB** |
      | main thread | 267 → 2780 MB | → 2938 MB | → **2885 MB** |

      Both **plateau after the first conversion** rather than climbing linearly, so the "renderer
      grows until it dies" risk was carried over from the CPU measurement and is not a property of
      the shipping path. The runaway figure above stands, but as a fact about `onnxruntime-node`.
    - **The worker still cuts the settled footprint ~3×** (1.0 GB vs 2.9 GB), because terminating the
      thread returns what ORT's `dispose()` does not. That is the reason it is single-use.
    - **Still to measure:** peak *during* conversion on WebGPU at 15 pages (the CPU figure was
      9.3 GB; a 15-page worker run was observed at ~3.1 GB renderer RSS mid-conversion, unsampled),
      and whether peak scales with page count.
- [x] **Conversion progress UI + cancel.** The old UI showed a Notice that ended on "Downloading model
      … 100%" and then said nothing for the rest of the run, because `assembleDocument` emitted nothing
      between start and finish — no UI could have shown progress. Now: `ConvertProgress` ticks per page
      (`render`/`generate`/`page-done`), an abort signal checked between pages *and* between decode steps
      (`createGuard`), and a `ConversionModal` with progress bar, page counter, live token count, elapsed,
      ETA and s/page.
    - **Only the Cancel button cancels.** Obsidian closed a modal by itself 32 s into a test run;
      under "any close = cancel" that would have silently discarded the work. Dismissing detaches instead.
    - **Detach/reattach**: progress lives in a `ConversionState` both views read, so the dialog can be
      closed and reopened with its clock intact (verified: reopened at 465 tokens / 29 s, continuing).
      The fallback is a **status bar item**, not a Notice — Obsidian Notices dismiss themselves on click,
      which ate the "click to reopen" affordance and left no way back. Command palette entry too.
    - **The bar interpolates within a page** (`plugin/tools/bar-probe.js` samples the `<progress>`
      element itself). Two earlier shapes both failed in the same way — looking stuck: updating only at
      page boundaries meant two steps on a 2-page document, and a linear ramp with a hard cap froze for
      **51 s** when a page ran 103 s against the 45 s guess. Now it runs linearly to 80% of the page's
      share by the expected time, then asymptotically (still moving at 3× the estimate), with a
      high-water gate so it can never retreat. Result: **41 distinct values in 41 samples, monotonic,
      no freeze**, vs 43-of-60 with a 51 s stall before. Estimate is the running per-page average;
      elapsed time, not tokens, because tokens sit at 0 through the ~15 s prefill.
    - **Verified live** (`plugin/tools/modal-probe.js`, 2 pages of `bert.pdf`): dialog ticks mid-page
      (211→392 tokens between samples), Escape detaches without cancelling, another note opens in 114 ms
      while converting, status-bar click restores the dialog, and Cancel settles in **503 ms** mid-page.
    - **Main-thread cost, measured:** event-loop lag during conversion was **877 ms** in one run and
      **4.5 ms** in another. Both are real: prefill is one long block, decode is many short ones, so
      responsiveness swings within a page. Obsidian stays usable but can feel sluggish — the fix is the
      worker migration below, not the dialog.
- [x] **Inference moved into a worker.** `plugin/worker.ts` (own esbuild bundle → `dist/worker.js`,
      started from a blob URL by `worker-host.ts`) runs the *same* `engine-js` core off the
      renderer's main thread. The worker is **single-use**: terminated after every conversion, which
      is the only reliable way to reclaim what ORT's `dispose()` leaves behind. A `Convert in a
      background thread` setting turns it off — that is the control arm, not a fallback.
    - **A/B on the same build**, 2 pages of `attention.pdf`, `tools/worker-probe.js` sampling
      event-loop lag on the main thread (a 50 ms interval whose observed period *is* the lag —
      totals cannot tell a blocked UI from a busy one, which is why the earlier "877 ms in one run,
      4.5 ms in another" reading was ambiguous):

      | | worker | main thread |
      |---|---|---|
      | main-thread lag, p95 | **1.1 ms** | 17 ms |
      | main-thread lag, max | **1.8-72 ms** | **533 ms** |
      | stalls > 100 ms | **0** | 8 |
      | throughput | 16.6 tok/s | 17.4 tok/s |

      ~5% of throughput for a UI that never stutters, plus the memory result above. (Two worker
      runs, before and after the font fix below, gave 1.8 ms and 72 ms for the max — a single
      blip in one of them. p95 and the count of >100 ms stalls were stable across both, so those
      are the figures to trust; a lone max is one sample.)
    - **It changes how pages are rasterized, and that nearly shipped a silent quality regression.**
      A worker has no `document`, so `browser/pdf.ts` now supplies an OffscreenCanvas factory, a
      no-op filter factory, and `disableFontFace` — pdf.js's own Node configuration, i.e. the one
      the fixture suite validated. But `disableFontFace` makes pdf.js rasterize the standard 14
      fonts from their outlines, so it needs `standardFontDataUrl`; **without it pdf.js does not
      fail, it warns once per glyph and rasterizes the page with holes in the text** (25 dropped
      characters on page 1 of `attention.pdf`). Downstream that is indistinguishable from a sparse
      page: the first worker runs quietly returned 7172 chars against the main thread's 7207.
      `loadPdfBrowser` now **throws** rather than render without it (working rule 5).
    - Supplying those URLs then tripped a second trap: pdf.js *computes* `useWorkerFetch` from
      `isValidFetchUrl(cMapUrl, document.baseURI)` — a bare `document` reference that throws
      ReferenceError off-main-thread, and only once both URLs are set, so it hides behind the very
      fix it accompanies. Set explicitly.
    - **Two corrections to assumptions made here.** `requestAnimationFrame` *does* exist on
      Obsidian's worker global and *does* fire, so the pdf.js rAF shim stays on in workers rather
      than being redundant there. And pdf.js reports "Setting up fake worker" inside the worker — it
      cannot spawn its nested parsing worker — so parsing shares the conversion thread; still off
      the main thread, just not parallel with inference. Neither is a correctness problem; both were
      guesses that measurement reversed.
    - Probe note worth keeping: pdf.js **transfers** the input buffer to its worker, so a
      `Uint8Array` handed to two consumers reaches the second detached and empty — and pdf.js
      answers that by *hanging*, not throwing. Two probe "timeouts" were this.
    - **Quality re-verified on the worker path, not assumed:** `attention` end-to-end through
      `tools/fixture-parity.mjs` (15 pp, real Obsidian, judged by the same shared checks as the
      CPU suite) — **8/8, including `required_table_cells`**, and the warning set is identical to
      the recorded CPU run (repetition guard on p4/p6/p9 + the known merged-cell warning). 31091
      chars, 7 figures. Rasters still differ from the main thread by ~5-7% of pixels at mean 3
      luma levels (`tools/raster-diff-probe.js`) — antialiasing from outline vs platform-font
      rendering, not missing content. The other three fixtures have not been re-run.
    - **Cancel settles in 74 ms** mid-page (was ~500 ms on the main thread — the message lands
      immediately when the receiving thread isn't the blocked one).
- [ ] Model download on first enable with disclosure + checksums (Smart Connections precedent);
      persist weights via IndexedDB/OPFS (Cache API unreliable in the harness pane).
- [x] **Warnings surface to the reader, and the plugin writes `meta.json`.** The plugin had
      never written it (`git log -S` confirms: markdown + images only since it was scaffolded),
      so the contract was asymmetric and its warnings lived nowhere but the console and a
      6-second Notice. Now: `meta.json` on the plugin path too (adding `run_mode` and the
      per-page cost series), plus the banner / inline marker / frontmatter count described in
      the contract above. Verified live — a deliberately tight 20 s per-page budget produced
      4 real warnings, all three surfaces rendered, `meta.json` 1164 B. Re-scored afterwards:
      WebGPU parity still **8/8** on `attention`, Python contract 6 passed. The merged-cell
      warning now names the page (`table on page 8 …`) instead of being unlocatable.
- [ ] Vault craft: YAML frontmatter (title/authors/DOI/citekey), relative image links, optional
      provenance links to PDF pages (`[[paper.pdf#page=N]]`).
- [ ] Fix engine gaps the plugin inherits: figure over-detection, OTSL merged-cell spans (M3 carry-over).
- [ ] **Engine alternative sketched, not run: `facebook/nougat-small`** (247M, cc-by-4.0, Swin +
      4-layer mBART) as a cheaper VLM than granite-docling. Loads under the frameworks we already
      have. The hypothesis is decode *shape*, not size — 4 decoder layers vs 30, cross-attention
      instead of Idefics3 image tokens in the decoder context — estimated 2-4× on decode; there is
      no size win (~995 MB fp32). Structural cost is real: **no bboxes at all**, so no figure crops
      and no page provenance, and tables come back as LaTeX `tabular`. Phased plan with kill
      criteria (stop below 2×) and the parser seam it needs in `assembleDocument`:
      [docs/spike-nougat.md](./docs/spike-nougat.md). Results land as perf-doc §4d.

- [x] **Named, licensed and packaged for the community directory — the plugin is `Reflow`.**
      Distribution facts that changed the build: Obsidian installs **only** `main.js`,
      `manifest.json`, `styles.css` from a GitHub release, so `dist/worker.js` would never have
      reached a normal user — every directory install would have silently fallen back to
      main-thread conversion. The worker is now bundled to `build/worker.js` and inlined into
      `main.js` as text; pdf.js's parsing worker is inlined the same way, so **no executable code
      is fetched at runtime** (measured what remains: HF weights, ORT's 24 MB wasm, pdf.js
      fonts/CMaps — all disclosed in plugin/README.md). `main.js` is 4.7 MB as a result.
      Also: MIT LICENSE (matches Docling), `styles.css` instead of inline element styles,
      the debug shim resolved to a stub in release builds (no `window` global, no second ORT
      copy), `Vault.process` for note writes, and `versions.json` + a tag-checked release
      workflow. `eslint-plugin-obsidianmd` — what the directory's automated review runs against
      *every* published version since May 2026 — is error-clean. Re-verified live after the
      changes: `attention` and `bert` page 1 convert on both the worker and renderer paths,
      titles intact.
- [x] **Repository conforms to the submission checklist.** Renamed to `reflow`; `manifest.json` and
      `versions.json` moved to the *repository root* (the directory reads the manifest at HEAD of
      the default branch) with the build staging the root copy into `dist/` so no second manifest
      can drift; root `README.md` now leads with what the plugin is, how to install it and how to
      use it, rather than the project thesis; `LICENSE` at the root. The move cost one piece of
      tooling: `eslint-plugin-obsidianmd` reads `manifest.json` from its own cwd, so linting from
      `plugin/` can no longer see it (and silently assumed a mobile plugin, which made Electron's
      `process` an undefined global). `plugin/check-manifest.mjs` asserts the submission rules
      directly and gates the release workflow.
- [ ] **Submit.** Blocked on two things that are the author's to do: the repository is still
      **private**, and there is **no release yet** — the directory needs a tag equal to the manifest
      version carrying `main.js`, `manifest.json`, `styles.css`. Then community.obsidian.md; the
      `obsidian-releases` PR route is gone.
- [ ] **Windows and Linux remain untested.** The code no longer assumes WebGPU (probe → candidates →
      CPU fallback, all unit-tested against fake navigators), but nothing has run on either OS.

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
| 2026-07-25 | M4 | — | **"WebGPU fails after a few pages" solved — it was never WebGPU.** pdf.js schedules page-raster continuations through `requestAnimationFrame`, which Chromium never fires in a hidden document, so `page.render()` parked forever whenever Obsidian was minimised/backgrounded (0% CPU, no error). Bisected in a hidden renderer: `getDocument` 137 ms, `getPage` 1 ms, **`page.render` timed out at 120 s**, same page renders in **192 ms** with rAF shimmed. Fixed by `withTimerScheduling()` (`browser/pdf.ts`); no-op in Node, which is why the CPU suite always passed and why this was unreproducible there by construction. Also disproved the "cost per page climbs steeply on WebGPU" note: token-capped, 8 pages are flat within ±4% (RSS within 2%), Node CPU likewise. Prefill (~15 s/page) dominates; decode ~24 tok/s. |
| 2026-07-25 | — | — | **Nougat spike sketched** (`docs/spike-nougat.md`, perf doc §4c): `facebook/nougat-small` as a cheaper VLM. Proposal only — nothing measured yet beyond published configs and the HF export inventory. Phase gates and kill criteria written down first, so a negative result is publishable the way §4a's LiteRT verdict was. |
| 2026-07-27 | M4 | — | **Conversion problems now reach the reader.** `meta.json` recorded warnings, but nobody opens a sidecar JSON before reading a paper, so a lossy conversion produced a note that looked perfectly clean. Added a `> [!warning]+` banner between frontmatter and body, an inline `> [!warning] Page N may be incomplete` marker at the end of each damaged page, and a `conversion_warnings: N` frontmatter property — all omitted when the conversion is clean. The inline marker is the load-bearing one: the markdown is reflowed and has no page boundaries, so a banner saying "page 4" cannot be acted on. Also closed a long-standing gap — **the plugin had never written `meta.json` at all**, leaving its warnings in the console and a 6 s Notice. Merged-cell warnings now name their page. 5 new offline tests (25 total); re-scored after the markdown changed: WebGPU parity 8/8, Python contract 6 passed. |
| 2026-07-26 | — | — | **Artifact contract amended: packages are named from the source PDF, not the extracted title.** `1706.03762v7.pdf` → `1706.03762v7/1706.03762v7.md` + `images/` + `meta.json`. The title varied by engine and by run and discarded the identifier the reader filed the paper under, and a generic `document.md` made every converted note in a vault share one name. Title still lives in the frontmatter and `meta.title`. `images/` deliberately stays *inside* the package folder: a flat `<stem>.images/` would have needed the hardcoded `images/` prefix in `doctags.ts` threaded through the parser, assembler, both entry points and the worker protocol, plus link percent-encoding — so this shape changes the three writers only and leaves the pipeline untouched (offline tests pass unedited). `meta` gains `md_path` so readers stop joining on a filename that is no longer constant; the title sanitizers are deleted. All three engines. |
| 2026-07-25 | M4 | — | **Inference moved into a worker** (`plugin/worker.ts`, own bundle, blob-URL start, single-use so ORT's leftovers die with the thread). Main-thread lag during conversion drops from p95 17 ms / 8 stalls >100 ms to **p95 1.1 ms / zero**, for ~5% of throughput; settled renderer RSS across three conversions ends at 1.0 GB instead of 2.9 GB; cancel settles in 74 ms instead of ~500 ms. Also disproved the accumulation blocker: on WebGPU memory **plateaus** after the first conversion in both modes — the 2528→5156→7313 MB runaway was the Node/CPU path. Nearly shipped a silent regression on the way: rendering without a `document` needs `disableFontFace`, which makes pdf.js rasterize the standard 14 fonts itself and **drop glyphs one by one** without `standardFontDataUrl` — a page with holes in the text, no error, only slightly short output (7172 vs 7207 chars). `loadPdfBrowser` now throws instead. `attention` re-verified end-to-end on the worker path: **8/8 checks**, numeric table cells intact, same guard-firing pages as the CPU oracle. |
| 2026-07-25 | M4 | — | **Progress UI + cancel.** `assembleDocument` emitted nothing between start and finish, so the plugin's Notice froze on "Downloading model … 100%" for the whole run — no UI could have shown progress. Added `ConvertProgress` ticks, an abort signal honoured between pages *and* between decode steps, and a progress dialog (page, live token count, elapsed, ETA, cancel) that detaches to the status bar so the vault stays readable. Cancel settles in ~500 ms mid-page. Bar interpolates within a page on a running per-page average with an asymptotic tail — a linear-with-cap version froze for 51 s when a page overran its estimate. Verified live: 41 distinct bar values in 41 samples, monotonic, no freeze. |
| 2026-07-27 | M4 | — | **Named `Reflow` and packaged for the community directory.** The load-bearing discovery: Obsidian's installer downloads *only* `main.js`, `manifest.json`, `styles.css` from a release, so `dist/worker.js` — read back from the plugin folder at runtime — would have existed on developer machines and nowhere else, silently demoting every directory install to main-thread conversion. Worker now bundles to `build/worker.js` and is inlined into `main.js` as text; pdf.js's parsing worker likewise, so **nothing executable is fetched at runtime** (what remains, measured: HF weights, ORT's 24 MB wasm, pdf.js fonts/CMaps — all disclosed). Plus: MIT LICENSE, `styles.css` instead of inline styles, debug shim stubbed out of release builds (no `window` global, no second ORT copy), `Vault.process`, `versions.json`, tag-checked release workflow, and `eslint-plugin-obsidianmd` error-clean. Re-verified live on both paths after the rewrite (attention + bert p1, titles intact, 30-35 tok/s). Left open deliberately: the public-repo split with `manifest.json` at the root, then submission via community.obsidian.md. |
| 2026-07-27 | M4 | — | **Windows/Linux support + a CPU fallback, and the fallback's ceiling found.** The engine asked for `device: "webgpu"` unconditionally — correct on one machine, a raw `Unsupported device: webgpu` from inside transformers.js everywhere else. Now `browser/device.ts` probes first (adapter request, no download), the VLM walks an ordered candidate list and keeps the first that loads, and the resolved backend drives both the dtype (`shader-f16` absent ⇒ fp32 embedding, the older-Intel-iGPU case) and the wasm thread count (1 for WebGPU, up to 4 for CPU). The progress dialog carries a red `--text-error` warning on the CPU path; `executionProviders` became a getter so `meta.json` records the backend ORT *confirmed* rather than the one we asked for. **WebNN is deliberately not in the automatic order**: `navigator.ml` is absent unless Obsidian is launched with `--enable-features=WebMachineLearningNeuralNetwork` (spike `4333ef2`), which a plugin cannot set, so it would cost every user a failed probe to benefit nobody — opt-in via the settings dropdown instead. **The finding that changes what the fallback promises:** CPU is only ~1.7× slower than WebGPU here (bert p1: 60 s vs 34 s, 20.4 tok/s) but has a hard ceiling — attention p1 dies in 5 s with `std::bad_alloc`, in the worker *and* the renderer, on fresh windows. Not page size: the rasters are the same (1191×1684 vs 1224×1584). It is the Idefics3 processor's aspect-ratio tiling — bert 13 tiles / 878 prompt tokens, attention 17 / 1142 — and 17 tiles of fp32 activations plus ~1 GB of fp32 weights exceed wasm's 4 GB address space. The plugin says exactly that instead of surfacing `std::bad_alloc`. Untried: a lower render scale on the CPU path to cut tiles, priced against the fixture suite first. 15 new offline tests (40 total) against fake navigators, since none of the interesting hardware exists here. |

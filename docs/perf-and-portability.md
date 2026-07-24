# Performance & portability research — cutting runtime, and the JS/ONNX path

*2026-07-22. Research notes for two questions: (1) how to reduce the resource/runtime cost of the
current Python Docling bootstrap while keeping most of the quality, and (2) how the engine could run
fully in JavaScript via ONNX — Obsidian desktop plugin first, then browser extension, then mobile.
Sources linked inline; local measurements on the M4 Air 32 GB.*

---

## 1. Where the cost is today (measured + source-verified)

Baseline: `attention.pdf`, 15 pages, math-heavy. Warm cache, docling 2.114, defaults
(`ACCURATE` tables, formula enrichment on, `images_scale=2.0`, OCR off).

| Configuration | Wall time | s/page |
|---|---|---|
| Full pipeline (formulas on) | 161 s | ~11 |
| `--no-formulas` | 107 s | ~7 |

(Both runs taken while another agent was running tests on the same machine, so absolute numbers are
somewhat inflated; the *ratio* is still informative. The Docling tech report gets ~0.4–0.8 s/page
for the base pipeline on an M3 Max — our base path has significant headroom.)

Why the base path is slow — verified in the installed docling 2.114 source:

- **Layout (heron, 164 MB)** runs on **MPS** (`device=auto` resolves to MPS — confirmed locally).
- **TableFormer (in docling-models, 342 MB)** is **forced to CPU** — the source contains
  `# Disable MPS here, until we know why it makes things slower`
  (`stages/table_structure/table_structure_model.py`). Typical tables cost 2–6 s *each* on CPU
  ([tech report](https://arxiv.org/html/2408.09869v5)). [Issue #3202](https://github.com/docling-project/docling/issues/3202)
  reports **14×** on M-series (PyTorch 2.11) from simply removing that fallback.
- **CodeFormulaV2 (610 MB, 0.3 B-param VLM)** is **forced to CPU** too (its transformers VLM engine
  lists no MPS support) and runs autoregressively per formula crop with a **hardcoded
  `max_new_tokens=2048`**. Degenerate repetition on noisy crops is a known pathology; capping to
  ~512 tokens gave **5×** on a math-heavy paper in
  [discussion #1254](https://github.com/docling-project/docling/discussions/1254).
- `AcceleratorOptions.num_threads` defaults to **4** (the M4 has 10 cores); overridable via
  `DOCLING_NUM_THREADS`.

So the two most expensive stages run on CPU by upstream design, on a machine with a perfectly good
GPU. That — not model size per se — is the main resource problem.

To get a real per-stage split on our fixtures: `settings.debug.profile_pipeline_timings = True`
([discussion #2516](https://github.com/docling-project/docling/discussions/2516)); worth recording
into `meta.json` per convert.

---

## 2. Track 1 — make the current pipeline cheap (keep the modular architecture)

Ranked by leverage ÷ effort. Quality risk is assessed against the existing fixture tests
(Gate 1 checks: numeric table fidelity, LaTeX render-parse rate, heading hierarchy, figures).

| # | Change | Expected effect | Quality risk | Effort |
|---|---|---|---|---|
| 1 | **Formula enrichment → `granite_docling` preset + `mlx-vlm`.** Docling 2.114's `CodeFormulaVlmOptions.from_preset("granite_docling")` has an MLX export in its model spec, and the `AUTO_INLINE` engine picks MLX on Apple Silicon when `mlx_vlm` is installed. Replaces the CPU-bound CodeFormulaV2 with a GPU (Metal) path; #3202 measured **17.4×** MLX vs CPU-transformers for VLM stages. Also drops 610 MB → 258 M-param model. | Formula stage: minutes → seconds | Low–medium: granite-docling equation F1 = 0.968 vs CodeFormula quality unmeasured head-to-head — our LaTeX render-rate test is the arbiter | Small (config + dep) |
| 2 | **Cap `max_new_tokens` 2048 → ~512** for formula enrichment (class attr patch; not exposed as config). Kills the degenerate-repetition tail. | Up to 5× on pathological docs ([#1254](https://github.com/docling-project/docling/discussions/1254)) | Low: 512 tokens is generous for a display equation; truncation shows up in the LaTeX-rate test | Trivial |
| 3 | **`DOCLING_NUM_THREADS=8`** (default 4). | Free speedup on all CPU stages | None | Trivial |
| 4 | **TableFormer `mode=FAST`** (default is ACCURATE), and/or experimentally remove the 3-line MPS fallback (upstream [#3202](https://github.com/docling-project/docling/issues/3202) claims 14×). | Tables: several s/table → sub-second | FAST mode: measurable — run the numeric-fidelity test on the table fixture. MPS patch: quality-neutral but needs eyeballing (upstream disabled it for speed, not correctness) | Small |
| 5 | **`pypdfium2` backend** instead of the default parser. | ~2× base pipeline, ~2.5× less RAM (tech report) | Text-layer parity to verify on fixtures | Small |
| 6 | **OCR (when enabled): `ocrmac`/Apple Vision.** Docling auto-selects it on macOS when installed — zero model downloads, ANE-fast. RapidOCR (ONNX, tens of MB) is the cross-platform lightweight fallback vs EasyOCR's ~100 MB. | OCR path much faster, −100 MB models | Low | Trivial |
| 7 | Layout: leave heron on MPS. (If a CPU-only context ever matters: **egret-m** is 19.5 M params, ~3× faster on CPU, mAP 0.765 vs heron's 0.776 — [layout paper](https://arxiv.org/html/2509.11720v1).) | Minor here | ~1 pt mAP | Config |

**Quantization status of the existing stack** (asked specifically about quantized models):

- Layout: official ONNX export exists ([docling-layout-heron-onnx](https://huggingface.co/docling-project/docling-layout-heron-onnx),
  Apache-2.0) and 2.114 has an onnxruntime engine wired to it — but CPU-provider only on macOS, so
  it's a portability asset (see Track 3), not a Mac speedup.
- TableFormer: no official quantized build; a community JPQD-quantized ONNX exists
  ([asmud/ds4sd-docling-models-onnx](https://huggingface.co/asmud/ds4sd-docling-models-onnx)) but
  isn't loadable by docling without custom glue.
- CodeFormulaV2: no quantized/ONNX/MLX export at all — another reason item 1 (swap the model)
  beats quantizing in place.
- No published int8-accuracy studies for any of these; our fixture tests would be the measurement.

**Realistic outcome for Track 1:** items 1–4 together should take the math-heavy fixture from
~161 s to roughly **25–45 s** (~2–3 s/page), with model downloads shrinking from ~1.1 GB toward
~0.7 GB. Each item is independently testable against the fixture suite, so quality regression is
measured, not guessed.

**Smaller formula-model alternatives considered and parked:** pix2tex/LaTeX-OCR (25 M, MIT) is far
weaker (ExpRate 0.12 vs UniMERNet 0.48); texify/Marker models are license-excluded (GPL +
revenue-capped weights); PP-FormulaNet-S (58 M, Apache) is fast but drags in the Paddle runtime.
None are drop-in for docling; granite-docling as the enrichment model (item 1) dominates this
option space.

---

## 3. Track 2 — the compact-VLM option (one model instead of four)

[Granite-Docling-258M](https://huggingface.co/ibm-granite/granite-docling-258M) (Apache-2.0,
successor to SmolDocling): full page image → **DocTags** (layout classes + reading order + bboxes +
OTSL table tokens + LaTeX + OCR text) in a single generation pass. It could replace the entire
modular pipeline — and it is the linchpin of the JS story (§4).

Quality (model card, docling-eval): tables TEDS 0.97/0.96 (≈ TableFormer parity in-distribution),
equations F1 0.968, code F1 0.988, layout mAP 0.27, full-page OCR F1 0.84. Notable:
[granite-docling-2stage-258m](https://huggingface.co/docling-project/granite-docling-2stage-258m)
(RT-DETR layout first, then bbox-guided VLM) exists precisely because the pure end-to-end model is
fragile out-of-distribution — it improves layout mAP 0.27→0.31, OCR edit-distance 0.45→0.27, and
"avoids infinite loops more effectively." For our hard requirement (reading order on two-column
papers), **the 2-stage hybrid is the strongest quality candidate**.

Speed on Apple Silicon: transformers+MPS is pathological (~100 s/page — small hidden size makes it
dispatch-bound); **MLX is the fast path**: ~390 tok/s on M3 Max ⇒ **~4–10 s/page** for typical
DocTags densities via docling's `VlmPipeline`
([vision-models docs](https://docling-project.github.io/docling/usage/vision_models/),
[discussion #37](https://huggingface.co/ibm-granite/granite-docling-258M/discussions/37)).
Footprint: one 631 MB bf16 MLX model (or 133–317 MB GGUF quants) vs our ~1.1 GB stack.

Honest caveats vs the modular pipeline:

- **Silent-wrongness risk inverts.** A VLM can *invent* plausible numbers in table cells — exactly
  what our "never silently wrong" principle forbids. The modular pipeline copies cell text from the
  PDF text layer. This is the single biggest reason to keep the modular path as the desktop default
  until the fixture numeric-fidelity test says otherwise.
- Residual repetition/infinite-loop failures on dense out-of-distribution pages.
- Figures: the VLM emits bbox+caption only; crops come from the page raster, and there's an open
  bug ([#2416](https://github.com/docling-project/docling/issues/2416)) where `images_scale>1.0`
  mis-crops — figure images are effectively low-res for now.
- **Quantization quality is unmeasured.** Nobody has published TEDS/formula numbers for q4/q8
  variants; SmolDocling's quantized ONNX had a "gibberish output" report. Rule: **q8/fp16 decoder
  floor, fp16 vision tower; treat q4 as experimental** and gate it on our fixture tests.

Other models surveyed and ruled out for this project: MinerU 2.5 (1.2 B — great quality, 5× the
size, no browser story), PaddleOCR-VL 0.9 B (Paddle runtime), Nanonets-OCR (3.7 B + license
ambiguity), olmOCR-2 (7 B), Marker (license). Granite-Docling is the only doc-conversion model in
its class with an official ONNX export, an official browser demo, and a permissive license.

---

## 4. Track 3 — fully-in-JavaScript via ONNX (Obsidian → browser → mobile)

**The key external fact:** IBM already ships the hard part.
[onnx-community/granite-docling-258M-ONNX](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
(Apache-2.0; vision encoder + embed + merged decoder; fp32 ≈ 1.03 GB, fp16 ≈ 515 MB, int8 ≈ 260 MB,
**q4f16 ≈ 190 MB**) runs under transformers.js, and IBM's own
[granite-docling-258M-WebGPU Space](https://huggingface.co/spaces/ibm-granite/granite-docling-258M-WebGPU)
is a fully client-side demo with IndexedDB weight caching. transformers.js v4 (Feb 2026) unified
browser/Node/Electron execution and rewrote the WebGPU runtime with the ORT team.

**What does not exist and we must build (shared across every JS target):**

1. **DocTags → Markdown in JS/TS.** Python-only today (`docling-core`). The grammar is small and
   regular (flat tags, `<loc_*>` tokens, OTSL cell tokens, LaTeX inside `<formula>`); OTSL span
   handling is the only fiddly part. Days-not-weeks; our fixture suite is the spec.
2. **PDF page handling in JS: pdf.js** (Apache-2.0; Obsidian already embeds it). Rasterize pages to
   canvas for the VLM; `getTextContent()` gives a positioned text layer for a future modular/fast
   path; figure images = canvas crops of predicted bboxes. (MuPDF WASM is AGPL — avoided.)
3. A small orchestration layer: page loop, DocTags stitching across pages, frontmatter, the
   existing `_fix_formula`-style MathJax repairs, `meta.json`.

### Per-target assessment

| Target | Runtime | Feasibility today | Expected speed |
|---|---|---|---|
| **Obsidian desktop plugin** | transformers.js v4 → onnxruntime-node (CPU/CoreML) or WebGPU in renderer | ✅ no blockers | best JS-side speed; Electron 39 has WebGPU |
| **Chrome extension (MV3)** | offscreen document / side panel + WebGPU; SW routes events only | ✅ no blockers | ~30–90 s/page WebGPU (q4f16); WASM-only too slow for VLM |
| **Obsidian mobile plugin (iOS)** | WKWebView: single-threaded WASM; **no WebGPU before iOS 26** | ⚠️ defer | minutes/page — not viable for the VLM yet |
| **Native iOS app** | MLX-Swift (VLM support confirmed) or llama.cpp/Metal with existing GGUF | ✅ viable | plausibly ~5–20 s/page on iPhone 15 Pro+ |

**Obsidian desktop (build first, clean):**
- Thin plugin: pdf.js rasterizes → transformers.js runs granite-docling ONNX → JS DocTags parser →
  vault package (same artifact contract; `meta.json.engine = "onnx-portable"`).
- Prefer transformers.js's Node path (onnxruntime-node) inside Electron over renderer WASM — faster
  and avoids native-module packaging pain (v4 handles this); feature-detect `navigator.gpu` for
  WebGPU (old Obsidian installers ship old Electron).
- Weights downloaded on first enable with disclosure + checksums — the **Smart Connections plugin
  precedent** shows plugin review accepts download-on-first-run (policies ban remote *code*, not
  data). No sidecar binary, no Python: this is strictly cleaner than the M3 sidecar plan and could
  replace it if quality parity holds.
- Run inference in a worker; process pages sequentially to bound memory.

**Browser extension:** same core, hosted in an offscreen document/side panel (MV3 service workers
can't run ORT/WebGPU); bundle the ORT `.wasm` artifacts and set `wasmPaths` (CSP);
`unlimitedStorage` + OPFS/IndexedDB for the ~190 MB q4f16 weights. On non-WebGPU machines, degrade
to a pdf.js-text-only fast path rather than attempting VLM-on-WASM.

**iOS:**
- **Share extension has a ~120 MB memory cap — inference in-extension is impossible.** Correct
  architecture: extension writes the PDF to an App Group container and hands off to the main app
  (this is the standard pattern; not a project-killer).
- In-app inference: **MLX-Swift** (SmolVLM-class support confirmed in mlx-swift-lm) or llama.cpp
  Metal with the existing granite-docling GGUF. Core ML/ANE is currently blocked (coremltools fails
  on the vision encoder's `unfold` op), so GPU-not-ANE for now.
- Downloading weights post-install is App Store-legal (2.5.2 bars executable code, not model data).
- **Obsidian mobile plugin:** revisit when Obsidian's WKWebView gets WebGPU (iOS 26+) — the JS core
  built for desktop carries over unchanged; until then WKWebView jetsam budgets (~300 MB–1 GB) plus
  single-threaded WASM make the VLM route minutes-per-page. The iOS app is the nearer mobile path.

### Suggested sequencing (fits the existing milestone ladder)

1. **Now (M1-adjacent):** apply Track 1 items 1–4; record per-stage timings in `meta.json`; let the
   fixture tests price the quality delta of each change.
2. **M1.5 quality experiment:** run granite-docling (MLX, via docling `VlmPipeline`) and the
   2-stage variant over the same fixtures; score with the same tests. This one experiment prices
   the entire VLM-vs-modular question — and quantized (q8/q4f16) variants too — using
   infrastructure we already have.
3. **M3/M4 merge:** if (2) passes, the ONNX plugin path *is* the portable engine — build the JS
   DocTags parser + pdf.js loop as a standalone TS library (`engine-js/`), test it against the same
   fixtures for parity, then wrap it as the Obsidian plugin. Rust/`ort` remains the fallback if VLM
   quality fails and we must port the modular pipeline instead (heron ONNX exists; TableFormer ONNX
   is community-only; CodeFormula has no export — that asymmetry is itself an argument for the VLM
   route in JS).
4. **Later:** Chrome extension (same core, different shell) → iOS app (share-sheet handoff +
   MLX-Swift) → Obsidian mobile plugin when WKWebView WebGPU lands.

---

## 4b. Measured: engine-js on the onnxruntime-node CPU provider (M2, 2026-07-23)

First end-to-end runs of the TS engine (`engine-js/`, granite-docling-258M-ONNX under
transformers.js → onnxruntime-node) on the M4 Air, `attention.pdf` page 1. **Finding: on the ORT
CPU provider, every quantized variant fails — fp32 is the only correct option, and also the
fastest correct one.**

| dtype (uniform) | Result | s/page |
|---|---|---|
| `q4f16` (WebGPU default) | **Garbage** — degenerate repetition, zero DocTags tokens | ~140 |
| `q8` (`_quantized`, int8) | **Garbage** — "atXv 1706.03762", repetition, BLEU numbers lost | ~430 (slower!) |
| **`fp32`** | **Correct** — clean DocTags, title extracted, 28.4/41.8 BLEU preserved, running-header dropped | ~250 |

Notes:
- `q4f16`/`fp16` are WebGPU-oriented; the ORT CPU provider mishandles the fp16/q4 matmuls (and the
  fp16 vision encoder additionally trips `SimplifiedLayerNormFusion` at load — worked around by
  disabling graph optimization on that path only).
- The decoder ships only `fp32/fp16/q4/q4f16/quantized` (no `_int8`), so the CPU int8 option is
  `q8`→`_quantized` — and it is both wrong and slower here (matches the SmolDocling quantized-ONNX
  gibberish reports, §3).
- **Implication:** the Node/CPU CLI is correct at fp32 but ~4 min/page — fine as the M3 parity
  harness (run the fixture suite in the background), **not** interactive.

### WebGPU — validated (same day, `engine-js/web/` harness)

Ran the identical pipeline (pdf.js + transformers.js + **our** JS DocTags parser) in the in-app
browser pane — **Electron 42 / Chrome 148, `shader-f16: true`**, i.e. the exact Obsidian-desktop
renderer environment. `attention.pdf` page 1:

| transformers.js | decoder dtype | vision dtype | Result | s/page |
|---|---|---|---|---|
| 4.2.0 | q4f16 | fp16 → fp32 | **Garbage** — 4096× "!" (constant token) | 67–76 |
| **3.7.5** | **fp32** | **fp32** (embed fp16) | **Correct** — clean DocTags, title extracted, 28.4/41.8 BLEU, "Łukasz" intact | **~41** |

- **Two fixes, both from IBM's own WebGPU Space config:** pin transformers.js **3.7.5** (4.2.0 emits
  all-"!" on this model — a 4.x regression), and use an **fp32 decoder**, *not* q4f16. So the earlier
  "q4f16 ≈190 MB" default was wrong on both providers: q4f16 garbles on CPU *and* WebGPU here. The
  known-good WebGPU config is `{embed_tokens: fp16, vision_encoder: fp32, decoder_model_merged: fp32}`
  (~1 GB), the same dtypes IBM ships.
- **WebGPU is ~6× the CPU fp32 speed** (41 s vs 251 s/page) and quality-equal — the real usable-speed
  path, confirmed in the M4 (Obsidian/Electron) target environment. Revisit q4/q4f16 as a size win in
  M3, gated on the fixture tests (they fail today).
- Caveat: the browser's Cache API errored on the ~1 GB weights in this pane (no persistence → re-download
  each load); a real plugin uses IndexedDB/OPFS (IBM's Space does) and caches fine.

---

## 4a. Runtime alternative evaluated: LiteRT.js (Google, Jul 2026) — verdict: stick with ONNX, watch

Google announced [LiteRT.js](https://developers.googleblog.com/litertjs-googles-high-performance-web-ai-inference/)
(npm `@litertjs/core`), a browser JS binding of LiteRT that runs `.tflite` models on WebGPU / WebNN /
WASM-XNNPACK. Evaluated as a replacement for transformers.js+ONNX; **decision: keep ONNX**, for
reasons of model availability, not runtime quality:

- **No granite-docling `.tflite` exists.** Only the [official ONNX export](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
  is published/maintained. The Idefics3 architecture *is* convertible in principle — a sibling,
  [litert-community/SmolVLM-256M-Instruct](https://huggingface.co/litert-community/SmolVLM-256M-Instruct),
  was converted via `ai-edge-torch` with KV cache — **but that export explicitly does not run in the
  browser** (its card notes AI Edge Torch VLMs are unsupported on the MediaPipe LLM Inference API;
  runtime is custom C++/Android/Colab). There is no documented JS path to drive a multi-signature VLM
  (vision encoder + autoregressive decoder + KV cache) from LiteRT.js today.
- **No Node story.** LiteRT.js is browser-focused (WebGPU/WASM); nothing documents the
  onnxruntime-node/Electron path we rely on for the CLI and desktop plugin.
- **Generative LLMs are a separate product** (LiteRT-LM.js), not `@litertjs/core`, and image-text-to-text
  is not shown for it.
- **Perf claims are vs TensorFlow.js JS kernels ("up to 3×", M4 MacBook), not vs ONNX Runtime Web** —
  no evidence it beats our actual incumbent for this model.

By contrast transformers.js already ships AutoProcessor + chat template + `generate()` + tokenizer for
granite-docling in **both browser and Node**, with IBM's own WebGPU demo. Switching would mean
self-converting a 258M VLM *and* writing the web autoregressive runtime — high risk, unproven reward.

**Re-open the question if any of:** (a) a `litert-community`/IBM **granite-docling `.tflite`** appears;
(b) **LiteRT-LM.js documents in-browser Idefics3-class image-text-to-text**; (c) a published
**LiteRT.js-vs-ORT-Web** benchmark shows a real speedup on a comparable VLM. Then run a time-boxed spike.

---

## 5. Key sources

Pipeline/timing: [Docling tech report](https://arxiv.org/html/2408.09869v5) ·
[#1254 formula slowness](https://github.com/docling-project/docling/discussions/1254) ·
[#3202 MPS/MLX speedups](https://github.com/docling-project/docling/issues/3202) ·
[#2516 profiling](https://github.com/docling-project/docling/discussions/2516) ·
[layout models paper](https://arxiv.org/html/2509.11720v1)
Models: [granite-docling-258M](https://huggingface.co/ibm-granite/granite-docling-258M) ·
[2-stage variant](https://huggingface.co/docling-project/granite-docling-2stage-258m) ·
[MLX weights](https://huggingface.co/ibm-granite/granite-docling-258M-mlx) ·
[ONNX export](https://huggingface.co/onnx-community/granite-docling-258M-ONNX) ·
[GGUF quants](https://huggingface.co/Mungert/granite-docling-258M-GGUF) ·
[heron ONNX](https://huggingface.co/docling-project/docling-layout-heron-onnx) ·
[vision-model benchmarks](https://docling-project.github.io/docling/usage/vision_models/) ·
[speed discussion #37](https://huggingface.co/ibm-granite/granite-docling-258M/discussions/37)
JS/packaging: [transformers.js v4](https://huggingface.co/blog/transformersjs-v4) ·
[IBM WebGPU Space](https://huggingface.co/spaces/ibm-granite/granite-docling-258M-WebGPU) ·
[Obsidian mobile dev docs](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development) ·
[Obsidian developer policies](https://docs.obsidian.md/Developer+policies) ·
[MV3 offscreen documents](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3) ·
[HF MV3 extension guide](https://huggingface.co/blog/transformersjs-chrome-extension) ·
[WKWebView WebGPU (iOS 26)](https://developer.apple.com/forums/thread/770862) ·
[share-extension memory limits](https://blog.kulman.sk/dealing-with-memory-limits-in-app-extensions/) ·
[mlx-swift-lm VLM support](https://github.com/ml-explore/mlx-swift-lm) ·
[coremltools blocker](https://github.com/apple/coremltools/issues/2599)

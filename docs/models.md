# Models

Working rule: every model download is documented here (name, size, cache path). Offline mode must be real after cache warm.

## Portable engine (TypeScript + ONNX) — target

`engine-js/` runs a single compact VLM instead of the four-model modular stack. One model, one generation pass per page, pure JS (no Python, no sidecar).

| Model (HF repo) | Role | Variant sizes | Cache path | When |
|-----------------|------|---------------|------------|------|
| `onnx-community/granite-docling-258M-ONNX` (Apache-2.0) | full page → DocTags (layout + reading order + tables + LaTeX + OCR) | fp32 ≈1.03 GB · fp16 ≈515 MB · int8 ≈260 MB · **q4f16 ≈190 MB** (default decoder) | transformers.js cache (`~/.cache/huggingface/` in Node; IndexedDB/OPFS in browser) | on first convert |

Precision policy (see [perf-and-portability.md §3](./perf-and-portability.md)): q8/fp16 decoder floor, fp16 vision tower; q4f16 is the size sweet spot but its TEDS/formula quality is **unmeasured** — the shared fixture suite is the arbiter before it becomes the default. Total warm cache for the portable path: **~0.2 GB** (q4f16) vs ~1.1 GB for the bootstrap stack below.

## Bootstrap / reference-oracle engine (Python Docling)

Kept as the modular fallback and numeric cross-check (the "never silently wrong" hedge). Python Docling 2.114 downloads on first convert to the Hugging Face cache (`~/.cache/huggingface/hub`, unless `HF_HOME` is set):

| Model (HF repo) | Role | Measured size | When |
|-----------------|------|---------------|------|
| `docling-project/docling-layout-heron` | page layout detection | 164 MB | every convert |
| `docling-project/docling-models` | TableFormer table structure (+aux) | 342 MB | every convert |
| `docling-project/CodeFormulaV2` | formula → LaTeX enrichment | 610 MB | unless `--no-formulas` |
| EasyOCR models | OCR for scanned pages | ~100 MB | only with `--ocr` (not yet exercised) |

Total warm cache for the default path: **~1.1 GB**. Timings on M4 Air 32 GB (attention.pdf, 15 pages): first run 320 s including downloads; warm run 177 s (~12 s/page with formula enrichment).

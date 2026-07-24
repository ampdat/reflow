# Models

Working rule: every model download is documented here (name, size, cache path). Offline mode must be real after cache warm.

## Portable engine (TypeScript + ONNX) — target

`engine-js/` runs a single compact VLM instead of the four-model modular stack. One model, one generation pass per page, pure JS (no Python, no sidecar).

| Model (HF repo) | Role | Variant sizes | Cache path | When |
|-----------------|------|---------------|------------|------|
| `onnx-community/granite-docling-258M-ONNX` (Apache-2.0) | full page → DocTags (layout + reading order + tables + LaTeX + OCR) | per-subgraph variants: decoder `fp32/fp16/q4/q4f16/quantized`; vision & embed also `int8/uint8` | transformers.js cache (`~/.cache/huggingface/` in Node; IndexedDB/OPFS in browser) | on first convert |

**Measured precision policy (perf doc §4b, 2026-07-23)** — the quant sweep is done, and the earlier "q4f16 ≈190 MB default" was wrong on both providers:
- **CPU (onnxruntime-node):** fp32 is the only correct dtype; q4f16 and q8 both garble. Warm cache ~1.0 GB (fp32). ~4 min/page.
- **WebGPU (Electron/browser):** validated config is `{embed_tokens: fp16, vision_encoder: fp32, decoder_model_merged: fp32}` (~1 GB), **with transformers.js pinned to 3.7.5** (4.2.0 emits all-"!" garbage on this model). ~41 s/page — ~6× CPU, quality-equal.
- q4/q4f16 (the ~190 MB size win) fail today on both; revisit in M3, gated on the fixture tests.

## Bootstrap / reference-oracle engine (Python Docling)

Kept as the modular fallback and numeric cross-check (the "never silently wrong" hedge). Python Docling 2.114 downloads on first convert to the Hugging Face cache (`~/.cache/huggingface/hub`, unless `HF_HOME` is set):

| Model (HF repo) | Role | Measured size | When |
|-----------------|------|---------------|------|
| `docling-project/docling-layout-heron` | page layout detection | 164 MB | every convert |
| `docling-project/docling-models` | TableFormer table structure (+aux) | 342 MB | every convert |
| `docling-project/CodeFormulaV2` | formula → LaTeX enrichment | 610 MB | unless `--no-formulas` |
| EasyOCR models | OCR for scanned pages | ~100 MB | only with `--ocr` (not yet exercised) |

Total warm cache for the default path: **~1.1 GB**. Timings on M4 Air 32 GB (attention.pdf, 15 pages): first run 320 s including downloads; warm run 177 s (~12 s/page with formula enrichment).

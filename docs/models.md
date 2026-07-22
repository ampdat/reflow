# Models

Working rule: every model download is documented here (name, size, cache path). Offline mode must be real after cache warm.

Bootstrap engine (Python Docling 2.114) downloads on first convert to the Hugging Face cache (`~/.cache/huggingface/hub`, unless `HF_HOME` is set):

| Model (HF repo) | Role | Measured size | When |
|-----------------|------|---------------|------|
| `docling-project/docling-layout-heron` | page layout detection | 164 MB | every convert |
| `docling-project/docling-models` | TableFormer table structure (+aux) | 342 MB | every convert |
| `docling-project/CodeFormulaV2` | formula → LaTeX enrichment | 610 MB | unless `--no-formulas` |
| EasyOCR models | OCR for scanned pages | ~100 MB | only with `--ocr` (not yet exercised) |

Total warm cache for the default path: **~1.1 GB**. Timings on M4 Air 32 GB (attention.pdf, 15 pages): first run 320 s including downloads; warm run 177 s (~12 s/page with formula enrichment).

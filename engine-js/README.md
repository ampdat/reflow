# @pdf2md/engine — portable TypeScript + ONNX engine

Pure-JS PDF → Markdown. No Python, no sidecar binary. The same core runs under a
Node CLI (here), an Obsidian desktop plugin, a browser extension, and eventually
mobile — only `device`/`dtype` change.

**Pipeline:** pdf.js rasterizes each page → [granite-docling-258M ONNX](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
runs under [transformers.js](https://huggingface.co/blog/transformersjs-v4) and emits
**DocTags** → a JS DocTags→Markdown parser → MathJax repairs → the frozen vault
package (`<pdf-stem>/<pdf-stem>.md` + `images/` + `meta.json`, `engine: "onnx-portable"`).
Anything that may have damaged the text is surfaced *in the note* — a warning banner,
an inline marker at each affected page, and a `conversion_warnings` property — not only
in `meta.json`.

## Layout

| File | Role | Needs the model? |
|------|------|:---:|
| `src/doctags.ts` | DocTags → Markdown (OTSL tables, `<loc_*>` bboxes, `<formula>` LaTeX) | no |
| `src/mathjax.ts` | Brace balancing / `\tag` / `aligned` repairs (ported from the Python bootstrap) | no |
| `src/frontmatter.ts` | Obsidian YAML frontmatter | no |
| `src/pdf.ts` | pdf.js raster + text layer + figure crops (`@napi-rs/canvas`) | no |
| `src/vlm.ts` | transformers.js load + page → DocTags | **yes** |
| `src/meta.ts` | `meta.json` shape (`engine`, `model`, timings, execution providers) | no |
| `src/index.ts` | Orchestrator `convertPdf()` | yes |
| `src/cli.ts` | `pdf2md-js` CLI | yes |

## Run

```bash
npm install
npm run typecheck        # tsc --noEmit over the whole package
npm run test:offline     # DocTags parser + MathJax repairs — no download

# First real convert downloads ~190 MB (q4f16) to the transformers.js cache:
npm run cli -- convert ../fixtures/attention.pdf --out out/
#   flags: --no-formulas  --ocr  --device cpu|webgpu|auto

# Cross-engine parity against the shared ground truth (downloads the model):
PDF2MD_RUN_MODEL=1 npm test
```

## Status

Scaffold (M2 in progress). The no-model modules are real and unit-tested; the
VLM path is fully wired but its first end-to-end run + fixture parity is the M2/M3
gate. See [../PLAN.md](../PLAN.md).

## Model & licensing

`onnx-community/granite-docling-258M-ONNX` (Apache-2.0). Variants: fp32 ≈1.03 GB /
fp16 ≈515 MB / int8 ≈260 MB / **q4f16 ≈190 MB** (default decoder). Downloaded on
first convert; see [../docs/models.md](../docs/models.md). pdf.js (Apache-2.0),
`@napi-rs/canvas` (MIT). MuPDF-WASM deliberately avoided (AGPL).

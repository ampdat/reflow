# PDF to Markdown — Obsidian plugin (desktop)

Right-click a PDF in your vault → **Convert to Markdown**. Runs
[granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
on **WebGPU** in Obsidian's renderer via the shared [`engine-js`](../engine-js) core
(pdf.js + transformers.js + the DocTags→Markdown parser). No server, no API keys,
nothing uploads. Output is a vault package: `<Title>/document.md` + `images/`.

This is the M4 shell over the fixture-validated engine (see [../PLAN.md](../PLAN.md)).
`main.ts` is only Obsidian wiring; the whole conversion pipeline is `engine-js`.

## Build

```bash
cd plugin
npm install
npm run build        # bundles main.ts (+ engine core, transformers.js, pdf.js) → main.js
```

Then symlink/copy `manifest.json` + `main.js` into a vault's
`.obsidian/plugins/pdf-to-md/` and enable it in Settings → Community plugins.
For live development: `npm run dev` (esbuild watch) with the plugin folder inside
a test vault.

## First run

- Requires a **WebGPU-capable** Obsidian (recent Electron; `isDesktopOnly`).
- On first convert it **downloads model weights (~1 GB, fp32)** from the HF hub with
  a progress notice, then caches them in the renderer. Later converts skip the download.
- pdf.js worker + ORT wasm are fetched from a CDN on first use.

## Status / known gaps (tracked in ../PLAN.md, M4)

- Weights use the fp32 WebGPU dtype validated in the harness (q4f16 garbles today);
  a smaller quantized build is an open M3/M4 item.
- Figure over-detection and OTSL merged-cell spans are engine-level gaps surfaced by
  the fixture suite — the plugin inherits them (both are warned, not silent).
- Not yet submitted to the community catalog; load as an unpacked plugin for now.

## Settings

- **Output folder** — vault folder for packages (empty = alongside the PDF).
- **Max pages** — 0 = all; set small for a quick test.

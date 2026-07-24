# PDF to Markdown — Obsidian plugin (desktop)

Right-click a PDF in your vault → **Convert to Markdown**. Runs
[granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
on **WebGPU** in Obsidian's renderer via the shared [`engine-js`](../engine-js) core
(pdf.js + transformers.js + the DocTags→Markdown parser). No server, no API keys,
nothing uploads. Output is a vault package: `<Title>/document.md` + `images/`.

This is the M4 shell over the fixture-validated engine (see [../PLAN.md](../PLAN.md)).
`main.ts` is only Obsidian wiring; the whole conversion pipeline is `engine-js`.

## Build & install

```bash
cd plugin
npm install                 # once
npm run deploy              # build → dist/, then install into the vault
```

- `npm run build` — bundle `main.ts` (+ engine core, transformers.js, pdf.js) → `dist/{main.js,manifest.json}`.
- `npm run install:vault` — copy `dist/` into the vault's `.obsidian/plugins/pdf-to-md/` **without rebuilding**.
- `npm run deploy` — both.
- `npm run dev` — esbuild watch (for live iteration).

Target vault resolution (for `install:vault` / `deploy`): `$OBSIDIAN_VAULT`, else
the first CLI arg, else the default in `install.mjs`. Examples:

```bash
OBSIDIAN_VAULT="/path/to/Vault" npm run deploy
npm run install:vault -- "/path/to/Vault"
```

After installing, in Obsidian: enable the plugin (Settings → Community plugins),
or if it's already enabled, **reload** (Cmd+R) / toggle it off·on to pick up the new build.

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

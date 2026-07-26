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

- `npm run build` — bundle `main.ts` (+ engine core, transformers.js, pdf.js) → `dist/{main.js,worker.js,manifest.json}`.
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

## Conversion runs in a worker

The engine runs in a dedicated worker ([`worker.ts`](worker.ts), bundled to
`dist/worker.js` and started from a blob URL by [`worker-host.ts`](worker-host.ts)),
not on the renderer's main thread. Measured on 2 pages of `attention.pdf`, same
build, only this setting changed:

| | worker | main thread |
|---|---|---|
| main-thread lag (p95) | **1.1 ms** | 17 ms |
| main-thread lag (max) | 1.8–72 ms | **533 ms** |
| stalls over 100 ms | **0** | 8 |
| throughput | 16.6 tok/s | 17.4 tok/s |
| renderer RSS after 3 conversions | 266 → **1019 MB** | 267 → **2885 MB** |

So it costs ~5% throughput and buys a UI that never stutters, plus ~3× less
resident memory: the worker is **single-use** and terminated after every
conversion, which is the only reliable way to get back what ORT's `dispose()`
leaves behind. Turn it off with the *Convert in a background thread* setting —
that is also the control arm for reproducing the table above.

### It changes how pages are rasterized

A worker has no `document`, so [`browser/pdf.ts`](../engine-js/src/browser/pdf.ts)
supplies an OffscreenCanvas factory, a no-op filter factory (pdf.js's builds
`<svg><filter>` elements), and `disableFontFace` — matching what pdf.js's own Node
build does, which is the configuration the fixture suite validated.

`disableFontFace` has a trap worth knowing about. It makes pdf.js rasterize the
standard 14 fonts from their own outlines instead of handing them to the platform
font stack, so it needs `standardFontDataUrl`. Without it pdf.js does not fail —
it warns once per glyph (`getPathGenerator - ignoring character`) and rasterizes
the page **with holes in the text**, which reaches the VLM as a page that simply
says less. `loadPdfBrowser` now throws rather than render without it, and the
pinned URLs live in [`pdfjs-cdn.ts`](pdfjs-cdn.ts).

Two smaller notes from wiring this up: `requestAnimationFrame` *does* exist in
Obsidian's worker global and does fire, so pdf.js's rAF scheduling shim stays on
there; and pdf.js reports *"Setting up fake worker"* inside the worker (it can't
spawn its nested parsing worker), so PDF parsing shares the conversion thread —
still off the main thread, just not parallel with inference.

## Running ONNX inside Obsidian: the two Node-detection traps

Obsidian's renderer has Node integration, so libraries that sniff for Node see a
half-Node, half-browser environment and pick the wrong path. Two separate layers
had to be corrected; both are now fixed and verified in a real Obsidian.

**1. transformers.js picked the CPU-only backend.** It reads
`process.release.name === "node"` at import time to set `IS_NODE_ENV`, which made it
choose `onnxruntime-node` (no WebGPU: *"Unsupported device: webgpu"*). An esbuild
banner renames `process.release.name` before any bundled module evaluates, so
transformers captures `IS_NODE_ENV=false` and offers onnxruntime-web + WebGPU;
`main.ts` restores the real value immediately after.

**2. onnxruntime-web couldn't load its wasm glue.** ORT normally uses the emscripten
glue *already inlined* in its bundle — but only when no `wasmPaths` override is set
(`importWasmModule()` in `onnxruntime-web/lib/wasm/wasm-utils-import.ts`).
transformers.js unconditionally sets a jsdelivr `wasmPaths` prefix at import time, so
ORT instead dynamically imported the standalone `ort-wasm-simd-threaded.jsep.mjs` from
the CDN. That file ends with a **top-level await** whose Node check has no renderer
guard (unlike the one in the module body, which correctly tests
`"renderer" != process.type`):

```js
var isNode = typeof globalThis.process?.versions?.node == 'string';
if (isNode) isPthread = (await import('worker_threads')).workerData === 'em-pthread';
```

In the renderer `process.versions.node` is a string, `worker_threads` is not a
resolvable ESM specifier, the module never evaluates, and ORT reports *"no available
backend found. ERR: [webgpu] Failed to resolve module specifier 'worker_threads'"*.

It can't be fixed at runtime (Electron makes `process.versions.node` non-writable) and
it can't be patched by a normal esbuild `onLoad` hook, because the offending file is
fetched from a CDN at runtime and never enters the bundle. The fix (see
[`ort-env.ts`](ort-env.ts)) inlines a **build-time-patched copy** of the glue as text,
serves it from a blob URL, and overrides `wasmPaths` with `{ mjs, wasm }`. The build
fails loudly if that epilogue ever stops matching, so a future ORT bump can't silently
reintroduce the break.

## Debugging: driving Obsidian headlessly

Conversion is a non-interactive file transformation, so it can be tested without a
human clicking through the UI. [`tools/obsidian-drive.mjs`](tools/obsidian-drive.mjs)
launches an **isolated** Obsidian (its own `--user-data-dir` and scratch vault at
`../.obsidian-test/`, so it runs alongside your real session without touching it),
attaches over the Chrome DevTools Protocol, and evaluates JS in the plugin's own
context — streaming the renderer console back to the terminal.

```bash
node tools/obsidian-drive.mjs up                # launch + open the scratch vault
node tools/obsidian-drive.mjs reload            # pick up a new build, re-enable plugin
node tools/obsidian-drive.mjs eval 'return __pdf2md.envReport()'
node tools/obsidian-drive.mjs run 'return await __pdf2md.convertPath("attention.pdf")'
node tools/obsidian-drive.mjs console 60        # tail the renderer console
node tools/obsidian-drive.mjs down
```

Use `run` (not `eval`) for anything measured in minutes: `eval` holds one CDP call
open for the whole job, so a dropped socket loses the reply and the caller hangs
even though the work finished. `run` stores the promise in the page and polls,
which also gives progress while it works.

The plugin exposes a debug shim at `window.__pdf2md` (see [`probe.ts`](probe.ts)) —
usable from the devtools console too:

- `envReport()` — what the renderer looks like to Node-sniffing libraries
  (`process.type`, `process.versions.node`, WebGPU, SharedArrayBuffer, wasm SIMD).
- `ortSmoke({ ep, strategy })` — runs a **94-byte** `Add` ONNX model on the chosen
  execution provider. Answers "does ORT start at all here" in ~1.5 s with no model
  download and no PDF, which is where every failure so far has been.
  `strategy: "baseline"` deliberately restores the broken config to reproduce the
  bug on demand.
- `convertPath("file.pdf")` — the real conversion, returning a summary object.
- `setUseWorker(bool)` / `lastRunMode()` — switch between the worker and
  main-thread paths and confirm which one actually ran.

Probes built for specific questions, run with `run-file`:

- `tools/worker-probe.js` — one conversion while sampling **main-thread** event-loop
  lag. Totals can't distinguish a blocked UI from a busy one; this can.
- `tools/memory-probe.js` — three conversions in one session, RSS after each. The
  memory question is about accumulation, which a single conversion cannot show.
- `tools/raster-diff-probe.js` — renders the same pages in the worker and on the
  main thread and compares pixels. The worker's `document`-less pdf.js config is
  the one way it can affect output *quality*; comparing DocTags instead would
  confound that with decoding noise.

Note when writing probes: pdf.js **transfers** the input buffer to its worker, so
a `Uint8Array` fed to two consumers arrives detached and empty at the second —
and pdf.js answers that by hanging, not throwing. Pass a fresh `.slice()` each time.

A full loop is `npm run build && npm run install:vault && node tools/obsidian-drive.mjs reload`,
then an `eval`.

## Other known gaps (tracked in ../PLAN.md, M4)

- Weights use the fp32 WebGPU dtype validated in the harness (q4f16 garbles today);
  a smaller quantized build is an open M3/M4 item.
- Figure over-detection and OTSL merged-cell spans are engine-level gaps surfaced by
  the fixture suite — the plugin inherits them (both are warned, not silent).
- Not yet submitted to the community catalog; load as an unpacked plugin for now.

## Settings

- **Output folder** — vault folder for packages (empty = alongside the PDF).
- **Max pages** — 0 = all; set small for a quick test.
- **Per-page time limit** — generation for a page is cut off after this long and the
  page is flagged incomplete. Raise it for dense pages or a slower GPU.
- **Convert in a background thread** — on by default; see above.

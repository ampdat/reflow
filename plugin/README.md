# Reflow — Obsidian plugin (desktop)

Right-click a PDF in your vault → **Convert to Markdown**. Runs
[granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
on **WebGPU** in Obsidian's renderer via the shared [`engine-js`](../engine-js) core
(pdf.js + transformers.js + the DocTags→Markdown parser). No server, no API keys,
no page limits, and the PDF never leaves your machine. Output is a vault package
named from the PDF: `1706.03762v7/1706.03762v7.md` + `images/` + `meta.json`.

This is the M4 shell over the fixture-validated engine (see [../PLAN.md](../PLAN.md)).
`main.ts` is only Obsidian wiring; the whole conversion pipeline is `engine-js`.

## Network use

Conversion is local. Three things are still fetched, once each, and cached — all
of them from pinned versions, none of them your document:

| What | From | When |
|---|---|---|
| Model weights (~1 GB, fp32) | `huggingface.co` | First conversion |
| onnxruntime-web's WebAssembly runtime (~24 MB) | `cdn.jsdelivr.net` | First conversion |
| pdf.js standard-14 fonts and CMap packs | `cdn.jsdelivr.net` | On demand, per document |

pdf.js's **parsing worker is bundled**, not fetched, so no executable JavaScript
is downloaded at runtime. The wasm runtime is the one exception and it is
unavoidable: it *is* the inference engine, and at 24 MB it cannot reasonably be
inlined into `main.js`. Bundling the fonts and CMaps (2.4 MB, mostly CJK packs
most readers never touch) is a possible follow-up; see [`assets.ts`](assets.ts).

Nothing else talks to the network: no telemetry, no accounts, no update check.

## Build & install

```bash
cd plugin
npm install                 # once
npm run deploy              # dev build → dist/, then install into a vault
```

- `npm run build` — release bundle → `dist/{main.js,manifest.json,styles.css}`,
  which is **exactly** the file set Obsidian's community installer downloads.
- `npm run build:dev` — same, plus the debug shim (see below).
- `npm run install:vault` — copy `dist/` into a vault's `.obsidian/plugins/reflow/`
  **without rebuilding**.
- `npm run deploy` — dev build + install.
- `npm run dev` — esbuild watch.
- `npm run lint` / `npm run typecheck` — the pre-release gates; see *Packaging* below.

Target vault resolution (for `install:vault` / `deploy`): `$OBSIDIAN_VAULT`, else
the first CLI arg, else the default in `install.mjs`. Examples:

```bash
OBSIDIAN_VAULT="/path/to/Vault" npm run deploy
npm run install:vault -- "/path/to/Vault"
```

After installing, in Obsidian: enable the plugin (Settings → Community plugins),
or if it's already enabled, **reload** (Cmd+R) / toggle it off·on to pick up the new build.

## First run

- The first convert downloads model weights with a progress dialog, then caches
  them in the renderer. Later converts skip the download.
- Reflow probes the machine before it starts and picks a backend; see below.

## Compute backends

Reflow probes for a GPU before every conversion (an adapter request — no
download) and runs on the best backend it finds, falling back rather than
failing. The *Compute backend* setting forces a choice; **Automatic** is
WebGPU → CPU.

| Backend | Status | Notes |
|---|---|---|
| **WebGPU** | Default where available | Enabled by default on Windows (D3D12) and macOS (Metal) |
| **CPU (wasm)** | Automatic fallback | Works, slower, and **cannot convert every page** — see below |
| **WebNN** | Opt-in only | `navigator.ml` is absent unless Obsidian is launched with `--enable-features=WebMachineLearningNeuralNetwork`, which a plugin cannot set |

**Linux** is the case to watch: Chromium still gates WebGPU behind a flag there,
so `requestAdapter()` returns null and Reflow drops to the CPU. The warning says
so, and names the flag.

### The CPU fallback is real, but it is not a guarantee

Measured on an M4 (both in the worker and in the renderer, on fresh windows):

| Page | Tiles / prompt tokens | WebGPU | CPU (wasm, 4 threads) |
|---|---|---|---|
| `bert.pdf` p1 | 13 / 878 | 34 s | **60 s**, 20.4 tok/s |
| `attention.pdf` p1 | 17 / 1142 | 28 s | **fails in 5 s** — `std::bad_alloc` |

So the CPU path is only ~1.7× slower than WebGPU here — consistent with the
earlier finding that the two are within the same order on this machine — but it
has a hard ceiling. The cause is upstream of the model: the Idefics3 processor
splits a page into 512-px tiles by aspect ratio, and the two documents rasterize
to nearly the same size (1191×1684 vs 1224×1584) yet tile differently.
Seventeen tiles of fp32 vision activations plus ~1 GB of fp32 weights exceed
WebAssembly's 4 GB address space; thirteen fit.

The plugin says this plainly when it happens rather than surfacing
`std::bad_alloc`. **Not yet tried:** rendering at a lower scale on the CPU path
to cut the tile count, which would trade fidelity for headroom and needs to be
priced against the fixture suite before it becomes a default.

## Packaging for the community directory

Obsidian's installer downloads **only** `main.js`, `manifest.json` and
`styles.css` from a GitHub release. Two consequences shape this build:

1. **The conversion worker is inlined into `main.js`** as text at build time and
   started from a blob URL ([`worker-host.ts`](worker-host.ts)). It used to be
   read back from the plugin folder at runtime, which works when you copy a
   folder and fails silently for everyone who installs normally — the plugin
   would quietly convert on the main thread forever. `worker.ts` is bundled to
   `build/worker.js` (scratch, gitignored) and inlined from there.
2. **pdf.js's parsing worker is inlined too** ([`assets.ts`](assets.ts)), for the
   remote-code reason above. `main.js` is ~4.7 MB as a result: the main bundle,
   the worker bundle, and two copies of the pdf.js worker (the renderer path and
   the conversion worker each need one).

### The manifest lives at the repository root

[`../manifest.json`](../manifest.json), not next to this source, because the
community directory reads the manifest at the HEAD of the default branch. There
is deliberately no second copy here to drift from it: `esbuild.config.mjs` stages
the root one into `dist/`.

One consequence worth knowing before you chase it: `eslint-plugin-obsidianmd`
looks for `manifest.json` in its own working directory, so linting from `plugin/`
prints a harmless *"Failed to load JSON file"* line and cannot check the manifest
itself. [`check-manifest.mjs`](check-manifest.mjs) asserts the rules that
actually reject a submission — id shape, description length and punctuation,
semver, `isDesktopOnly`, and `versions.json` agreeing with the manifest — and
`npm run lint` runs both.

### Lint and release

`npm run lint` runs [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin) —
the same guideline checks the directory's automated review applies to *every*
published version, not just the first. It must be error-clean before a release.
The type-aware `typescript-eslint` rules that ship in the same preset are set to
warn: every one of them lands on an untyped third-party surface (transformers.js's
`env` bag, ORT's `wasmPaths`, `catch (e: any)`), and the reasoning is recorded in
[`eslint.config.mjs`](eslint.config.mjs).

Releases are cut by tagging: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
checks the manifest and that the tag equals its version (no `v` prefix — a
mismatch fails silently in the directory), lints, typechecks, builds, and
attaches the three files as a draft release.

Two ways to have a perfectly good release that Obsidian cannot see, both of
which report the same *"No release matches your manifest version"*:

- **A `v` prefix on the tag.** The workflow's manifest check catches this.
- **The "Set as a pre-release" box, ticked when publishing the draft.** GitHub
  excludes pre-releases from `/releases/latest`, which then answers 404 — the
  release exists and is reachable by tag, it just isn't *the latest*. `gh release
  edit <version> --prerelease=false --latest` undoes it; `curl -s
  https://api.github.com/repos/<owner>/<repo>/releases/latest` confirms it, and
  is the quickest way to see the repository the way the directory does.

**Still to do before submitting:** make the repository public, cut the first
release, and submit at [community.obsidian.md](https://community.obsidian.md)
(since May 2026; the old `obsidian-releases` pull request is gone).

## Conversion runs in a worker

The engine runs in a dedicated worker ([`worker.ts`](worker.ts)), not on the
renderer's main thread. Measured on 2 pages of `attention.pdf`, same build, only
this setting changed:

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
pinned URLs live in [`assets.ts`](assets.ts).

Two smaller notes from wiring this up: `requestAnimationFrame` *does* exist in
Obsidian's worker global and does fire, so pdf.js's rAF scheduling shim stays on
there; and pdf.js reports *"Setting up fake worker"* inside the worker (it can't
spawn its nested parsing worker, so it `import()`s the same bundled blob URL
instead), so PDF parsing shares the conversion thread — still off the main
thread, just not parallel with inference.

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
reintroduce the break. On the currently pinned transformers/ORT the upstream guard is
present and the patch is a no-op — the build says so, and the override stays dormant.

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
node tools/obsidian-drive.mjs eval 'return __reflow.envReport()'
node tools/obsidian-drive.mjs run 'return await __reflow.convertPath("attention.pdf")'
node tools/obsidian-drive.mjs console 60        # tail the renderer console
node tools/obsidian-drive.mjs down
```

Use `run` (not `eval`) for anything measured in minutes: `eval` holds one CDP call
open for the whole job, so a dropped socket loses the reply and the caller hangs
even though the work finished. `run` stores the promise in the page and polls,
which also gives progress while it works.

**The shim is development-only.** `npm run build:dev` (and `deploy`, and `dev`)
include [`probe.ts`](probe.ts); `npm run build` resolves it to
[`probe-stub.ts`](probe-stub.ts) instead, so a released build has no `window`
global and doesn't carry the second standalone onnxruntime-web the smoke test
uses. Reach it at `window.__reflow`:

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

A full loop is `npm run deploy && node tools/obsidian-drive.mjs reload`, then an `eval`.

## Other known gaps (tracked in ../PLAN.md, M4)

- Weights use the fp32 WebGPU dtype validated in the harness (q4f16 garbles today);
  a smaller quantized build is an open M3/M4 item.
- Figure over-detection and OTSL merged-cell spans are engine-level gaps surfaced by
  the fixture suite — the plugin inherits them (both are warned, not silent).
- Not yet submitted to the community directory; load as an unpacked plugin for now.
- **Windows and Linux are untested.** The backend probe, the CPU fallback and the
  `shader-f16` dtype switch were all written for hardware nobody here has; the
  selection logic is unit-tested against fake navigators (`test/device.test.ts`)
  precisely because the real cases cannot be reproduced on this machine.

## Settings

- **Compute backend** — Automatic (WebGPU → CPU), or force one; see above.
- **Output folder** — vault folder for packages (empty = alongside the PDF).
- **Max pages** — 0 = all; set small for a quick test.
- **Per-page time limit** — generation for a page is cut off after this long and the
  page is flagged incomplete. Raise it for dense pages or a slower GPU.
- **Convert in a background thread** — on by default; see above.
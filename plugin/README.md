# Reflow — Obsidian plugin (desktop)

Right-click a PDF in your vault → **Convert to Markdown**. Runs
[granite-docling-258M](https://huggingface.co/onnx-community/granite-docling-258M-ONNX)
on **WebGPU** in Obsidian's renderer via the shared [`engine-js`](../engine-js) core
(pdf.js + transformers.js + the DocTags→Markdown parser). No server, no API keys,
no page limits, and the PDF never leaves your machine. Output is a vault package
named from the PDF: `1706.03762v7/1706.03762v7.md` + `images/` + `meta.json`.

Right-click any note → **Export to EPUB** (or the *Export active note to EPUB*
command) to get an `.epub` beside it for a Kindle or other e-reader. Optionally
every conversion can write one automatically — see [Settings](#settings). The
exporter adds no dependencies: it builds the ZIP with `CompressionStream` and
needs no maths renderer, for the reason in [Formulas](#formulas). On macOS,
**Send to Kindle** in the same menu carries it the rest of the way — see
[Getting it onto a Kindle](#getting-it-onto-a-kindle).

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
   remote-code reason above. `main.js` is ~4.6 MB as a result: the main bundle,
   the worker bundle, and two copies of the pdf.js worker (the renderer path and
   the conversion worker each need one).

### What the review reads is the bundle, not your intent

Two findings in the 0.1.0 review came from bytes in `main.js` that the plugin
never executes, and both are worth remembering because the instinct they invite
is the wrong one.

**"Direct Filesystem Access — can read and write any file on the system."**
`main.js` contained `require("fs")`, `require("path")` and `require("os")`. All
of them lived inside the onnxruntime emscripten glue, which was inlined *as a
text string* and — on a current dependency tree — never used at all, because
the guard it patches has been fixed upstream since ORT ~1.24. Ninety-two
kilobytes of dead text was enough to have the plugin described to users as
something that reads their filesystem. The fix is in
[`esbuild.config.mjs`](esbuild.config.mjs): decide at build time whether a patch
is needed and inline the glue only then. Encoding the string so a scanner
wouldn't recognise it would have "worked" and is exactly what the developer
policies prohibit — obfuscation is a policy violation, not a workaround.

**Dynamic code execution.** pdf.js compiles Type 4 (PostScript calculator)
shading functions with `new Function(src, …)`. `docParams()` in
[`browser/pdf.ts`](../engine-js/src/browser/pdf.ts) now passes
`isEvalSupported: false` on both the worker and renderer paths, so pdf.js uses
its interpreter and never compiles code out of the document it was handed. Its
own `new Function("")` capability probe still appears in the bundle, so a static
scanner may still flag the pattern; the substance is that nothing in a converted
PDF becomes executable code.

**Inline `eslint-disable` comments for `obsidianmd/*` rules are rejected
outright** — that, not the logging they suppressed, is what failed 0.1.0. The
console calls themselves are only a warning. Where a rule genuinely has to be
relaxed (the worker's warn/error bridge, which is a worker's only route to the
console), it is relaxed in [`eslint.config.mjs`](eslint.config.mjs) where it is
visible, never mid-file.

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

## Getting it onto a Kindle

**Send to Kindle** (macOS, in a note's right-click menu and as a command) exports
the EPUB if there is no current one and hands it to Amazon's app. If the note has
changed since the last export it re-exports first — sending a stale book is a
silent wrong-content bug, and 40 ms is cheaper than reading the wrong thing.

It stops at Amazon's confirmation window, deliberately. This is the only thing
the plugin does that sends the reader's document off the machine, and the whole
pitch is that nothing does; their click is the consent, and it belongs in
Amazon's own UI where the destination account is visible. (There is also no way
to go further: the app ships no CLI and no scripting dictionary.)

Three implementation details that cost time to find:

- **The app is resolved by bundle id** (`com.amazon.SendToKindle`), never by
  path. Amazon installs it *inside* a folder called `Send to Kindle`, and a
  Safari web app of the same name — a saved bookmark, bundle id
  `com.apple.Safari.WebApp.*` — can sit right beside it in `/Applications`.
  `open -b` lets Launch Services sort that out.
- **`window.require`, not `await import()`.** A dynamic import of a `node:`
  specifier goes to Chromium's module loader, which tries to *fetch* it:
  `Failed to fetch dynamically imported module: node:child_process`. Electron's
  renderer `require` is the only route that works. A static top-level import
  works too but the community-directory review rejects it (`no-nodejs-modules`),
  and rightly — it would break a mobile build outright.
- **The Kindle *reading* app cannot open an EPUB.** Its `Info.plist` declares
  only `com.amazon.kindle-document` (`azw`, `mobi`, `prc`, …) and PDF, so there
  is no sideload path into it. Send to Kindle works because Amazon converts
  server-side and the result syncs down into your library.

## Formulas

Equations reach the Markdown by two different routes, and it is worth knowing
which is which, because only one of them is structured.

**Display equations** come from a DocTags `<formula>` block. The parser wraps the
model's LaTeX in `$$…$$`, and `fixFormula` repairs it enough for MathJax —
balancing braces, turning a trailing `&&(1)` into `\tag{1}`, wrapping stray
alignment markers in `\begin{aligned}`.

**Inline maths** is never tagged at all: the model writes `$…$` inside the OCR
text of a paragraph, so `h$_{t}$` simply passes through as characters. Nothing in
the pipeline treats it as maths, and `fixFormula` never touches it.

**In Obsidian, both just work.** Obsidian bundles MathJax 3.2.2 and renders
`$$…$$` as display and `$…$` inline, natively. The plugin ships no maths
renderer and never has — its job is to write Markdown that Obsidian renders.

### In the EPUB, equations are images of the original

E-readers are a different problem: Kindle renders neither LaTeX nor MathML, and
in testing it accepted inline SVG and then **silently discarded it** — a book
that validates cleanly with the equations missing.

So conversion also crops each display equation straight out of the rendered page,
exactly as it already does for figures, and writes it as `images/formula-N.png`
with an entry in `meta.json`. The export uses those crops. The `.md` is untouched
by this — it still carries `$$…$$`, and Obsidian still renders it.

This is cheaper *and* more faithful than re-rendering the LaTeX:

- **No dependency.** Bundling MathJax would have added ~662 KB gzipped, about
  45% to the plugin. The crops cost nothing, and measured on the Transformer
  paper they were 4.5× smaller than rendered equation images (19.3 KB vs 88.3 KB).
- **It cannot be wrong about the maths.** The crop is the page. A renderer can
  only ever be as good as the model's transcription — and the transcription is
  sometimes truncated (below).
- Inline maths needs no images: sub- and superscripts become `<sup>`/`<sub>` and
  stay searchable, selectable and legible in night mode. Both shapes are handled,
  which matters more than it sounds — the VLM writes the base *outside* the maths
  (`h$_{t}$`, so the formula is a bare `_{t}`) while a person types it *inside*
  (`$h_t$`). Handling only the first meant hand-written notes got no
  sub/superscripts at all.

### Notes with no crops

A hand-written note, or one converted before crops existed, still exports — but
**its display equations do not render**. There is no crop to show and no maths
renderer to fall back on, so the equation becomes its own LaTeX source, labelled:

> *Formula could not be rendered*
> `\text{Attention}(Q, K, V) = \text{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V`

Labelling it is the point. A bare `<code>` span dropped into the flow of a page
reads like a typesetting bug, and the reader cannot tell whether the export
failed or the note was always that way. This says which, and keeps the source,
which is the part they can still act on. The count also comes back as a notice
after the export.

Inline maths degrades better: anything that is a sub/superscript still renders
properly, and only genuine inline maths (`$\alpha + \beta \leq 1$`) falls back to
source — inline, with no label, because a callout mid-sentence would be worse
than the problem.

Rendering these properly is the one thing that would need MathJax
(~662 KB gzipped, ~45% on the plugin). The spike argued against paying that, but
it argued about *converted papers*, where crops always exist; if exporting
arbitrary notes becomes a real use case, that trade is worth re-opening.

### Truncated formulas, and the click-to-reveal fallback

`fixFormula` is by design a liar: it balances braces so MathJax renders
*something*, which means a formula the model cut off part-way renders cleanly and
looks right. Equation (1) of the Transformer paper comes out as
`softmax(QK^T/√d_k` — no closing paren, no `V`, no equation number — and Obsidian
draws it without complaint.

Conversion now detects this. Parentheses and brackets are the tell, since
`fixFormula` never touches them, so an unbalanced one survives; a page whose
generation stopped early condemns its last formula too. Across both test runs
this flagged exactly the truncated equations and no complete ones.

A flagged formula gets a **collapsed** callout under it, so the note stays clean
until you want it:

```markdown
$$\ A t t e n t i o n ( Q , K , V ) = \text {softmax} ( \frac { Q K ^ { T } } { \sqrt { d _ { k } } }$$

> [!warning]- This formula may be incomplete — show the original from the PDF
> ![formula-1](images/formula-1.png)
```

Click it and you get the equation as the author set it. The count also appears in
the conversion-warnings banner at the top of the note. In the EPUB the callout is
dropped, because there the equation *is* already that image.

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
- **Also export EPUB** — off by default. When on, every conversion writes
  `<note>.epub` next to the Markdown. Off is the right default because the
  Markdown *is* the artifact inside Obsidian; export is fast and lossless from
  the package, so it can be asked for per-note instead.
# Spike — EPUB export from the converted Markdown

*2026-07-27. A time-boxed spike, not a decision. Everything marked **[measured]** comes from a
local run made while writing this; **[estimated]** is arithmetic; **[unverified]** is something the
spike deliberately did not settle and says so. Prototype: `engine-js/tools/md2epub.mjs` and
`plugin/tools/mathjax-probe.js`.*

The ask: get an EPUB out of the Markdown we already produce, in three steps — text first, then
images, then formulas as images so it survives on Kindle and small e-readers. All three work. The
interesting part is that the third step is not the hard one, and the reasons are worth writing down
before anyone builds it for real.

---

## 1. The one-line answer to each question

| Question | Answer |
|---|---|
| Can we produce a valid EPUB from the Markdown package? | **Yes.** All three stages build. 25 XHTML files, 0 xmllint errors, and Amazon's own Kindle Previewer converts it with **0 errors, 0 quality issues, "Enhanced Typesetting: Supported"**. **[measured]** |
| What does it cost in dependencies? | **Nothing, on the recommended path** — a hand-rolled ZIP writer over `node:zlib`, plus formula crops the converter already has the page raster to make (§7). Bundling MathJax would cost **662 KB gzipped, ~+45% on the plugin**; §7 is the argument for not doing that. **[measured]** |
| Do formulas have to be images? | **On Kindle, yes — and this is the finding.** SVG math passes Kindle Previewer with zero errors *and is silently dropped from the output book*. Raster math survives. A validator that says "0 errors" is not telling you your equations are there. **[measured]** |
| Can Obsidian's own MathJax do the job? | **No.** Obsidian ships MathJax 3.2.2 with the **CHTML output jax only** — no `tex2svg`, and the SVG module is genuinely absent from its bundle, not merely unexposed. `tex2mml` does work. **[measured]** |
| How much math actually needs rendering? | **Much less than you'd think.** In the `attention` package, **18 of 23 formulas are bare sub/superscripts** (`$^{*}$`, `h$_{t}$`) that belong in `<sup>`/`<sub>`, not in a PNG. Only 5 are real display equations. **[measured]** |
| Is there a zero-dependency path to rendered math? | **Yes — built and measured in §7.** DocTags gives every `<formula>` a bbox and `page.crop()` already exists, so equations are cut straight out of the page raster like figures. 4/4 coverage, 19.3 KB vs 88.3 KB, no dependency — and *more* correct than the LaTeX, which the model truncated on two of the four. **[measured]** |

---

## 2. What the prototype does

```bash
cd engine-js
node tools/md2epub.mjs <package-dir> --math crop   # no dependencies; see §7
npm i -D mathjax-full                              # only for --math svg|png|auto
```

Input is the frozen artifact contract (`<stem>/<stem>.md` + `images/`); output is one `.epub` beside
it. `--stage 1|2|3` are presets over two real knobs, `--math` and `--no-images`:

| Stage | Math | Images | What it proves |
|---|---|---|---|
| 1 | literal LaTeX in `<code>` | no | the container: ZIP layout, OPF, nav, XHTML well-formedness |
| 2 | literal LaTeX | yes | manifest, media types, path plumbing |
| 3 | `auto` — HTML where possible, PNG otherwise | yes | the Kindle-safe target |
| — | `--math crop` | yes | **the recommendation.** Uses the converter's formula crops; no renderer at all (§7) |
| — | `--math svg` | yes | the *better* answer on real EPUB 3 readers (see §4b) |

The note is split into one XHTML document per top-level heading (24 for `attention`), because a
single 300 KB document is exactly how you make an e-reader feel slow. Output is byte-deterministic
across runs **[measured]** — ZIP timestamps and the book UUID are derived, not clocked — so it can
be fixture-tested the way conversions already are.

---

## 3. Stage results **[measured]**

`attention` package: 329 lines, 7 figures, 23 formulas (17 unique), on this M4.

| Stage / mode | Build | Size | Math handling | Math bytes |
|---|---:|---:|---|---:|
| 1 — text only | 26 ms | **25.0 KB** | 17 left as LaTeX text | 0 |
| 2 — + figures | 68 ms | **803.0 KB** | 17 left as LaTeX text | 0 |
| 3 — `auto` | 759 ms | **914.7 KB** | 12 → `<sup>`/`<sub>`, 5 → PNG | 113.3 KB |
| `--math png` | 736 ms | 927.0 KB | 17 → PNG | 123.5 KB |
| `--math svg` | 431 ms | 838.9 KB | 17 → inline SVG | 0 (inline) |

Two things fall out of the table. Figures dominate the file — 785 KB of the 915 KB is the seven
extracted PNGs, so **math is ~12% of the book and the stage-3 work is cheap in bytes**. And the
per-formula cost is ~40 ms of MathJax, which is a rounding error next to the ~32 s/page the
conversion itself takes.

Validation:

- **xmllint**: 25 XHTML + OPF + container, **0 errors**.
- **ZIP layout**: `mimetype` first and `Stored`, per spec.
- **Kindle Previewer 3.106.0**: `Success`, `Error Count 0`, `Quality Issue Count 0`, Enhanced
  Typesetting `Supported`. The only notice is `W14016: Cover not specified`.
- **epubcheck v5.3.0** (EPUB 3.3 rules): stages 1, 2 and 3 all report **0 fatals / 0 errors /
  0 warnings / 0 infos**. The `--math svg` variant initially failed with **15 × OPF-015** — the
  prototype stamped `properties="svg"` on every chapter once any formula was SVG, and the property
  is an error on documents that do not contain inline SVG. Fixed by deciding it per chapter after
  rendering; all four modes are now clean.

The rendered math is correct — MathJax's output for equation (1) reads exactly as it does in the
paper, truncation included (the source Markdown carries a "generation stopped early" warning on that
page; the EPUB is faithful to the Markdown, defects and all).

---

## 4. The math problem, which is not the problem you expect

### 4a. Most of our "math" is not math **[measured]**

Of 18 inline formulas in `attention`, **18** are pure sub/superscripts — `^{*}` on a footnote marker,
`_{t}` in `h$_{t}$`, `_{drop}` in a table header. Twelve unique after dedup. The VLM emits them as
LaTeX because that is what they are in the PDF, and rendering each to a PNG is the worst available
outcome: a 460-byte image per asterisk, a baseline to guess at, text you cannot search or select, and
glyphs that stay black when the reader flips to night mode.

`<sup>` and `<sub>` predate EPUB and work everywhere. So the prototype tiers it: anything expressible
as HTML becomes HTML, and only genuine math pays for an image. On this document that converts
**100% of inline math to text** and leaves 5 display equations as images. It saves only 10 KB, but
bytes were never the point — it is the difference between a book with 5 images in it and a book with
17.

### 4b. Kindle accepts SVG math and then throws it away **[measured]**

This is the finding that would have cost someone a day.

Both the PNG and SVG builds convert through Kindle Previewer with **0 errors and 0 quality issues**.
But unpacking the resulting KPF containers:

| | resources in KPF | contains |
|---|---:|---|
| `--math png` | **12** | 7 figures + 5 equations, all transcoded to JPEG by Amazon |
| `--math svg` | **7** | 7 figures. Nothing else. |

The five equations produce no resource, and `strings` over the KDF finds **zero** occurrences of
`svg`. The figures are all present in both. The reasonable reading is that Amazon's converter
discards the inline SVG and reports success. I did not open the book on a physical Kindle, so
"silently dropped" is an inference from the container rather than a photograph **[unverified]** —
but it is a strong one, and it means **`--math svg` must not be the Kindle path**, while remaining
the right answer for Apple Books / Kobo / Thorium, where it is smaller, sharper, and re-styleable.

The same build also carried 15 epubcheck errors while Kindle Previewer called it clean. **Neither
tool alone is sufficient evidence**: epubcheck is the standards gate, Kindle Previewer is the vendor
gate, and only counting resources inside the KPF tells you the content survived. All three are worth
running, and §8 runs all three.

Two smaller consequences of the same measurement:

- Amazon **transcodes our PNGs to JPEG**. There is no transparency to preserve, which retroactively
  justifies compositing math onto a white matte, and it means math glyphs get lossy-compressed —
  worth a visual check on a device before shipping.
- Black-on-white math images do not invert in night mode. SVG with `currentColor` would; PNG cannot.
  On the devices that need PNG, this is a real, permanent wart.

### 4c. Sizing math so it reflows

An equation exported at a fixed pixel size is correct on exactly one device at one font size. The
prototype takes MathJax's `ex` geometry and emits `<img>` dimensions in **`em`**, plus the
`vertical-align` MathJax computed, rasterizing at 2× so it still looks like type on a 300 dpi e-ink
panel:

```html
<img class="math-inline" src="math/m3.png" alt="_{t}"
     style="width:0.383em;height:0.509em;vertical-align:-0.178em"/>
```

The glyphs then track whatever size the reader picked. Whether Kindle honours `vertical-align` in
`em` on-device is **[unverified]** — §4a's tiering makes it mostly moot, since the inline cases that
need a baseline are the ones that became `<sup>`/`<sub>`.

---

## 5. What it would cost to ship this in the plugin

### 5a. The container is free **[measured]**

EPUB is a ZIP with two rules a general-purpose library will happily break (`mimetype` first, stored).
`node:zlib` gives raw DEFLATE; the rest is ~80 lines of struct packing. The plugin is
`isDesktopOnly`, so `node:zlib` is available. **No new dependency for stages 1 and 2.**

The Markdown reader is likewise hand-rolled against the subset `doctags.ts` emits — headings,
paragraphs, GFM tables, images, `$$` blocks, lists, fenced code, and the one Obsidian callout. That
is a deliberate bet, and §6 says when it breaks.

### 5b. The math renderer is not free **[measured]**

| | raw | gzipped |
|---|---:|---:|
| current `plugin/dist/main.js` | 4.57 MB | 1.34 MB |
| `mathjax-full/es5/tex-svg.js` | 2.06 MB | 662 KB |

Bundling MathJax's SVG output grows the plugin by **~45%**. And Obsidian's own copy does not help:
probing the live renderer, `window.MathJax` is 3.2.2 with `tex2chtml` / `tex2mml` but **no
`tex2svg`**, and `MathJax._.output` contains only `chtml`, `chtml_ts`, `common` — the SVG jax is not
in the bundle at all. `MathJax.loader` exists but would fetch from a CDN, which contradicts the
plugin's entire pitch and the two-pinned-assets promise in the README.

The one piece Obsidian *does* give us free: **rasterization works**. In the live renderer an SVG data
URL loads into an `Image`, draws to a canvas, and `toDataURL("image/png")` returns untainted PNG
bytes **[measured]**. So if we can produce an SVG, we can produce a PNG in-plugin with no dependency.

`tex2mml` also works, so MathML-in-EPUB3 is available for 0 KB — good on Apple Books, useless on
Kindle. Worth keeping in the back pocket, not worth building for.

### 5c. The idea that makes 5b unnecessary **[estimated at the time; §8 has since measured it]**

We already crop figures out of the rendered page raster: `convert.ts` calls `page.crop(fig.bbox)`.
And in `doctags.ts`, the `formula` case has a bbox **in scope and discards it**:

```ts
case "formula": {
  const tex = innerText(inner);      // <- bbox is right there, unused
  if (tex) blocks.push(`$$${tex}$$`);
```

So we could cut equations out of the page image the same way we cut figures. That means:

- **0 KB of bundle.** No MathJax anywhere.
- **The author's own typesetting**, not MathJax's approximation of a VLM's transcription of it —
  which matters here, because the VLM demonstrably truncates formulas (equation (1) in our own
  output is missing its closing paren and its `V`). A crop cannot be wrong about the math; it *is*
  the math.
- Cropping from the existing 2× page render is legible: a test crop of §3.1 of the paper comes out
  crisp, with inline math (`N = 6`, `LayerNorm(x + Sublayer(x))`, `d_model = 512`) clearly readable
  **[measured]**.

Against it: crops inherit scan quality and page background, cannot be restyled or inverted, cannot
scale beyond their raster, and are useless for a scanned or low-DPI source. And they only exist for
formulas the model tagged with a bbox.

*This section was written as an open trade. It has since been built and measured — see §8, which
resolves it in favour of crops.*

---

## 6. What this does not handle

The Markdown reader knows our generator's vocabulary, not CommonMark. Today that is fine, because we
wrote the input. It stops being fine **the moment a reader edits the note in Obsidian and then
exports** — which is a normal thing to want. Known gaps:

- ordered lists (`1.`) fall through to paragraphs; nested lists flatten
- Obsidian wikilinks `[[x]]` and embeds `![[x]]` pass through as literal text
- footnotes, task lists, setext headings, raw HTML blocks

Switching to a real CommonMark parser later is not a rewrite — `blocksToXhtml` is one function behind
one call site — but the XHTML must stay well-formed XML, which most Markdown libraries do not
guarantee, so it is a real evaluation and not a drop-in.

Other open items:

- **epubcheck has not been run.** §3.
- **Nothing has been opened on a physical device.** Kindle Previewer's KPF is strong evidence, not a
  photograph. §4b, §4c.
- **No cover image.** Kindle notices its absence; page 1 of the PDF is the obvious candidate and we
  already render it.
- **Tables.** They convert to `<table>` and pass validation, but the wide numeric tables in this
  corpus (13 columns) will be miserable on a 6" screen. Untouched by this spike.
- **Where the code lives.** The prototype is a Node CLI in `engine-js/tools/`. Shipping means a real
  module in `engine-js/src/` (so both the CLI and the plugin get it) plus a command and a settings
  toggle in the plugin. Not attempted here.

A second fixture earned its keep immediately: running the prototype against the `bert` package
crashed on `author:`, which frontmatter.ts emits as a YAML **list** while the prototype assumed a
scalar. Fixed, and a reminder that one document is not a test suite.

---

## 7. Follow-up — formula crops, built and measured **[measured]**

*2026-07-27, same day. §5c is no longer a hypothesis: the bboxes are retained, the crops are
written, and the exporter uses them.*

**What was built.** `<formula>` bboxes now survive `parseDocTags` (`FormulaRef`), get cropped in the
same page loop that already crops figures, and are written as `images/formula-N.png` with a
`formulas: [{id, tex, page}]` array in `meta.json`. **The `.md` is byte-for-byte unchanged** — it
still carries `$$...$$`, so Obsidian rendering is untouched and the note is not made worse to serve
an export. `md2epub.mjs --math crop` pairs `$$` blocks with the sidecar by document order and
**verifies each pairing against the recorded LaTeX**, falling back per formula to rendering when the
sidecar is absent, stale, or edited.

One trap worth recording: `convert.ts` runs `cleanMath()` over the assembled body, so the LaTeX in
the `.md` is *not* what the parser saw. The sidecar records `fixFormula(tex)` for exactly this
reason — `formula-2` below is stored wrapped in `\begin{aligned}`, which is `fixFormula`'s doing, and
without that the content check would never match.

**Result on `attention` (6 pages, converted through the plugin on WebGPU):**

| | crops | MathJax (`--stage 3`) |
|---|---:|---:|
| display formulas rendered | **4 of 4 (100%)** | 4 of 4 |
| fallbacks needed | **0** | — |
| math bytes | **19.3 KB** | 88.3 KB |
| build time | **17 ms** | ~400 ms |
| new dependencies | **none** | mathjax-full, 662 KB gzipped |

Crops came out **4.5× smaller** than the MathJax PNGs, which is the opposite of what §5c guessed.

**Legibility** is not a problem at the existing 2× render scale — all four are crisp, and no
higher-scale re-render is needed.

**The fidelity argument turned out to be the strongest one.** Two of the four equations are
*truncated in the model's LaTeX* and complete in the crop:

- `formula-1` transcribes as `... \text{softmax} ( \frac{QK^{T}}{\sqrt{d_{k}}}` — missing the closing
  `)V` and the equation number. The crop is the whole of equation (1), tag included.
- `formula-4` transcribes as `PE_{(pos,2i)} = \sin(pos/1000` — truncated mid-number, and only the
  first of the two equations. The crop has both, with their `2i/d_model` exponents.

So on this document the crop path is not merely cheaper than rendering the LaTeX — **it is more
correct**, because it routes around the VLM transcription errors that the conversion warnings already
flag. A renderer can only ever be as good as the transcription it is given.

**All three gates pass** on the crop build:

- epubcheck v5.3.0 — 0 fatals / 0 errors / 0 warnings / 0 infos
- Kindle Previewer 3.106 — Success, 0 errors, 0 quality issues, Enhanced Typesetting Supported
- KPF resources — **8 = 4 figures + 4 formulas**, i.e. unlike the SVG build, the equations actually
  reach the device

**Still open.** One paper, 6 pages, one layout. Coverage was 100% here, but a formula the model does
not tag with a bbox still falls back, and two-column layouts and scanned sources are untested. Night
mode remains a wart shared with any raster path. And nothing has yet been opened on a physical
Kindle.

## 8. If we build it

1. **Stages 1 and 2 are basically done and cost nothing.** A "Export to EPUB" command producing a
   text-and-figures EPUB is a small, self-contained piece of work with no new dependencies.
2. **Do the §4a tiering before any renderer.** It removes two-thirds of the formulas from the
   problem, and it is twenty lines.
3. ~~Spike 5c next, before committing to 5b.~~ **Done — see §7. Do not ship MathJax.** Crops cover
   every display formula, cost 4.5× fewer bytes, need no dependency, and are *more* correct than
   rendering the model's LaTeX. Keep a renderer only as a fallback question for notes with no
   sidecar, and note that leaving those as LaTeX text is a legitimate answer.
4. **Emit SVG for EPUB 3 readers and raster for Kindle** — the same book cannot serve both well, so
   this is either a setting or two export targets. §4b says the failure is silent, which argues for
   defaulting to raster.
5. **Open one book on a real Kindle** before any of this is called done. epubcheck, Kindle Previewer
   and the KPF resource count all pass (§7), but none of them is a screen.

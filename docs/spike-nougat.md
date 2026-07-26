# Spike sketch — `facebook/nougat-small` as a cheaper VLM than granite-docling

*2026-07-25. A time-boxed spike proposal, not a decision. Everything below marked **[measured]**
comes from a local run or an HTTP fetch made while writing this; everything marked **[estimated]**
is arithmetic on published configs and is exactly what the spike exists to replace with numbers.
Context: [perf-and-portability.md §4b](perf-and-portability.md) (granite-docling is correct but
~41 s/page on WebGPU, ~250 s/page on ORT CPU).*

---

## 1. The one-line answer to each question

| Question | Answer |
|---|---|
| Can it run under the same web frameworks in Node? | **Yes, essentially unchanged.** transformers.js already ships `NougatImageProcessor`, `NougatTokenizer` and `VisionEncoderDecoderModel`, and `Xenova/nougat-small` is a published ONNX export. Same `loadVlm`-shaped code path, same onnxruntime-node CPU / WebGPU split. |
| Does the safetensors file help? | **No — it's the wrong artifact.** transformers.js runs ONNX, never safetensors. What makes this cheap is that someone already exported it; the 990 MB safetensors would otherwise need an `optimum` export first. |
| Is it smaller / lighter than granite-docling? | **Not smaller. Plausibly faster.** Same parameter class (247 M vs 258 M, ~1 GB fp32 either way). The interesting difference is decoder *shape*, not size — see §3. |
| Could it be modified to run on LiteRT.js? | **Not worth spiking now.** No `.tflite` exists, LiteRT.js is browser-only (kills the Node benchmark harness), and generative/autoregressive is a different Google product. Details + a genuinely interesting hybrid in §7. |

---

## 2. What exists today **[measured]**

Fetched from the HF API, 2026-07-25.

**`facebook/nougat-small`** — license **`cc-by-4.0`** (note: *not* the `-nc` variant sometimes
assumed from the paper repo; commercially usable, unlike the Marker weights we license-excluded).
0.2 B params, `model.safetensors` 990 MB F32.

```
encoder  donut-swin   image_size [896, 672]  patch 4  embed_dim 128  depths [2,2,14,2]
decoder  mbart        d_model 1024  decoder_layers 4  heads 16  ffn 4096
                      vocab 50000  max_position_embeddings 3584
```

**`Xenova/nougat-small`** — the ONNX export transformers.js loads. Last modified 2024-10-08, and
its model card declares **no license field** (provenance caveat: if this ever ships, re-export from
`facebook/` ourselves with `optimum` rather than depending on an unlabelled mirror).

| File | fp32 | fp16 | int8 (`_quantized`) |
|---|---:|---:|---:|
| `encoder_model` | 302.0 MB | 153.4 MB | 81.4 MB |
| `decoder_model_merged` | 693.4 MB | 347.0 MB | 174.1 MB |
| **total** | **995 MB** | **500 MB** | **256 MB** |

For comparison, the validated granite-docling config in `src/vlm.ts` is ~1 GB. **There is no size
win at fp32.** There may be one at int8 — but §4b already measured that granite garbles at q8/q4 on
both providers, so treat int8 as a hypothesis gated on the fixture checks, not a given. (Nougat's
Swin+mBART is a far more conventional op set than granite's Idefics3 stack, so it has a better prior
of surviving dynamic quantization — that alone is worth one bench cell.)

**Framework support is already in our `node_modules`** — transformers.js 4.2.0 exposes
`NougatImageProcessor` (extends `DonutImageProcessor`, with real `crop_margin` and `thumbnail`
implementations), `NougatTokenizer`, `VisionEncoderDecoderModel`, `AutoModelForVision2Seq`. Nothing
to write to *load* it.

---

## 3. Why it might be cheaper — the actual hypothesis **[estimated]**

Autoregressive decode dominates our per-page cost, so compare decoders, not totals:

| | granite-docling-258M | nougat-small |
|---|---|---|
| decoder | llama, **30 layers**, hidden 576, ffn 1536 | mBART, **4 layers**, hidden 1024, ffn 4096 |
| image conditioning | Idefics3 **image tokens prefixed into the decoder context**, re-attended at every step, in all 30 layers | **cross-attention** to a fixed 588-state encoder output; decoder self-attention is text-only |
| non-embedding MACs / token | ~119 M | ~67 M |
| kernel dispatches / token | ~30 blocks | ~4 blocks |

Two independent reasons to expect a speedup, of different sizes:

1. **~1.8× fewer FLOPs per token.** Real but modest — the layer count (7.5×) badly overstates it,
   because nougat's layers are individually much fatter.
2. **~7× fewer kernel dispatches per token, and a smaller attention context.** This is the one that
   could matter more. §3 of the perf doc already documented granite being *dispatch-bound* on MPS
   ("small hidden size makes it dispatch-bound", ~100 s/page); `src/core/types.ts` already carries a
   comment that Idefics3 image tokens "inflate the per-step attention cost for the whole
   generation". Nougat structurally avoids both.

Against that, nougat pays a **fixed per-page Swin encoder forward at 896×672 with depths
[2,2,14,2]** — real ViT-scale work, but once per page rather than once per token.

**Honest expectation: 2–4× on decode, not 7×.** If it lands below ~2×, the spike should stop —
that's not enough to justify a second model, a second output grammar, and the losses in §5.

---

## 4. Where it plugs into the existing engine

The seam is cleaner than it looks, because `core/convert.ts` is already
platform-agnostic and takes an injected `Vlm`:

```
pdf.ts (unchanged)  →  Vlm.pageToDocTags()  →  parseDocTags()  →  frontmatter/mathjax  →  package
                       ^^^^^^^^^^^^^^^^^^^     ^^^^^^^^^^^^^^
                       swap: nougat driver     replace: nougat emits Mathpix Markdown,
                       (VisionEncoderDecoder,  not DocTags — this parser does not apply
                        no chat template)
```

Concretely:

- **`src/vlm-nougat.ts`** — same `Vlm` interface, but `AutoModelForVision2Seq.from_pretrained`
  with no chat template: input is `pixel_values` only, generation starts from BOS.
  `max_new_tokens` must cap at **3584** (a hard model limit — `max_position_embeddings`),
  not our current 4096.
- **The degenerate-generation guard is reused unchanged.** `src/core/guard.ts`'s short-cycle
  detector was written for granite's repetition pathology; nougat's best-known failure mode is
  exactly the same (the original repo ships a bespoke repetition detector for it). Free reuse, and
  a nice validation that the guard wasn't over-fitted to one model.
- **`src/mmd.ts` (new, the real work)** — Mathpix Markdown → our Markdown: `\(…\)`/`\[…\]` →
  `$…$`/`$$…$$`, `\section*{}`/`\subsection*{}` → `#`/`##`, LaTeX `tabular` → pipe tables,
  `[MISSING_PAGE_*]` markers → explicit warnings (never silently dropped). Note that Python's
  `NougatTokenizerFast.post_process_generation` and `nougat.postprocessing.markdown_compatible`
  have **no JS equivalent** — the JS `NougatTokenizer` is a bare `PreTrainedTokenizer`. A
  benchmark-grade subset is a day; production parity is more.
- **`assembleDocument` needs a parser seam.** It calls `parseDocTags` directly today. Minimal
  change: hoist the parser to an injected `(raw, figCount) => ParsedPage`. Do this rather than
  forking the orchestrator — otherwise the two engines drift and the parity claim dies.
- **Judged by `src/testing/fixture-checks.ts`, unchanged.** That module exists precisely so every
  backend is scored by literally the same code. Nougat gets no special treatment.
- **`tools/bench.ts`, unchanged in shape** — token-capped, so a slow backend yields lower
  tokens/sec rather than a truncated page. The nougat numbers land directly comparable to the
  granite numbers already in §4b.

---

## 5. What we lose — read this before running the spike

These are not spike risks; they are known, structural, and they decide whether a *good* benchmark
result is even actionable.

1. **No bounding boxes at all.** Nougat emits no `<loc_*>` equivalent. That means **no figure
   crops and no provenance links back to source pages** — two of this project's headline promises
   ("Figures, tables, and math survive", "provenance links back to source pages"). Nougat gives you
   figure *captions*; the images are simply gone. Recovering them needs either pdf.js embedded-image
   extraction or a separate layout pass — i.e. re-introducing the modular stack we were trying to
   collapse.
2. **Tables come back as LaTeX `tabular`, not structure.** Obsidian won't render those. The
   converter in §4 has to reconstruct table structure from LaTeX — strictly harder than OTSL, and
   the numeric-fidelity check is the arbiter.
3. **Silent-wrongness risk is at least as high.** §3 of the perf doc flags VLM cell-invention as
   the single biggest reason to keep the modular path. Nougat is *more* documented for hallucination
   and repetition than granite-docling, not less.
4. **Scientific papers only.** Nougat was trained on arXiv-sourced LaTeX. Our whole fixture suite
   (attention, vae = arXiv; bert = ACL; ioannidis = PLOS) sits squarely in-distribution — so **this
   benchmark will flatter nougat**, and we should say so in the writeup rather than discover it later
   on a datasheet or a scanned report. Granite-docling is a general document model; that difference
   won't show up in our four fixtures at all.
5. **Version pinning collides.** §4b pinned transformers.js to **3.7.5** because 4.2.0 garbles
   granite on WebGPU. If both models ever ship in one build, both must work on one pinned version —
   so nougat gets benched on **both** 3.7.5 and 4.2.0, and "works on 4.2.0" is a result worth
   recording either way.

---

## 6. The spike itself — phased, with kill criteria

Total budget **~2 days**. Each phase has a gate; failing a gate ends the spike and the writeup goes
into this file as a negative result (same as §4a did for LiteRT).

| Phase | Work | Gate to continue |
|---|---|---|
| **0 — smoke** (~1 h) | `Xenova/nougat-small` under transformers.js 4.2.0, ORT CPU, fp32. One page of `attention.pdf`. Dump raw output. | Output is recognisable Mathpix Markdown, not repetition garbage. If fp32 CPU garbles the way granite's quants did, stop. |
| **1 — the actual question** (~½ day) | `tools/bench.ts` shape, token-capped at 128 new tokens, pages 1–2 of `attention.pdf`. Cells: {CPU fp32, CPU int8} × {tjs 3.7.5, 4.2.0}, plus WebGPU fp16 in `engine-js/web/`. Report tokens/sec, s/page, peak RSS — the same fields as §4b. | **≥2× granite's tokens/sec on the matching provider.** Below that, the losses in §5 aren't buyable. This phase alone answers the user's question. |
| **2 — is it any good** (~½–1 day) | Minimal `mmd.ts` + parser seam in `assembleDocument`; run all four fixtures through `runFixtureChecks`. | No *worse* than granite on math/heading/table-cell checks. Figure-count checks **will** fail (§5.1) — score them separately and honestly rather than relaxing the check. |
| **3 — optional** (~½ day) | WebGPU run in the Obsidian/Electron pane, mirroring §4b's granite methodology exactly. | — |

**Explicitly out of scope:** figure recovery, production-grade mmd post-processing, `nougat-base`
(a published ONNX export exists as the quality rung above — only fetch it if small passes phase 1
but fails phase 2), plugin integration.

**Deliverable:** a §4c in [perf-and-portability.md](perf-and-portability.md) with a table in the
same format as §4b, so the three engines (Python docling, granite-docling ONNX, nougat) are read
off one page. Negative results get written up too.

---

## 7. LiteRT.js — verdict: no, and here's the specific reason **[measured]**

[§4a](perf-and-portability.md) already ruled LiteRT.js out for granite-docling. Re-checked today
against nougat specifically; the verdict holds, and the reasons are the same ones:

- **No `.tflite` nougat export exists.** The HF `tflite` filter returns **zero** nougat models
  (checked 2026-07-25). We would be converting a 247 M VisionEncoderDecoder ourselves.
- **LiteRT.js is browser-only.** Google's own docs describe "in-browser hardware-accelerated
  inference" (WebGPU / WebNN / WASM-XNNPACK) with no Node story. That kills the entire reason we
  want this model: the Node CLI *is* the benchmark harness that makes a docling comparison easy.
- **Generative decode is a different product.** Autoregressive/KV-cache work is documented under
  LiteRT-LM, not `@litertjs/core`; the docs point you elsewhere for LLMs. Converting the mBART
  decoder means a multi-signature stateful `.tflite` **plus writing the autoregressive sampling loop
  in JS yourself** — which transformers.js hands us for free today.

**The one genuinely interesting variant, for the record:** nougat splits more cleanly than granite
does. Its encoder is a *single-shot, fixed-shape* 896×672 Swin producing 588×1024 — exactly the
static vision workload LiteRT.js/WebNN is good at, and about a third of the parameters — while the
decoder stays on ORT. That hybrid is only worth building if phase 1 shows the **encoder**, not
decode, is the bottleneck. It almost certainly won't. Measure first; the bench prints the split.

**Re-open triggers** (in addition to §4a's): a `litert-community` nougat/Donut-Swin `.tflite`
appears, **or** phase 1 shows the per-page encoder forward is >40% of page time.

---

## 8. Sources

Model/export: [facebook/nougat-small](https://huggingface.co/facebook/nougat-small) ·
[Xenova/nougat-small (ONNX)](https://huggingface.co/Xenova/nougat-small) ·
[Xenova/nougat-base](https://huggingface.co/Xenova/nougat-base) ·
[ibm-granite/granite-docling-258M](https://huggingface.co/ibm-granite/granite-docling-258M)
(configs compared in §3) ·
[Nougat paper](https://arxiv.org/abs/2308.13418)
Runtime: [transformers.js v4](https://huggingface.co/blog/transformersjs-v4) ·
[LiteRT for Web](https://developers.google.com/edge/litert/web) ·
[LiteRT.js announcement](https://developers.googleblog.com/litertjs-googles-high-performance-web-ai-inference/) ·
[@litertjs/core on npm](https://www.npmjs.com/package/@litertjs/core)

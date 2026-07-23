/**
 * granite-docling-258M as ONNX under transformers.js.
 *
 * IBM ships the hard part: onnx-community/granite-docling-258M-ONNX (Apache-2.0;
 * vision encoder + embed + merged decoder). A full page raster goes in, a single
 * DocTags generation comes out. This is the linchpin of the portable story —
 * the same code path runs under onnxruntime-node (this CLI), in an Obsidian
 * renderer, or on WebGPU in a browser; only `device`/`dtype` change.
 *
 * NOTE: first use downloads weights (~190 MB q4f16). Exercised at M2's gate; the
 * transformers.js surface is accessed through a lazy dynamic import + a local
 * interface so this module type-checks across v4 point releases.
 */

export const DEFAULT_MODEL = "onnx-community/granite-docling-258M-ONNX";
export const DEFAULT_PROMPT = "Convert this page to docling.";

/** Per-subgraph precision. q4f16 decoder is the ~190 MB sweet spot; fp16 vision floor. */
export type DtypeMap = Record<string, string>;

/** transformers.js accepts a single dtype string or a per-subgraph map. */
export type Dtype = string | DtypeMap;

/**
 * WebGPU (browser) default: q4f16 decoder + fp16 towers — the ~190 MB sweet spot,
 * and what IBM's demo ships. **Do not use on the ORT CPU provider**: fp16/q4
 * matmuls garble there (and the fp16 vision encoder trips SimplifiedLayerNormFusion).
 */
export const WEBGPU_DTYPE: DtypeMap = {
  embed_tokens: "fp16",
  vision_encoder: "fp16",
  decoder_model_merged: "q4f16",
};

/**
 * CPU (onnxruntime-node) default: fp32 everywhere — numerically correct on CPU,
 * where fp16/q4 produce degenerate garbage. Larger/slower; M3 evaluates int8 as
 * the CPU size/speed compromise, gated on the fixture numeric-fidelity tests.
 */
export const CPU_DTYPE = "fp32";

export interface VlmOptions {
  modelId?: string;
  dtype?: Dtype;
  /** "cpu" (onnxruntime-node), "webgpu" (browser), or "auto". */
  device?: "cpu" | "webgpu" | "auto";
  /**
   * Hard cap on generation. 4096 is generous for a dense page; the cap is the
   * guard against the known degenerate-repetition / infinite-loop failure mode.
   */
  maxNewTokens?: number;
  prompt?: string;
}

export interface Vlm {
  /** Run one page raster (RGBA) through the model, returning raw DocTags. */
  pageToDocTags(rgba: Uint8ClampedArray, width: number, height: number): Promise<string>;
  /** ONNX execution providers actually in use — recorded into meta.json, never guessed. */
  executionProviders: string[];
  /** e.g. "onnx-community/granite-docling-258M-ONNX@q4f16". */
  modelLabel: string;
  dispose(): void;
}

/** Minimal view of the transformers.js surface we depend on. */
interface Transformers {
  AutoProcessor: { from_pretrained(id: string, opts?: unknown): Promise<any> };
  AutoModelForVision2Seq: { from_pretrained(id: string, opts?: unknown): Promise<any> };
  RawImage: new (data: Uint8ClampedArray | Uint8Array, width: number, height: number, channels: number) => any;
  env: any;
}

async function loadTransformers(): Promise<Transformers> {
  return (await import("@huggingface/transformers")) as unknown as Transformers;
}

export async function loadVlm(opts: VlmOptions = {}): Promise<Vlm> {
  const t = await loadTransformers();
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const device = opts.device ?? "cpu";
  const isCpu = device === "cpu";
  // Device-aware default: fp16/q4 only on WebGPU; fp32 on the ORT CPU provider.
  const dtype: Dtype = opts.dtype ?? (isCpu ? CPU_DTYPE : WEBGPU_DTYPE);
  const maxNewTokens = opts.maxNewTokens ?? 4096;
  const prompt = opts.prompt ?? DEFAULT_PROMPT;

  const modelOpts: Record<string, unknown> = { dtype, device };
  // The SimplifiedLayerNormFusion crash is fp16-specific (an InsertedPrecisionFreeCast
  // the fusion can't resolve). Only disable graph optimization when running fp16 towers.
  if (!isCpu) modelOpts.session_options = { graphOptimizationLevel: "disabled" };

  const processor = await t.AutoProcessor.from_pretrained(modelId);
  const model = await t.AutoModelForVision2Seq.from_pretrained(modelId, modelOpts);

  const decoderDtype = typeof dtype === "string" ? dtype : (dtype.decoder_model_merged ?? "fp16");
  const modelLabel = `${modelId}@${decoderDtype}`;
  // Best-effort provider record; M2 tightens this to assert the real ORT EP.
  const executionProviders = [isCpu ? "cpu" : device];

  return {
    modelLabel,
    executionProviders,
    async pageToDocTags(rgba, width, height): Promise<string> {
      const image = new t.RawImage(rgba, width, height, 4).rgb();

      const messages = [
        { role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] },
      ];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      // Idefics3/SmolVLM processor signature is _call(text, images) — text first.
      const inputs = await processor(text, image);

      const generated = await model.generate({ ...inputs, max_new_tokens: maxNewTokens });

      // Decode only the newly generated tail (drop the prompt tokens).
      const promptLen = inputs.input_ids.dims.at(-1) as number;
      const trimmed = generated.slice(null, [promptLen, null]);
      const decoded: string[] = processor.batch_decode(trimmed, { skip_special_tokens: false });
      const raw = decoded[0] ?? "";
      if (process.env.PDF2MD_DEBUG_DOCTAGS) {
        process.stderr.write(`\n=== RAW DOCTAGS (${raw.length} chars) ===\n${raw}\n=== END ===\n`);
      }
      return stripChrome(raw);
    },
    dispose() {
      model?.dispose?.();
    },
  };
}

/** Remove chat-template chrome / eos so only DocTags remain. */
function stripChrome(s: string): string {
  return s
    .replace(/<end_of_utterance>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\/?doctag>/g, "")
    .trim();
}

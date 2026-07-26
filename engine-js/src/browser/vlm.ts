/**
 * Browser/renderer VLM adapter — granite-docling on WebGPU. The transformers.js
 * module is injected so the host picks the version (WebGPU needs 3.7.5; 4.2.0
 * regressed to all-"!" — see perf doc §4b) and manages its own wasm/worker setup.
 *
 * Uses IBM's validated WebGPU dtype (fp32 decoder + vision, fp16 embed) and the
 * shared degenerate-generation guard.
 */

import { createGuard } from "../core/guard.js";
import type { PageResult, Vlm } from "../core/types.js";

export const DEFAULT_MODEL = "onnx-community/granite-docling-258M-ONNX";
export const DEFAULT_PROMPT = "Convert this page to docling.";

/** Validated WebGPU dtype — q4f16 garbles here, so decoder+vision run fp32. */
export const WEBGPU_DTYPE = {
  embed_tokens: "fp16",
  vision_encoder: "fp32",
  decoder_model_merged: "fp32",
};

export interface BrowserVlmOptions {
  modelId?: string;
  dtype?: Record<string, string>;
  device?: string;
  maxNewTokens?: number;
  perPageTimeoutMs?: number;
  prompt?: string;
  /** transformers.js download/compile progress. */
  progressCallback?: (p: unknown) => void;
  /**
   * Per-token heartbeat: `(tokensSoFar, msSinceGenerationStart)`.
   *
   * Diagnostic seam. A stalled WebGPU run and a merely slow one look identical
   * from outside `generate()` — both are just a promise that hasn't settled —
   * so the bench probes need a signal that ticks per decode step.
   */
  onStep?: (tokens: number, ms: number) => void;
  /** Abort in-flight generation; checked between decode steps by the guard. */
  signal?: { aborted: boolean };
}

export async function createBrowserVlm(transformers: any, opts: BrowserVlmOptions = {}): Promise<Vlm> {
  const { AutoProcessor, AutoModelForVision2Seq, RawImage, StoppingCriteria } = transformers;
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const dtype = opts.dtype ?? WEBGPU_DTYPE;
  const device = opts.device ?? "webgpu";
  const maxNewTokens = opts.maxNewTokens ?? 4096;
  const perPageTimeoutMs = opts.perPageTimeoutMs ?? 120_000;
  const prompt = opts.prompt ?? DEFAULT_PROMPT;

  const processor = await AutoProcessor.from_pretrained(modelId);
  const model = await AutoModelForVision2Seq.from_pretrained(modelId, {
    dtype,
    device,
    progress_callback: opts.progressCallback,
  });

  return {
    modelLabel: `${modelId}@${dtype.decoder_model_merged ?? "fp32"}`,
    executionProviders: [device],
    async pageToDocTags(rgba, width, height): Promise<PageResult> {
      const image = new RawImage(rgba, width, height, 4).rgb();
      const messages = [
        { role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] },
      ];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await processor(text, image);

      const guard = createGuard(StoppingCriteria, perPageTimeoutMs, 16, opts.signal);
      const criteria: unknown[] = [guard];
      if (opts.onStep) {
        // A criteria that never stops — just a per-step callback, since
        // transformers.js has no other hook that fires once per decode step.
        const onStep = opts.onStep;
        const tGen = performance.now();
        let steps = 0;
        criteria.push(
          new (class extends StoppingCriteria {
            _call(input_ids: number[][]): boolean[] {
              onStep(++steps, Math.round(performance.now() - tGen));
              return input_ids.map(() => false);
            }
          })(),
        );
      }
      const generated = await model.generate({
        ...inputs,
        max_new_tokens: maxNewTokens,
        stopping_criteria: criteria,
      });

      const promptLen = inputs.input_ids.dims.at(-1) as number;
      const trimmed = generated.slice(null, [promptLen, null]);
      const genTokens = trimmed.dims.at(-1) as number;
      const raw: string = processor.batch_decode(trimmed, { skip_special_tokens: false })[0] ?? "";
      const docTags = raw
        .replace(/<end_of_utterance>/g, "")
        .replace(/<\|end_of_text\|>/g, "")
        .replace(/<\/?doctag>/g, "")
        .trim();
      const truncated = guard.triggered ?? (genTokens >= maxNewTokens ? "max_tokens" : null);
      return { docTags, truncated, genTokens, promptTokens: promptLen };
    },
    dispose() {
      model?.dispose?.();
    },
  };
}

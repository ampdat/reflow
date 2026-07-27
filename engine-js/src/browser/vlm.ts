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

/**
 * Everything fp32.
 *
 * Two independent reasons, either one sufficient. The CPU dtype sweep (M2) found
 * fp32 the only correct option — q4f16 and q8 garble — and wasm's fp16 support
 * is partial anyway, so the halved weights buy an accuracy risk and no speed.
 * This is also the safe dtype for a WebGPU adapter without `shader-f16`, which
 * is the case Apple silicon never exercises and an older Intel iGPU might.
 */
export const FP32_DTYPE = {
  embed_tokens: "fp32",
  vision_encoder: "fp32",
  decoder_model_merged: "fp32",
};

/**
 * dtype for a device, given whether the adapter advertises `shader-f16`.
 *
 * Only WebGPU-with-f16 gets the fp16 embedding table; everything else — wasm,
 * WebNN, a WebGPU adapter without f16 shaders — runs fp32 throughout.
 */
export function dtypeForDevice(device: string, shaderF16 = true): Record<string, string> {
  return device === "webgpu" && shaderF16 ? WEBGPU_DTYPE : FP32_DTYPE;
}

export interface BrowserVlmOptions {
  modelId?: string;
  /** Overrides the per-device default; normally leave unset. */
  dtype?: Record<string, string>;
  /**
   * One device, or an ordered list of candidates to try in turn — see
   * `deviceCandidates()` in `./device.js`. The first that loads wins.
   */
  device?: string | string[];
  /** Whether the WebGPU adapter has `shader-f16` (picks the fp16 embedding). */
  shaderF16?: boolean;
  /** Fires once the model has loaded, with the device it actually landed on. */
  onDevice?: (info: { device: string; requested: string[]; fellBack: boolean }) => void;
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
  const maxNewTokens = opts.maxNewTokens ?? 4096;
  const perPageTimeoutMs = opts.perPageTimeoutMs ?? 120_000;
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const candidates = normalizeDevices(opts.device);

  const processor = await AutoProcessor.from_pretrained(modelId);
  const { model, device, dtype, fellBack } = await loadOnFirstWorkingDevice(
    transformers,
    AutoModelForVision2Seq,
    modelId,
    candidates,
    opts,
  );
  // Fired at load time, before the first page: the host needs to warn *before*
  // a slow conversion, not after. It reports the device that loaded; the
  // stricter runtime-confirmed value lands in `executionProviders`/meta.json,
  // which is read at the end when ORT can actually be asked.
  opts.onDevice?.({ device, requested: candidates, fellBack });

  return {
    modelLabel: `${modelId}@${dtype.decoder_model_merged ?? "fp32"}`,
    /**
     * A getter, not a value: `types.ts` asks for the providers "actually in
     * use, never guessed", and the runtime can only be asked once it has run
     * something. Reading this after the last page — which is when
     * `assembleDocument` records it — gets the truth; reading it at
     * construction would get the same guess as before.
     */
    get executionProviders(): string[] {
      return [verifiedDevice(transformers, device)];
    },
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

function normalizeDevices(device: string | string[] | undefined): string[] {
  if (Array.isArray(device)) return device.length ? device : ["webgpu"];
  return [device ?? "webgpu"];
}

/**
 * Load the model on the first device in `candidates` that works.
 *
 * The probe in `./device.js` already ruled out the backends this machine plainly
 * lacks; this catches what only shows up under load — a driver that advertises
 * an adapter and then fails to compile a shader, an unsupported op in a WebNN
 * provider, a GPU without the memory for a 1 GB fp32 model. The cost of a failed
 * attempt is bounded: weights are cached by the time a second device is tried,
 * so it is a re-initialization, not a re-download.
 *
 * Only *loading* falls back. Once pages are being converted, a failure is a real
 * failure and surfaces as one — silently switching backends mid-document would
 * mean two halves of a paper produced by different numerics.
 */
async function loadOnFirstWorkingDevice(
  transformers: any,
  AutoModelForVision2Seq: any,
  modelId: string,
  candidates: string[],
  opts: BrowserVlmOptions,
): Promise<{ model: any; device: string; dtype: Record<string, string>; fellBack: boolean }> {
  const failures: string[] = [];
  for (const [i, device] of candidates.entries()) {
    const dtype = opts.dtype ?? dtypeForDevice(device, opts.shaderF16 ?? true);
    try {
      const model = await AutoModelForVision2Seq.from_pretrained(modelId, {
        dtype,
        device,
        progress_callback: opts.progressCallback,
      });
      return { model, device, dtype, fellBack: i > 0 };
    } catch (e: any) {
      const why = String(e?.message ?? e).slice(0, 200);
      failures.push(`${device}: ${why}`);
      console.warn(`[engine] ${device} unavailable for ${modelId} — ${why}`);
    }
  }
  throw new Error(
    `no usable compute backend for ${modelId}. Tried ${candidates.length}: ${failures.join(" | ")}`,
  );
}

/**
 * Confirm a claimed device against the runtime.
 *
 * onnxruntime-web populates `env.backends.onnx.webgpu.device` with the live
 * `GPUDevice` once its WebGPU backend has initialized, so its absence after a
 * successful load means the work is running somewhere other than where we asked
 * — which ORT has been known to do quietly (spike `4333ef2`: a wasm build
 * without the WebGPU-capable variant silently ran on CPU and still returned
 * correct numbers). There is no equivalent handle for WebNN or wasm, so those
 * are reported as requested.
 */
function verifiedDevice(transformers: any, device: string): string {
  if (device !== "webgpu") return device;
  try {
    const onnx = transformers?.env?.backends?.onnx;
    if (onnx && "webgpu" in onnx && !onnx.webgpu?.device) return "wasm (webgpu requested)";
  } catch {
    /* diagnostics must never break a conversion */
  }
  return device;
}

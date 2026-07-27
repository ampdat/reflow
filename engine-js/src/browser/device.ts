/**
 * Which compute backend can this machine actually run, and in what order?
 *
 * Until now the browser VLM asked for `device: "webgpu"` unconditionally. On the
 * one machine this was developed on that is correct; everywhere else it is a
 * guess that fails as a raw `Unsupported device: webgpu` from deep inside
 * transformers.js, part-way through a conversion the user already started.
 *
 * This module answers the question up front, cheaply (an adapter request, no
 * model download), so the host can say *why* before committing, pick a working
 * fallback, and warn honestly about what that fallback costs.
 *
 * Deliberately pure and injectable: it reads `navigator` through a small seam so
 * the ordering logic is unit-testable off-device — the whole point being that
 * none of the interesting cases (no WebGPU, no `shader-f16`, WebNN present) can
 * be reproduced on the development machine.
 */

/** transformers.js device strings we are willing to run on. */
export type ComputeDevice = "webnn-npu" | "webnn-gpu" | "webgpu" | "wasm";

/** What the user asked for; `auto` means "use the probe's ordering". */
export type DevicePreference = "auto" | "webgpu" | "webnn" | "wasm";

export interface BackendAvailability {
  available: boolean;
  /** Human-readable reason when unavailable — this is what the user sees. */
  reason?: string;
  /** Extra facts worth recording (adapter vendor, WebNN device types). */
  detail?: Record<string, unknown>;
}

export interface DeviceProbe {
  webgpu: BackendAvailability;
  webnn: BackendAvailability;
  /**
   * Whether the WebGPU adapter advertises `shader-f16`.
   *
   * The validated WebGPU dtype runs `embed_tokens` in fp16. Apple silicon has
   * had f16 shaders since day one, so this never came up; older Intel iGPUs are
   * the case where it might be missing, and the fix is a dtype change, not a
   * backend change.
   */
  shaderF16: boolean;
}

/** The subset of `navigator` this needs — injectable so tests can fake it. */
export interface DeviceNavigator {
  gpu?: {
    requestAdapter(opts?: unknown): Promise<{
      features?: { has(name: string): boolean };
      info?: { vendor?: string; architecture?: string; device?: string };
      limits?: Record<string, number>;
    } | null>;
  };
  ml?: {
    createContext(opts?: unknown): Promise<unknown>;
  };
}

/**
 * Ask the machine what it has. Never throws: every failure becomes a `reason`,
 * because "we could not find out" and "it is not there" lead to the same
 * fallback and the user is owed the difference in words, not in an exception.
 */
export async function probeDevices(nav: DeviceNavigator | undefined): Promise<DeviceProbe> {
  const probe: DeviceProbe = {
    webgpu: { available: false, reason: "This build of Obsidian has no WebGPU support." },
    webnn: { available: false, reason: "WebNN is not enabled in this app." },
    shaderF16: false,
  };
  if (!nav) return probe;

  if (nav.gpu) {
    try {
      // `high-performance` matters on laptops with two GPUs: the default can
      // hand back the integrated one while a discrete GPU sits idle.
      const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        probe.shaderF16 = adapter.features?.has("shader-f16") ?? false;
        probe.webgpu = {
          available: true,
          detail: {
            vendor: adapter.info?.vendor ?? null,
            architecture: adapter.info?.architecture ?? null,
            shaderF16: probe.shaderF16,
            maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
            maxBufferSize: adapter.limits?.maxBufferSize ?? null,
          },
        };
      } else {
        // navigator.gpu exists but no adapter: a blocklisted driver, a VM with
        // no GPU, or Linux without the WebGPU feature flag.
        probe.webgpu = {
          available: false,
          reason: "No WebGPU adapter available — the GPU or its driver is not supported.",
        };
      }
    } catch (e: any) {
      probe.webgpu = { available: false, reason: `WebGPU adapter request failed: ${msg(e)}` };
    }
  }

  if (nav.ml) {
    const contexts: Record<string, string> = {};
    for (const deviceType of ["npu", "gpu"]) {
      try {
        const ctx = await nav.ml.createContext({ deviceType, powerPreference: "high-performance" });
        contexts[deviceType] = ctx ? "ok" : "null";
      } catch (e: any) {
        contexts[deviceType] = `error: ${msg(e)}`;
      }
    }
    const usable = Object.entries(contexts).filter(([, v]) => v === "ok").map(([k]) => k);
    probe.webnn = usable.length
      ? { available: true, detail: { contexts, usable } }
      : { available: false, reason: "WebNN is present but no device context could be created.", detail: { contexts } };
  }

  return probe;
}

/**
 * Ordered devices to try, best first. The VLM walks this list and keeps the
 * first that loads.
 *
 * **WebNN is never in the automatic order, by measurement.** Chromium ships it
 * behind `--enable-features=WebMachineLearningNeuralNetwork` and Obsidian does
 * not set that flag, so `navigator.ml` is absent in a stock install (spike
 * `4333ef2`: absent in Obsidian, in Node, and in a stock Chromium; present and
 * fully working — NPU included — once the flag is passed). A plugin cannot set
 * Obsidian's launch flags. Putting it first by default would therefore cost a
 * failed probe on every conversion for every user, to benefit nobody who had not
 * already opted in by editing their launch command. And when it *is* present,
 * whether ORT's WebNN provider covers a VLM decoder's op set is unproven — that
 * failure would arrive after a ~1 GB model load, which is the expensive kind.
 * So it is available on request (`preference: "webnn"`) and never by surprise.
 */
export function deviceCandidates(pref: DevicePreference, probe: DeviceProbe): ComputeDevice[] {
  const webnn: ComputeDevice[] = [];
  if (probe.webnn.available) {
    const usable = (probe.webnn.detail?.usable as string[] | undefined) ?? [];
    if (usable.includes("npu")) webnn.push("webnn-npu");
    if (usable.includes("gpu")) webnn.push("webnn-gpu");
  }
  const gpu: ComputeDevice[] = probe.webgpu.available ? ["webgpu"] : [];

  switch (pref) {
    case "wasm":
      return ["wasm"];
    case "webgpu":
      // An explicit choice still falls back rather than failing outright — the
      // warning tells the user what happened.
      return [...gpu, "wasm"];
    case "webnn":
      return [...webnn, ...gpu, "wasm"];
    case "auto":
    default:
      return [...gpu, "wasm"];
  }
}

/** True for backends that will take minutes per page rather than seconds. */
export function isSlowDevice(device: string): boolean {
  return device === "wasm" || device === "cpu";
}

/**
 * One sentence explaining why the machine ended up on the CPU, aimed at someone
 * who has just been told their conversion will be slow and wants to know if
 * they can do anything about it.
 */
export function slowDeviceReason(probe: DeviceProbe, platform?: "win" | "mac" | "linux"): string {
  const base = probe.webgpu.reason ?? "No compatible GPU was found.";
  if (platform === "linux") {
    return `${base} On Linux, Chromium still hides WebGPU behind a flag — launching Obsidian with --enable-features=Vulkan --enable-unsafe-webgpu may enable it.`;
  }
  return base;
}

function msg(e: unknown): string {
  return String((e as { message?: string })?.message ?? e).slice(0, 160);
}

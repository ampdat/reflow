/**
 * Compute-backend selection, tested against fake navigators.
 *
 * These are the cases the development machine cannot produce: it has WebGPU
 * with `shader-f16` and no WebNN, permanently. Every interesting branch —
 * Windows without a usable adapter, Linux with the feature off, an older iGPU
 * missing f16 shaders, WebNN present — exists only here until someone runs the
 * plugin on other hardware, so the ordering logic is kept pure and injectable
 * precisely so it can be pinned down without that hardware.
 */
import { describe, expect, it } from "vitest";

import {
  deviceCandidates,
  isSlowDevice,
  probeDevices,
  slowDeviceReason,
  type DeviceNavigator,
} from "../src/browser/device.js";
import { dtypeForDevice, FP32_DTYPE, WEBGPU_DTYPE } from "../src/browser/vlm.js";

const gpuNav = (opts: { features?: string[]; adapter?: boolean } = {}): DeviceNavigator => ({
  gpu: {
    requestAdapter: async () =>
      opts.adapter === false
        ? null
        : {
            features: { has: (n: string) => (opts.features ?? ["shader-f16"]).includes(n) },
            info: { vendor: "apple", architecture: "metal-3" },
            limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 31 },
          },
  },
});

describe("probeDevices", () => {
  it("reports no WebGPU when navigator has no gpu at all", async () => {
    const probe = await probeDevices({});
    expect(probe.webgpu.available).toBe(false);
    expect(probe.webgpu.reason).toMatch(/no WebGPU support/i);
    expect(probe.shaderF16).toBe(false);
  });

  it("reports no WebGPU when the adapter request returns null", async () => {
    // Linux without the flag, a blocklisted driver, or a VM with no GPU.
    const probe = await probeDevices(gpuNav({ adapter: false }));
    expect(probe.webgpu.available).toBe(false);
    expect(probe.webgpu.reason).toMatch(/no webgpu adapter/i);
  });

  it("survives an adapter request that throws", async () => {
    const probe = await probeDevices({
      gpu: {
        requestAdapter: async () => {
          throw new Error("device lost");
        },
      },
    });
    expect(probe.webgpu.available).toBe(false);
    expect(probe.webgpu.reason).toContain("device lost");
  });

  it("records adapter facts and shader-f16 when WebGPU is there", async () => {
    const probe = await probeDevices(gpuNav());
    expect(probe.webgpu.available).toBe(true);
    expect(probe.shaderF16).toBe(true);
    expect(probe.webgpu.detail?.vendor).toBe("apple");
  });

  it("notices an adapter without shader-f16", async () => {
    // The older-Intel-iGPU case: WebGPU works, fp16 shaders do not.
    const probe = await probeDevices(gpuNav({ features: [] }));
    expect(probe.webgpu.available).toBe(true);
    expect(probe.shaderF16).toBe(false);
  });

  it("reports WebNN only when a context can actually be created", async () => {
    const withMl = async (ok: string[]) =>
      probeDevices({
        ...gpuNav(),
        ml: {
          createContext: async (o: any) => {
            if (!ok.includes(o.deviceType)) throw new Error("unsupported");
            return {};
          },
        },
      });
    expect((await withMl(["npu", "gpu"])).webnn.available).toBe(true);
    expect((await withMl([])).webnn.available).toBe(false);
    expect((await withMl([])).webnn.reason).toMatch(/no device context/i);
  });
});

describe("deviceCandidates", () => {
  const probeWith = async (nav: DeviceNavigator) => probeDevices(nav);

  it("prefers WebGPU and keeps CPU as the floor", async () => {
    expect(deviceCandidates("auto", await probeWith(gpuNav()))).toEqual(["webgpu", "wasm"]);
  });

  it("falls back to CPU alone when there is no GPU", async () => {
    expect(deviceCandidates("auto", await probeWith(gpuNav({ adapter: false })))).toEqual(["wasm"]);
  });

  it("never offers WebNN automatically, even when it is available", async () => {
    // Obsidian ships without the Chromium feature flag, so an automatic WebNN
    // attempt would fail for everyone who had not opted in by hand.
    const probe = await probeWith({ ...gpuNav(), ml: { createContext: async () => ({}) } });
    expect(probe.webnn.available).toBe(true);
    expect(deviceCandidates("auto", probe)).toEqual(["webgpu", "wasm"]);
  });

  it("puts WebNN first only when explicitly asked, NPU before GPU", async () => {
    const probe = await probeWith({ ...gpuNav(), ml: { createContext: async () => ({}) } });
    expect(deviceCandidates("webnn", probe)).toEqual([
      "webnn-npu",
      "webnn-gpu",
      "webgpu",
      "wasm",
    ]);
  });

  it("honours an explicit CPU choice without a GPU attempt", async () => {
    expect(deviceCandidates("wasm", await probeWith(gpuNav()))).toEqual(["wasm"]);
  });

  it("still falls back when an explicit GPU choice is impossible", async () => {
    expect(deviceCandidates("webgpu", await probeWith(gpuNav({ adapter: false })))).toEqual([
      "wasm",
    ]);
  });
});

describe("dtype selection", () => {
  it("uses the validated fp16 embedding only on WebGPU with shader-f16", () => {
    expect(dtypeForDevice("webgpu", true)).toBe(WEBGPU_DTYPE);
    expect(dtypeForDevice("webgpu", false)).toBe(FP32_DTYPE);
    expect(dtypeForDevice("wasm", true)).toBe(FP32_DTYPE);
    expect(dtypeForDevice("webnn-npu", true)).toBe(FP32_DTYPE);
  });
});

describe("user-facing wording", () => {
  it("marks only the CPU backends slow", () => {
    expect(isSlowDevice("wasm")).toBe(true);
    expect(isSlowDevice("cpu")).toBe(true);
    expect(isSlowDevice("webgpu")).toBe(false);
    expect(isSlowDevice("webnn-npu")).toBe(false);
  });

  it("adds the Chromium flag hint on Linux and nowhere else", async () => {
    const probe = await probeDevices(gpuNav({ adapter: false }));
    expect(slowDeviceReason(probe, "linux")).toMatch(/enable-unsafe-webgpu/);
    expect(slowDeviceReason(probe, "win")).not.toMatch(/enable-unsafe-webgpu/);
    expect(slowDeviceReason(probe, "win")).toMatch(/no webgpu adapter/i);
  });
});

/**
 * Release-build stand-in for plugin/probe.ts.
 *
 * The debug shim hangs an API off `window` and statically imports a second,
 * standalone onnxruntime-web for its ORT smoke test. Users installing from the
 * community directory need neither, and Obsidian's guidelines call out both the
 * global and the dead weight, so esbuild resolves `./probe.js` here unless the
 * build is a `--dev` one (see `stubProbeInRelease` in esbuild.config.mjs).
 *
 * Every export main.ts imports must exist here, with the same shape; the
 * functions are unreachable in a release build but must still type-check.
 */

export function installProbe(_api: Record<string, unknown>): void {
  /* dev-only */
}

export function setOrtWasmPaths(_paths: unknown): void {
  /* dev-only */
}

export async function benchPage(_input: unknown, _opts?: unknown): Promise<never> {
  throw new Error("benchPage is only available in a development build");
}

export async function benchPages(_input: unknown, _opts?: unknown): Promise<never> {
  throw new Error("benchPages is only available in a development build");
}

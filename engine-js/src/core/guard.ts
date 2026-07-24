/**
 * Degenerate-generation guard, shared by the Node (onnxruntime) and browser
 * (WebGPU) VLMs. granite-docling can loop to the token cap on dense/OOD pages;
 * this halts it fast on a repeating token cycle, with a wall-clock backstop.
 *
 * `createGuard` takes the transformers.js `StoppingCriteria` base class as a
 * parameter so it works against either transformers.js version without importing it.
 */

/**
 * True if the tail of `a` is a short cycle repeated ≥3× — the granite-docling
 * degenerate-repetition signature (constant "!", or a looping phrase). Catches
 * period ≤ maxPeriod; longer/irregular runaways fall to the wall-clock backstop.
 */
export function hasShortCycle(a: number[], maxPeriod = 16): boolean {
  const n = a.length;
  for (let p = 1; p <= maxPeriod; p++) {
    if (n < p * 3) continue;
    let ok = true;
    for (let i = 0; i < p * 2; i++) {
      if (a[n - 1 - i] !== a[n - 1 - i - p]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export interface Guard {
  triggered: string | null;
}

/** A StoppingCriteria that halts on repetition or a wall-clock timeout. */
export function createGuard(Base: any, timeoutMs: number, maxPeriod = 16): Guard {
  const start = Date.now();
  const recent: number[] = [];
  const guard = new (class extends Base {
    triggered: string | null = null;
    _call(input_ids: number[][]): boolean[] {
      const ids = input_ids[0] ?? [];
      if (Date.now() - start > timeoutMs) {
        this.triggered ??= "timeout";
        return input_ids.map(() => true);
      }
      recent.push(ids[ids.length - 1] as number);
      if (recent.length > maxPeriod * 3 + 4) recent.shift();
      if (hasShortCycle(recent, maxPeriod)) {
        this.triggered ??= "repetition";
        return input_ids.map(() => true);
      }
      return input_ids.map(() => false);
    }
  })();
  return guard as Guard;
}

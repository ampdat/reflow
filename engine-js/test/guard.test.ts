/**
 * Offline unit tests for the degenerate-generation repetition detector.
 * Models the token-id stream a StoppingCriteria sees each step.
 */
import { describe, expect, it } from "vitest";
import { hasShortCycle } from "../src/vlm.js";

describe("hasShortCycle", () => {
  it("catches a constant token (period 1) — the all-'!' failure", () => {
    expect(hasShortCycle([5, 5, 5, 5, 5])).toBe(true);
  });

  it("catches a repeating multi-token phrase (period 3, ≥3 repeats)", () => {
    expect(hasShortCycle([9, 1, 2, 3, 1, 2, 3, 1, 2, 3])).toBe(true);
  });

  it("catches a longer looping phrase within maxPeriod", () => {
    const block = [11, 12, 13, 14, 15];
    expect(hasShortCycle([...block, ...block, ...block])).toBe(true);
  });

  it("does not fire on normal non-repeating output", () => {
    expect(hasShortCycle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(false);
  });

  it("does not fire on brief legit repetition (only 2 blocks — e.g. table cells)", () => {
    // period 2 repeated twice is not yet degenerate; needs ≥3 to trigger.
    expect(hasShortCycle([7, 8, 7, 8])).toBe(false);
  });

  it("ignores cycles longer than maxPeriod", () => {
    const long = Array.from({ length: 20 }, (_, i) => i);
    expect(hasShortCycle([...long, ...long, ...long], 16)).toBe(false);
  });
});

/**
 * A small deterministic generator (mulberry32).
 *
 * Worlds are generated, not authored, so the same seed has to produce the same
 * world every time: the same starting armies, the same ground held by an
 * insurgency, the same constellation. Math.random cannot promise that.
 */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================================
// SunForce — src/core/rng.ts
// Deterministic pseudo-randomness. `Math.random` appears NOWHERE in this repo.
//
// TWO STREAMS, AND THEY MUST NEVER BE CONFUSED:
//
//   1. THE SIM STREAM.  Its state is one word INSIDE the state buffer
//      (`GlobalView.rngState`, i.e. `GL.rngState`), so it snapshots, rolls back
//      and hashes with everything else. Use the `simRandom*` free functions;
//      they take any object with a mutable `rngState`, and `GlobalView`
//      satisfies that structurally with no adapter. A sim roll that reads a
//      generator living outside the buffer desynchronises on the first rollback
//      and the determinism test will not tell you where.
//
//   2. COSMETIC / OFF-SIM STREAMS.  Sparks, dust, crowd bob, and the CPU
//      dummy's own seeded stream (`DummySourceOpts.seed`). These use `Rng`
//      instances that are NOT part of the state buffer. A cosmetic roll must
//      never feed back into the simulation.
//
// Algorithm: xorshift32 (Marsaglia). Period 2^32-1, passes what we need it to,
// four int32 ops, no multiply in the step, and identical on every JS engine
// because every operand stays inside int32. `>>>` here is an RNG bit mix, NOT
// fixed-point arithmetic — the "never use a shift" rule in core/fixed.ts is
// about FX rounding and does not apply.
// =============================================================================

import type { GlobalView } from '@/core/contracts';

/** Anything carrying a mutable rng word. `GlobalView` satisfies it structurally. */
export interface RngState {
  rngState: number;
}

/** The raw step. Pure: state in, next state out. Never returns 0 unless fed 0. */
export const xorshift32 = (x: number): number => {
  let v = x | 0;
  v ^= v << 13;
  v ^= v >>> 17;
  v ^= v << 5;
  return v | 0;
};

/**
 * Normalises any seed (including 0, which is xorshift32's fixed point and would
 * make the generator emit zeroes forever) into a well-mixed non-zero state.
 * The two multiplies are the splitmix32 finaliser: `Math.imul` is exactly the
 * right tool here because we WANT 32-bit wraparound. That is the opposite of
 * fixed-point math, where `Math.imul` silently truncates a product we need in
 * full — see the note in core/fixed.ts.
 */
export const seedFrom = (seed: number): number => {
  let x = seed | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = (x ^ (x >>> 16)) | 0;
  return x === 0 ? 0x9e3779b9 | 0 : x;
};

// -----------------------------------------------------------------------------
// THE SIM STREAM — state lives in the buffer, so it rolls back for free.
// -----------------------------------------------------------------------------

/** Advances the sim stream and returns the raw value as a uint32 (0 .. 2^32-1). */
export const simRandom = (h: RngState): number => {
  const s = xorshift32(h.rngState);
  h.rngState = s;
  return s >>> 0;
};

/**
 * Uniform-ish integer in [0, n). Returns 0 for n <= 0.
 * There is a modulo bias of at most 1 part in 2^32/n, which for every n this
 * game will ever use (dummy decisions, spark counts) is unobservable, and the
 * alternative — rejection sampling — consumes a variable number of rolls and so
 * makes the stream position depend on the values drawn. A fixed cost per roll
 * is worth far more to us than perfect uniformity.
 */
export const simRandomBelow = (h: RngState, n: number): number =>
  n <= 0 ? 0 : (simRandom(h) % n) | 0;

/** Uniform-ish integer in [lo, hi], inclusive both ends. */
export const simRandomRange = (h: RngState, lo: number, hi: number): number =>
  hi <= lo ? lo : lo + simRandomBelow(h, hi - lo + 1);

/** True `pct` percent of the time. pct <= 0 never, pct >= 100 always. */
export const simRandomChance = (h: RngState, pct: number): boolean =>
  pct > 0 && (pct >= 100 || simRandomBelow(h, 100) < pct);

/** +1 or -1. */
export const simRandomSign = (h: RngState): 1 | -1 => ((simRandom(h) & 1) === 0 ? 1 : -1);

/** Re-seeds the sim stream. Call ONLY from createState / a match reset. */
export const simReseed = (g: GlobalView, seed: number): void => {
  g.seed = seed | 0;
  g.rngState = seedFrom(seed);
};

// -----------------------------------------------------------------------------
// OFF-SIM STREAMS — cosmetics and the CPU dummy.
// -----------------------------------------------------------------------------

/**
 * A self-contained xorshift32 stream. Deterministic given its seed, but its
 * state is NOT in the state buffer, so it does not roll back. That is correct
 * for sparks and for the dummy (whose inputs are recorded into the replay like
 * a human's), and wrong for anything the simulation branches on.
 */
export class Rng implements RngState {
  rngState: number;

  constructor(seed: number) {
    this.rngState = seedFrom(seed);
  }

  reseed(seed: number): void {
    this.rngState = seedFrom(seed);
  }

  /** Raw uint32. */
  next(): number {
    return simRandom(this);
  }

  below(n: number): number {
    return simRandomBelow(this, n);
  }

  range(lo: number, hi: number): number {
    return simRandomRange(this, lo, hi);
  }

  chance(pct: number): boolean {
    return simRandomChance(this, pct);
  }

  sign(): 1 | -1 {
    return simRandomSign(this);
  }

  /** [0, 1). PRESENTATION ONLY — a float has no business in the simulation. */
  float(): number {
    return this.next() / 4294967296;
  }
}

/** Alias for the presentation side, so `src/gfx/fx.ts` reads honestly. */
export const CosmeticRng = Rng;
export type CosmeticRng = Rng;

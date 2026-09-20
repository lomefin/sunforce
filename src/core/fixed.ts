// =============================================================================
// SunForce — src/core/fixed.ts
// Fixed-point scalar math. ONE = 256 FX units per world unit.
//
// This is the deepest leaf of the dependency graph: it imports the contract and
// NOTHING else — not even the assert helper. A branch inside fxMul is a branch
// inside every hitbox test, every integration step and every knockback decay.
//
// Every function here is total, allocation-free and monomorphic (all params are
// SMIs), so V8 keeps them inlined.
// =============================================================================

import { ONE } from '@/core/contracts';
import type { FX, FixedMath } from '@/core/contracts';

// -----------------------------------------------------------------------------
// WHY `((a * b) / 256) | 0` AND NOTHING ELSE. Read this before you "optimise".
// -----------------------------------------------------------------------------
//
// 1. WHY NOT `Math.imul(a, b) / 256 | 0`
//    `Math.imul` computes the C-like 32-bit product: it truncates the result to
//    int32 BEFORE we get a chance to divide by 256. Our operands routinely
//    overflow that: posX maxes at 3600 * 256 = 921_600 (~2^19.8) and a scalar
//    such as a walk speed or a knockback impulse runs to ~2^16, so the true
//    product reaches ~2^36. `Math.imul` silently wraps it modulo 2^32 and the
//    fighter teleports. Plain `*` is EXACT here: IEEE-754 doubles represent
//    every integer below 2^53 exactly, and 2^36 < 2^53 with 17 bits of headroom,
//    so `(a * b)` is exact on every conforming engine and `/ 256 | 0` is exact
//    too. This is a proof, not a hope.
//
// 2. WHY NOT `(a * b) >> 8`
//    `>>` FLOORS (rounds toward negative infinity); `| 0` TRUNCATES (rounds
//    toward zero). For our sim those differ by exactly one unit on every
//    negative non-multiple of 256, and that one unit is the entire "that combo
//    only works on P1 side" bug class.
//
//    Measured, with the locked KNOCKBACK_DECAY_PCT = 88:
//        kbX = +1179 -> trunc +1036   |   kbX = -1179 -> trunc -1036   SYMMETRIC
//        kbX = +1179 ->  >>8  +1036   |   kbX = -1179 ->  >>8  -1037   ASYMMETRIC
//    Leftward knockback would decay one unit further per frame than rightward.
//    Over a 21-frame hitstun that compounds into different spacing on the two
//    sides of the screen, so a combo that connects on P1's side drops on P2's.
//    `trunc(-x) === -trunc(x)` is THE reason mirror symmetry holds, and
//    tests/mirror.test.ts exists to catch anyone who swaps it back.
//
//    The same applies to `/ 100 | 0` in fxPct and to `fx()` below. There is no
//    shift anywhere in this file, deliberately.
// -----------------------------------------------------------------------------

/**
 * World units (fractional allowed) -> FX. AUTHORING AND COMPILE TIME ONLY —
 * `src/sim/**` must never call this, because its input is a float.
 *
 * Truncates toward zero, so `fx(-v) === -fx(v)` and a mirrored data set
 * compiles to the exact negation of the original. Examples:
 *   fx(1)   = 256     fx(4.0)  = 1024    fx(0.5)  = 128
 *   fx(4.6) = 1177    fx(0.84) =  215    fx(24.2) = 6195
 */
export const fx = (units: number): FX => (units * ONE) | 0;

/**
 * FX -> float world units. PRESENTATION ONLY. If this appears anywhere under
 * `src/sim/` the simulation has left the integers and determinism is gone.
 */
export const px = (v: FX): number => v / ONE;

/** ((a*b)/ONE)|0 — exact over the whole operand range, mirror-safe. */
export const fxMul = (a: FX, b: FX): FX => ((a * b) / ONE) | 0;

/**
 * ((a*ONE)/b)|0 — mirror-safe. `b` must be non-zero; with b === 0 the
 * intermediate is +-Infinity and `| 0` yields 0 rather than throwing, which is
 * deterministic but certainly not what the caller meant.
 */
export const fxDiv = (a: FX, b: FX): FX => ((a * ONE) / b) | 0;

export const fxAbs = (a: FX): FX => (a < 0 ? -a : a);

export const fxSign = (a: FX): -1 | 0 | 1 => (a > 0 ? 1 : a < 0 ? -1 : 0);

/** Clamps into [lo, hi]. Caller guarantees lo <= hi. */
export const fxClamp = (v: FX, lo: FX, hi: FX): FX => (v < lo ? lo : v > hi ? hi : v);

/**
 * ((v*pct)/100)|0 — percentage scaling, mirror-safe for the same reason fxMul
 * is. This is the knockback decay, the weight scaling and the damage/stun
 * proration path, i.e. three of the four places side parity could be lost.
 */
export const fxPct = (v: FX, pct: number): FX => ((v * pct) / 100) | 0;

/**
 * The frozen `FixedMath` interface, realised. Its only job is to make the
 * COMPILER prove that every signature above still matches the contract — if a
 * parameter or return type drifts, this line fails to typecheck instead of the
 * sim quietly changing behaviour. It is also a convenient single import for
 * tests. Hot paths should import the free functions, not these properties.
 */
export const FX_MATH: FixedMath = { fx, px, fxMul, fxDiv, fxAbs, fxSign, fxClamp, fxPct };

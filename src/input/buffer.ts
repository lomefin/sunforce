// =============================================================================
// SunForce — src/input/buffer.ts
// INPUT POLICY. core/ring.ts owns masking and indexing; this file owns the
// decisions layered on top of it:
//
//   1. THE STICKY LATCH.   A DOM keydown/keyup pair that both land inside one
//      16.6 ms tick would otherwise be invisible to the simulation. The latch
//      samples on the DOM EVENT and is consumed on the SIM TICK, so a 4 ms tap
//      is reported for exactly one frame and never lost. (`StickyLatch` lives
//      here, not in sources.ts, because the gamepad and replay sources want the
//      same behaviour and because it is the piece worth testing in isolation.)
//
//   2. THE THROW MACRO.    `B.THROW` is not a key. It is P and K pressed within
//      `THROW_MACRO_SLOP` frames of each other, OR'd into the held mask of the
//      frame the coincidence completes, so an edge is derived for it exactly
//      like any other button.
//
//   3. FACING-RELATIVE READS. Directions are stored ABSOLUTE and flipped HERE,
//      at read time. A replay therefore survives a side swap: re-running the
//      same absolute stream after the fighters cross produces the correct
//      forward/back for the new sides, where a stream of pre-converted
//      "forward" bits would produce garbage.
//
//   4. BUFFERED QUERIES.   `bufferedPress` -> `consumePress` is the pair the
//      transition ladder uses. Nothing else may retire a press.
//
// EDGES ARE NEVER STORED. They are `held[f] & ~held[f-1]`, recomputed from data
// that itself rolls back. A stored edge bit is a rollback desync waiting to
// happen (ENGINE-DECISIONS §7).
// =============================================================================

import { B, INPUT_LENIENCY, THROW_MACRO_SLOP } from '@/core/contracts';
import type { ButtonMask, Facing, PlayerIx, StateBuf } from '@/core/contracts';
import {
  ringConsume, ringFindPress, ringFreshPress, ringHeld, ringIsHeld, ringPressEdge,
  ringReleaseEdge, ringWord, ringWrite,
} from '@/core/ring';

// -----------------------------------------------------------------------------
// 1. THE STICKY LATCH
// -----------------------------------------------------------------------------

/**
 * `live | sticky`, sampled once per sim frame.
 *
 *   live   — what is physically down right now, maintained by DOM events.
 *   sticky — every bit that went down since the last sample, whether or not it
 *            is still down.
 *
 * `sample()` returns the union and clears `sticky` only. A key still held stays
 * reported through `live`; a key tapped and released between two ticks is
 * reported for exactly one frame and then gone — which is precisely a one-frame
 * press edge to `ringPressEdge`.
 */
export class StickyLatch {
  private live: ButtonMask = 0;
  private sticky: ButtonMask = 0;

  /** A bit (or several) went down. */
  down(bits: ButtonMask): void {
    this.live |= bits;
    this.sticky |= bits;
  }

  /** A bit went up. The sticky copy survives until the next sample. */
  up(bits: ButtonMask): void {
    this.live &= ~bits;
  }

  /** Wholesale replacement, for polled devices (gamepads) that have no events. */
  setLive(mask: ButtonMask): void {
    this.sticky |= mask & ~this.live;
    this.live = mask;
  }

  /** What is physically down, without consuming the sticky bits. */
  peekLive(): ButtonMask {
    return this.live;
  }

  /** One sim frame's worth of input. Consumes the sticky bits. */
  sample(): ButtonMask {
    const m = this.live | this.sticky;
    this.sticky = 0;
    return m;
  }

  /**
   * Window blur / focus loss: nothing is physically down any more, because the
   * browser will not deliver the keyup. The sticky bits are KEPT so a tap that
   * happened just before the blur still reaches the sim on the next tick.
   */
  releaseAll(): void {
    this.live = 0;
  }

  /** Hard reset — match restart, device swap, test setup. */
  reset(): void {
    this.live = 0;
    this.sticky = 0;
  }
}

// -----------------------------------------------------------------------------
// 2. WRITING A FRAME INTO THE RING
// -----------------------------------------------------------------------------

/** |x| without `Math`, so this file reads the same as the sim's arithmetic. */
const absInt = (v: number): number => (v < 0 ? -v : v);

/**
 * Synthesises `B.THROW` into `frame`'s held mask when P and K were pressed
 * within `slop` frames of each other and both are still held.
 *
 * Both presses must be UNCONSUMED: a P that already came out as a jab is spent,
 * and pressing K afterwards must not retroactively become a throw.
 *
 * Returns true if the bit was set. Setting it on every frame the coincidence
 * still holds is intentional — the derived press edge fires once, on the first
 * of them, and the following frames simply keep `B.THROW` held for the
 * transition ladder to read.
 */
export const synthesizeThrowMacro = (
  buf: StateBuf, p: PlayerIx, frame: number, slop: number = THROW_MACRO_SLOP,
): boolean => {
  const held = ringHeld(buf, p, frame);
  if ((held & (B.P | B.K)) !== (B.P | B.K)) return false;

  const pf = ringFindPress(buf, p, frame, B.P, slop);
  if (pf < 0) return false;
  const kf = ringFindPress(buf, p, frame, B.K, slop);
  if (kf < 0) return false;
  if (absInt(pf - kf) > slop) return false;

  const i = ringWord(p, frame);
  buf[i] = buf[i]! | B.THROW;
  return true;
};

/**
 * PHASE 1 of the frame order, for one player: publish this frame's held mask
 * and synthesise the throw macro on top of it.
 *
 * Must run for BOTH players EVERY frame, including through hitstop, and BEFORE
 * any read of the ring for that frame — `ringWrite` clears the slot's consumed
 * bits, so a read that precedes it would see the previous lap's leftovers.
 *
 * `src/sim/step.ts` may call `ringWrite` directly instead; the only thing it
 * loses is `B.THROW`, which M0 does not use.
 */
export const writeInput = (
  buf: StateBuf, p: PlayerIx, frame: number, held: ButtonMask,
): void => {
  ringWrite(buf, p, frame, held);
  synthesizeThrowMacro(buf, p, frame);
};

/** Both players in one call, in slot order. */
export const writeInputs = (
  buf: StateBuf, frame: number, in0: ButtonMask, in1: ButtonMask,
): void => {
  writeInput(buf, 0, frame, in0);
  writeInput(buf, 1, frame, in1);
};

// -----------------------------------------------------------------------------
// 3. FACING-RELATIVE CONVERSION
//
// In facing-relative space `B.R` means FORWARD and `B.L` means BACK, because
// the sim's +x is forward for a fighter whose `facing` is +1. Converting is one
// conditional swap of two bits and it happens at READ time, never at write
// time.
// -----------------------------------------------------------------------------

/** In a facing-relative mask, the bit that means "towards the opponent". */
export const REL_FWD: ButtonMask = B.R;
/** ...and the bit that means "away", i.e. the block direction. */
export const REL_BACK: ButtonMask = B.L;

const swapLR = (mask: ButtonMask): ButtonMask => {
  let m = mask & ~(B.L | B.R);
  if ((mask & B.L) !== 0) m |= B.R;
  if ((mask & B.R) !== 0) m |= B.L;
  return m;
};

/** Absolute mask -> facing-relative mask. Identity when facing right. */
export const toFacingRelative = (mask: ButtonMask, facing: Facing): ButtonMask =>
  facing === 1 ? mask : swapLR(mask);

/** Facing-relative mask -> absolute mask. The same involution. */
export const toAbsolute = (mask: ButtonMask, facing: Facing): ButtonMask =>
  facing === 1 ? mask : swapLR(mask);

/** The ABSOLUTE bit that is "forward" for this facing. */
export const forwardBit = (facing: Facing): ButtonMask => (facing === 1 ? B.R : B.L);
/** The ABSOLUTE bit that is "back" — the block direction. */
export const backBit = (facing: Facing): ButtonMask => (facing === 1 ? B.L : B.R);

export const holdingForward = (mask: ButtonMask, facing: Facing): boolean =>
  (mask & forwardBit(facing)) !== 0;

export const holdingBack = (mask: ButtonMask, facing: Facing): boolean =>
  (mask & backBit(facing)) !== 0;

export const holdingDown = (mask: ButtonMask): boolean => (mask & B.D) !== 0;
export const holdingUp = (mask: ButtonMask): boolean => (mask & B.U) !== 0;

/** This frame's held mask, already flipped for `facing`. */
export const heldRelative = (
  buf: StateBuf, p: PlayerIx, frame: number, facing: Facing,
): ButtonMask => toFacingRelative(ringHeld(buf, p, frame), facing);

/**
 * The single directional "notation number" a move's `input.dir` compares
 * against: 0 none, 2 down, 4 back, 6 forward. Down wins over horizontal,
 * matching how `2K` is selected while walking.
 */
export const dirNotation = (mask: ButtonMask, facing: Facing): 0 | 2 | 4 | 6 => {
  if ((mask & B.D) !== 0) return 2;
  if (holdingForward(mask, facing)) return 6;
  if (holdingBack(mask, facing)) return 4;
  return 0;
};

// -----------------------------------------------------------------------------
// 4. BUFFERED QUERIES — the read half of the contract with sim/fighter.ts
// -----------------------------------------------------------------------------

/** Buttons held on `frame`, absolute. */
export const held = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  ringHeld(buf, p, frame);

/** True if every bit of `bits` is held on `frame`. */
export const isHeld = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask,
): boolean => ringIsHeld(buf, p, frame, bits);

/** Buttons that went down ON `frame`, spent or not. */
export const pressedOn = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  ringPressEdge(buf, p, frame);

/** Buttons that went up ON `frame` — the negative-edge moves read this. */
export const releasedOn = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  ringReleaseEdge(buf, p, frame);

/** Unspent press of `bits` exactly on `frame`. */
export const freshPressOn = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask,
): ButtonMask => ringFreshPress(buf, p, frame, bits);

/**
 * The newest unconsumed press of any of `bits` within the leniency window, as a
 * FRAME NUMBER, or -1. Pass that frame straight back to `consumePress` once the
 * press has actually produced a move — the pair is what keeps one press from
 * firing two moves while leaving a genuinely new press six frames later live.
 */
export const bufferedPress = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask,
  leniency: number = INPUT_LENIENCY,
): number => ringFindPress(buf, p, frame, bits, leniency);

/** Retires the press `bufferedPress` found. */
export const consumePress = (
  buf: StateBuf, p: PlayerIx, pressFrame: number, bits: ButtonMask,
): void => ringConsume(buf, p, pressFrame, bits);

/** Convenience: find, consume, report. Returns true if a press was spent. */
export const takeBufferedPress = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask,
  leniency: number = INPUT_LENIENCY,
): boolean => {
  const f = ringFindPress(buf, p, frame, bits, leniency);
  if (f < 0) return false;
  ringConsume(buf, p, f, bits);
  return true;
};

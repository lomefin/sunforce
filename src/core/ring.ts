// =============================================================================
// SunForce — src/core/ring.ts
// The input ring primitive, plus the one generic wrap helper the event ring
// needs. Zero allocation: everything is an index computation over the state
// buffer that `src/sim/state.ts` already owns.
//
// LAYOUT (frozen in contracts.ts)
//   word index  = OFF_RING + player * INPUT_RING_FRAMES + (frame & 63)
//   low  16 bits = HELD mask for that frame          (RING_HELD_MASK)
//   high 16 bits = CONSUMED mask for that frame slot (RING_CONSUMED_SHIFT)
//
// WHY CONSUMED BITS ARE PER FRAME SLOT AND NOT PER BUTTON
//   A global "this button has been used" mask plus 6 frames of input leniency
//   means a jab that consumed P at frame 10 also eats a genuinely NEW P press
//   at frame 15 — the player mashes and the second jab never comes out. Marking
//   the SLOT consumed retires exactly one press and leaves every later press
//   live, at zero extra memory.
//
// WHY EDGES ARE DERIVED AND NEVER STORED
//   A stored "pressed this frame" bit goes stale the moment a rollback
//   resimulates that frame from a different predecessor. `held[f] & ~held[f-1]`
//   is recomputed from data that itself rolled back, so it is always right.
//   Frame 0 reads slot 63 of a zeroed buffer, which reads as "nothing held last
//   frame" — exactly the answer we want on the first frame.
//
// This module does MASKING AND INDEXING ONLY. Policy — the sticky latch, the
// THROW macro synthesis, which buffered query a move uses — belongs to
// src/input/buffer.ts, which is built on top of these.
// =============================================================================

import {
  INPUT_RING_FRAMES, OFF_RING, RING_CONSUMED_SHIFT, RING_HELD_MASK,
} from '@/core/contracts';
import type { ButtonMask, PlayerIx, StateBuf } from '@/core/contracts';
import { assert } from '@/core/assert';

/** INPUT_RING_FRAMES is a power of two, so `frame & RING_MASK` is the wrap. */
export const RING_MASK = INPUT_RING_FRAMES - 1;

assert(
  (INPUT_RING_FRAMES & RING_MASK) === 0 && INPUT_RING_FRAMES > 1,
  `core/ring: INPUT_RING_FRAMES (${INPUT_RING_FRAMES}) must be a power of two`,
);

/**
 * Wrap for rings whose capacity is NOT a power of two (the 48-slot event ring).
 * Handles negative i, which `%` alone does not.
 */
export const wrapIndex = (i: number, cap: number): number => {
  const m = i % cap;
  return m < 0 ? m + cap : m;
};

/** Slot a frame occupies. Correct for negative frames: -1 & 63 === 63. */
export const ringSlot = (frame: number): number => frame & RING_MASK;

/** Absolute word index of one player's slot for one frame. */
export const ringWord = (p: PlayerIx, frame: number): number =>
  OFF_RING + p * INPUT_RING_FRAMES + (frame & RING_MASK);

/**
 * Publishes the held mask for `frame` and clears that slot's consumed bits.
 * Called exactly once per player per frame, in phase 1 of the frame order,
 * ALWAYS — including while that fighter is in hitstop, which is what lets a
 * player buffer a confirm through the freeze.
 */
export const ringWrite = (buf: StateBuf, p: PlayerIx, frame: number, held: ButtonMask): void => {
  buf[ringWord(p, frame)] = held & RING_HELD_MASK;
};

/** Buttons held on `frame`. */
export const ringHeld = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  buf[ringWord(p, frame)]! & RING_HELD_MASK;

/** Buttons already spent on `frame`'s press. */
export const ringConsumed = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  (buf[ringWord(p, frame)]! >>> RING_CONSUMED_SHIFT) & RING_HELD_MASK;

/** Retires `bits` of `frame`'s press so nothing else can act on the same press. */
export const ringConsume = (buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask): void => {
  const i = ringWord(p, frame);
  buf[i] = buf[i]! | ((bits & RING_HELD_MASK) << RING_CONSUMED_SHIFT);
};

/** Buttons that went down ON `frame`: held now and not held the frame before. */
export const ringPressEdge = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  ringHeld(buf, p, frame) & ~ringHeld(buf, p, frame - 1);

/** Buttons that went up ON `frame`. Needed for negative-edge moves. */
export const ringReleaseEdge = (buf: StateBuf, p: PlayerIx, frame: number): ButtonMask =>
  ringHeld(buf, p, frame - 1) & ~ringHeld(buf, p, frame);

/** Fresh, unspent press of any of `bits` exactly on `frame`. */
export const ringFreshPress = (buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask): ButtonMask =>
  ringPressEdge(buf, p, frame) & bits & ~ringConsumed(buf, p, frame);

/**
 * Scans back at most `leniency` frames (INPUT_LENIENCY) for the NEWEST frame
 * carrying an unconsumed press of any of `bits`, and returns that frame, or -1.
 *
 * Newest-first is deliberate: with a 6-frame window a player who taps P twice
 * quickly should get the second press honoured on the frame the move becomes
 * available, not the stale first one. The caller retires what it used with
 * `ringConsume(buf, p, <returned frame>, bits)`.
 */
export const ringFindPress = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask, leniency: number,
): number => {
  // Never look further back than the ring holds, and never before frame 0.
  // The cap is INPUT_RING_FRAMES - 2, not - 1: the oldest frame examined also
  // reads ITS predecessor to derive an edge, and at a span of 63 that
  // predecessor aliases onto `frame`'s own slot — the scan would compare the
  // oldest press against the newest frame's held mask. Real leniency is 6.
  const maxSpan = INPUT_RING_FRAMES - 2;
  const span = leniency < maxSpan ? leniency : maxSpan;
  const oldest = frame - span > 0 ? frame - span : 0;
  for (let f = frame; f >= oldest; f--) {
    if (ringFreshPress(buf, p, f, bits) !== 0) return f;
  }
  return -1;
};

/** True if any of `bits` is held on `frame`. Directions use this, not edges. */
export const ringIsHeld = (buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask): boolean =>
  (ringHeld(buf, p, frame) & bits) !== 0;

/**
 * Frames (up to `limit`) that `bits` have been held continuously ending at
 * `frame`. The charge recogniser is built on this.
 */
export const ringHeldFor = (
  buf: StateBuf, p: PlayerIx, frame: number, bits: ButtonMask, limit: number,
): number => {
  const span = limit < RING_MASK ? limit : RING_MASK;
  let n = 0;
  for (let f = frame; f > frame - span && f >= 0; f--) {
    if ((ringHeld(buf, p, f) & bits) !== bits) break;
    n++;
  }
  return n;
};

/** Zeroes one player's whole ring. Used by a match reset, never mid-round. */
export const ringClear = (buf: StateBuf, p: PlayerIx): void => {
  const base = OFF_RING + p * INPUT_RING_FRAMES;
  buf.fill(0, base, base + INPUT_RING_FRAMES);
};

// =============================================================================
// SunForce — src/input/dummy.ts
// THE TRAINING DUMMY. An `InputSource` like any other, so the fight scene never
// learns whether player 2 is a human, a pad, a replay or this.
//
// M0 USES `DummyMode.STAND` AND NOTHING ELSE (M0 doc §11). The other modes are
// written out in full rather than stubbed because they are the collision and
// hit-resolution harness: "hold back forever" is how blockstun gets exercised,
// "poke on a timer" is how trades and counter-hits get exercised, and neither
// costs anything to carry.
//
// DETERMINISM
//   The dummy's randomness comes from its OWN `Rng`, seeded from
//   `DummySourceOpts.seed`. That stream is NOT in the state buffer and MUST NOT
//   be: the dummy is an input DEVICE, and its output is recorded into a replay
//   exactly like a human's key presses. Feeding a sim roll from here would make
//   the dummy's decisions roll back while the recorded inputs did not — the
//   worst possible desync, because it only shows up after a rollback.
//   Consequence, stated plainly: the stream advances once per `poll`, so a
//   replay reproduces a dummy match only when the dummy is polled once per
//   frame from frame 0 — which is exactly how the loop drives it.
//
// FACING
//   `poll` must return ABSOLUTE directions, but "block" means "hold BACK", and
//   back depends on which side the dummy stands on. The scene tells it with
//   `setFacing` (cheap, and the only coupling to the sim there is). It defaults
//   to -1, because the dummy is player 2 and player 2 starts on the right.
// =============================================================================

import { B, DummyMode } from '@/core/contracts';
import type { ButtonMask, DummySourceOpts, Facing, InputSource } from '@/core/contracts';
import { never } from '@/core/assert';
import { Rng } from '@/core/rng';
import { REL_BACK, REL_FWD, backBit, toAbsolute } from '@/input/buffer';

/** The M0 wiring: a dummy that stands there and gets hit. */
export const DUMMY_STAND: DummySourceOpts = {
  mode: DummyMode.STAND,
  seed: 0x5EED0001 | 0,
  aggression: 0,
};

/** Frames of the JUMP cycle, and how long `U` is held inside it. */
const JUMP_PERIOD = 48;
const JUMP_HOLD = 3;

const clampPct = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v | 0);

export class DummySource implements InputSource {
  private readonly mode: DummyMode;
  private readonly aggression: number;
  private readonly rng: Rng;
  private facing: Facing;

  /** Frames left of the current scripted burst, and what it holds (RELATIVE). */
  private burstFrames = 0;
  private burstRel: ButtonMask = 0;
  /** Frames of forced neutral after a burst. */
  private cooldown = 0;
  /** RECORD_PLAYBACK tape. Empty = neutral, which is a legal recording. */
  private tape: readonly number[] = [];

  constructor(opts: DummySourceOpts = DUMMY_STAND, facing: Facing = -1) {
    this.mode = opts.mode;
    this.aggression = clampPct(opts.aggression);
    this.rng = new Rng(opts.seed);
    this.facing = facing;
  }

  /** Which way the dummy faces, so "back" is the correct absolute direction. */
  setFacing(f: Facing): void {
    this.facing = f;
  }

  facingOf(): Facing {
    return this.facing;
  }

  /** Supplies the RECORD_PLAYBACK tape: one absolute mask per frame. */
  setTape(masks: readonly number[]): void {
    this.tape = masks;
  }

  poll(frame: number): ButtonMask {
    switch (this.mode) {
      case DummyMode.STAND:
        return 0;

      case DummyMode.BLOCK_ALL:
        return backBit(this.facing);

      case DummyMode.CROUCH_BLOCK:
        return backBit(this.facing) | B.D;

      case DummyMode.JUMP:
        // Pure function of the frame: no rng, so it is trivially reproducible
        // and makes an obvious anti-air target.
        return frame >= 0 && frame % JUMP_PERIOD < JUMP_HOLD ? B.U : 0;

      case DummyMode.RANDOM_POKE:
        return this.tickPoke();

      case DummyMode.CPU_BASIC:
        return this.tickCpu();

      case DummyMode.RECORD_PLAYBACK:
        return frame >= 0 && frame < this.tape.length ? this.tape[frame]! : 0;

      default:
        return never(this.mode, 'input/dummy: mode');
    }
  }

  dispose(): void {
    // No listeners, no timers, no buffer: the dummy owns nothing but its rng.
  }

  /** Buttons only, on a random cadence. Exercises hitstop, trades and blockstun. */
  private tickPoke(): ButtonMask {
    if (this.burstFrames > 0) {
      this.burstFrames--;
      return toAbsolute(this.burstRel, this.facing);
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return 0;
    }
    this.cooldown = this.rng.range(10, 28);
    const chance = this.aggression > 0 ? this.aggression : 60;
    if (!this.rng.chance(chance)) {
      this.burstRel = 0;
      return 0;
    }
    this.burstRel = this.rng.chance(50) ? B.P : B.K;
    this.burstFrames = 1;          // this frame plus one more: a 2-frame tap
    return toAbsolute(this.burstRel, this.facing);
  }

  /**
   * Walk in, poke, back off, wait — weighted by `aggression`. Deliberately not
   * reactive: reacting needs the sim state, and an input DEVICE that reads sim
   * state is how a dummy ends up cheating and how replays stop reproducing.
   */
  private tickCpu(): ButtonMask {
    if (this.burstFrames > 0) {
      this.burstFrames--;
      return toAbsolute(this.burstRel, this.facing);
    }

    const agg = this.aggression;
    const roll = this.rng.below(100);
    const approach = agg >> 1;                 // aggression/2 of the time: close in
    const poke = agg;                          // ...to aggression: press a button
    const guard = agg + ((100 - agg) >> 1);    // ...then mostly hold back

    if (roll < approach) {
      this.burstRel = REL_FWD;
      this.burstFrames = this.rng.range(6, 14);
    } else if (roll < poke) {
      this.burstRel = this.rng.chance(50) ? B.P : B.K;
      this.burstFrames = 1;
    } else if (roll < guard) {
      this.burstRel = REL_BACK;
      this.burstFrames = this.rng.range(8, 20);
    } else {
      this.burstRel = 0;
      this.burstFrames = this.rng.range(6, 18);
    }
    return toAbsolute(this.burstRel, this.facing);
  }
}

/** The one line M0's fight scene needs for player 2. */
export const standingDummy = (facing: Facing = -1): DummySource =>
  new DummySource(DUMMY_STAND, facing);

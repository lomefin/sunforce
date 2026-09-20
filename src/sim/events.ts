// =============================================================================
// SunForce — src/sim/events.ts
// THE ONLY sim -> presentation channel, and it lives INSIDE the state buffer.
//
// WHY IN THE BUFFER
// A callback fired from inside the simulation cannot be rolled back: the spark
// is already on screen and the sound is already in the speakers when the frame
// turns out to have been mispredicted. So the sim never calls presentation. It
// APPENDS to a 48-slot ring in the state buffer, the ring snapshots, rolls back
// and hashes with everything else, and presentation DRAINS it afterwards behind
// the `g.confirmedFrame` watermark.
//
// SLOT LAYOUT — EVENT_WORDS_EACH = 6 words, and all six are spoken for:
//   w0  frame        the sim frame the event was emitted on (the watermark key)
//   w1  type | actor low 16 = Ev, high 16 = actor/attacker player index
//   w2  b            damage | sfx << 16  (see packB / eventDamage / eventSfx)
//   w3  worldX       FX
//   w4  worldY       FX
//   w5  extra        packed spark / shakeAmp / shakeFrames / chroma
//
// THE TWO WATERMARKS, AND WHY A CONSUMER CAN NEVER MISS OR DOUBLE-READ
//   1. SEQUENCE. `g.eventCount` is monotonic within a round: it counts every
//      event ever appended, not the 48 currently resident. So an event's
//      sequence number is `eventCount - count + i`, an `EventDrain` remembers
//      the first sequence it has NOT consumed, and the arithmetic proves both
//      directions: re-delivering is impossible (the cursor only moves forward)
//      and a silent loss is detectable (the cursor falling behind the oldest
//      resident sequence means the ring wrapped over undrained events).
//   2. FRAME. A drain stops at `upToFrame`, which callers pass as
//      `g.confirmedFrame`. Frames at or before the confirmed frame are never
//      resimulated, so an event delivered from one can never be re-emitted with
//      different contents. Together: no misses, no doubles, no rollback leaks.
//
// ZERO ALLOCATION ON THE SIM SIDE. `pushEvent` is six integer stores and two
// counter updates. The reader objects are presentation-side and are cached per
// SimState, so draining allocates nothing either.
// =============================================================================

import { EVENT_CAP, EVENT_WORDS_EACH, OFF_EVENTS } from '@/core/contracts';
import type {
  DrainEventsFn, Ev, EventRing, EventsFn, FX, SfxId, SimState, SparkId, StateBuf,
} from '@/core/contracts';
import { wrapIndex } from '@/core/ring';

// -----------------------------------------------------------------------------
// Word offsets within one slot.
// -----------------------------------------------------------------------------
const EW_FRAME = 0;
const EW_TYPE = 1;
const EW_B = 2;
const EW_X = 3;
const EW_Y = 4;
const EW_EXTRA = 5;

const LOW16 = 0xffff;
const LOW8 = 0xff;

/** Byte-wide clamp, so a packed field can never bleed into its neighbour. */
const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : v | 0);

// -----------------------------------------------------------------------------
// PACKING HELPERS
//
// `b` carries two things because the contract gives it one word and both the
// HUD (damage) and the audio bus (which sound) read the same event. damage is
// <= 1000 so it fits in 16 bits with room to spare; SfxId is a small enum.
// -----------------------------------------------------------------------------

/** damage in the low 16 bits, SfxId in the high 16. */
export const packB = (damage: number, sfx: SfxId): number =>
  ((damage & LOW16) | ((sfx & LOW16) << 16)) | 0;

export const eventDamage = (b: number): number => b & LOW16;
export const eventSfx = (b: number): SfxId => ((b >>> 16) & LOW16) as SfxId;

/** bits 0-7 spark, 8-15 shakeAmp, 16-23 shakeFrames, 24-31 chroma. */
export const packExtra = (
  spark: SparkId, shakeAmp: number, shakeFrames: number, chroma: number,
): number =>
  ((spark & LOW8) | (clamp8(shakeAmp) << 8) | (clamp8(shakeFrames) << 16) | (clamp8(chroma) << 24)) | 0;

export const extraSpark = (e: number): SparkId => (e & LOW8) as SparkId;
export const extraShakeAmp = (e: number): number => (e >>> 8) & LOW8;
export const extraShakeFrames = (e: number): number => (e >>> 16) & LOW8;
export const extraChroma = (e: number): number => (e >>> 24) & LOW8;

// -----------------------------------------------------------------------------
// Ring geometry. `eventHead` is the next slot to write; `eventCount` is the
// monotonic total. The resident window is the newest min(count, CAP) entries.
// -----------------------------------------------------------------------------

const residentCount = (total: number): number => (total < EVENT_CAP ? total : EVENT_CAP);

/** Word index of reader position `i` (0 = oldest resident, count-1 = newest). */
const wordOf = (head: number, count: number, i: number): number =>
  OFF_EVENTS + wrapIndex(head - count + i, EVENT_CAP) * EVENT_WORDS_EACH;

// -----------------------------------------------------------------------------
// EMIT — called from src/sim only.
// -----------------------------------------------------------------------------

/**
 * Appends one event, stamped with the current sim frame. Six stores, no branch
 * on the ring being full: the oldest resident entry is simply overwritten, and
 * an `EventDrain` detects that it lost entries rather than silently skipping.
 */
export const pushEvent = (
  s: SimState, type: Ev, actor: number, b: number, worldX: FX, worldY: FX, extra: number,
): void => {
  const g = s.g;
  const buf: StateBuf = s.buf;
  const w = OFF_EVENTS + g.eventHead * EVENT_WORDS_EACH;

  buf[w + EW_FRAME] = g.frame;
  buf[w + EW_TYPE] = (type & LOW16) | ((actor & LOW16) << 16);
  buf[w + EW_B] = b | 0;
  buf[w + EW_X] = worldX | 0;
  buf[w + EW_Y] = worldY | 0;
  buf[w + EW_EXTRA] = extra | 0;

  g.eventHead = wrapIndex(g.eventHead + 1, EVENT_CAP);
  g.eventCount = (g.eventCount + 1) | 0;
};

/**
 * PHASE 0 of the canonical frame order, run straight after `g.frame++`.
 *
 * Events are addressed by the frame they were emitted on and they live in the
 * buffer, so an ordinary rollback (restore, then resimulate) rewinds the ring
 * with everything else and there is nothing to clear. What this hook owns is
 * the one case that is NOT ordinary: a resimulation that re-enters a frame the
 * ring already holds entries for — a harness that resimulates forward from a
 * snapshot without restoring, or a round rewind. Those stale entries sit AHEAD
 * of everything this frame is about to append, so they would be drained after
 * their own replacements. Dropping the tail entries stamped at or after the
 * frame we are entering makes the ring monotonic in frame by construction,
 * which is what every reader below relies on. Normally it drops nothing and
 * costs one comparison.
 */
export const beginFrame = (s: SimState): void => {
  const g = s.g;
  const buf = s.buf;
  let count = residentCount(g.eventCount);
  while (count > 0) {
    const slot = wrapIndex(g.eventHead - 1, EVENT_CAP);
    if (buf[OFF_EVENTS + slot * EVENT_WORDS_EACH]! < g.frame) break;
    g.eventHead = slot;
    g.eventCount = (g.eventCount - 1) | 0;
    count--;
  }
};

// -----------------------------------------------------------------------------
// READ — presentation only. Never branches the simulation on these.
// -----------------------------------------------------------------------------

/** `EventRing` plus the frame stamp, which the drain watermark needs. */
export interface EventRingView extends EventRing {
  /** Sim frame this event was emitted on. Monotonic across i. */
  frameAt(i: number): number;
  /** Monotonic sequence number of entry i, for cursor bookkeeping. */
  seqAt(i: number): number;
}

class EventRingImpl implements EventRingView {
  private readonly s: SimState;

  constructor(s: SimState) {
    this.s = s;
  }

  get count(): number {
    return residentCount(this.s.g.eventCount);
  }

  private word(i: number): number {
    const g = this.s.g;
    return wordOf(g.eventHead, residentCount(g.eventCount), i);
  }

  type(i: number): Ev {
    return (this.s.buf[this.word(i) + EW_TYPE]! & LOW16) as Ev;
  }

  a(i: number): number {
    return (this.s.buf[this.word(i) + EW_TYPE]! >>> 16) & LOW16;
  }

  b(i: number): number {
    return this.s.buf[this.word(i) + EW_B]!;
  }

  worldX(i: number): FX {
    return this.s.buf[this.word(i) + EW_X]!;
  }

  worldY(i: number): FX {
    return this.s.buf[this.word(i) + EW_Y]!;
  }

  extra(i: number): number {
    return this.s.buf[this.word(i) + EW_EXTRA]!;
  }

  frameAt(i: number): number {
    return this.s.buf[this.word(i) + EW_FRAME]!;
  }

  seqAt(i: number): number {
    const g = this.s.g;
    return g.eventCount - residentCount(g.eventCount) + i;
  }
}

/** One reader per state, cached: draining every frame must not allocate. */
const VIEWS = new WeakMap<SimState, EventRingImpl>();

export const eventRing = (s: SimState): EventRingView => {
  let v = VIEWS.get(s);
  if (v === undefined) {
    v = new EventRingImpl(s);
    VIEWS.set(s, v);
  }
  return v;
};

/** The contract's `EventsFn`, realised, so the compiler proves the signature. */
export const events: EventsFn = (s) => eventRing(s);

/**
 * Stateless iteration over every resident event emitted at or before
 * `upToFrame`, oldest first. This satisfies the contract's `DrainEventsFn` and
 * is the right call for a one-shot reader (a debug overlay, a test). A
 * long-lived consumer — the renderer, the audio bus — wants `EventDrain`
 * instead, because only a cursor can promise "each event exactly once".
 */
export const drainEvents: DrainEventsFn = (s, upToFrame, cb) => {
  const r = eventRing(s);
  const n = r.count;
  for (let i = 0; i < n; i++) {
    if (r.frameAt(i) > upToFrame) return; // frames are monotonic; nothing later qualifies
    cb(r, i);
  }
};

/**
 * A consuming cursor. Each independent consumer owns one, so the renderer and
 * the audio bus cannot starve each other.
 *
 * `lost` is not decoration: 48 slots is generous for one frame but a consumer
 * that stalls for a second will silently miss events in every other design.
 * Here the sequence arithmetic reports exactly how many, and a non-zero `lost`
 * means presentation is not keeping up rather than "the sim stopped hitting".
 */
export class EventDrain {
  /** First sequence number not yet handed to the callback. */
  private nextSeq = 0;
  /** Events overwritten before this consumer reached them. */
  private lost = 0;

  /** Events dropped because the ring wrapped past this cursor. */
  get lostCount(): number {
    return this.lost;
  }

  /** Forgets everything consumed so far. Use on a round reset or scene change. */
  reset(): void {
    this.nextSeq = 0;
    this.lost = 0;
  }

  /**
   * Delivers every event with sequence >= the cursor and frame <= `upToFrame`,
   * oldest first, then advances the cursor past what it delivered. Pass
   * `s.g.confirmedFrame` as `upToFrame`.
   */
  drain(s: SimState, upToFrame: number, cb: (r: EventRing, i: number) => void): void {
    const g = s.g;
    const total = g.eventCount;
    const count = residentCount(total);
    const oldestSeq = total - count;

    // The ring wrapped over entries this cursor had not reached yet.
    if (this.nextSeq < oldestSeq) {
      this.lost += oldestSeq - this.nextSeq;
      this.nextSeq = oldestSeq;
    }
    // The ring got SHORTER than the cursor: a round reset zeroed it, or a
    // rollback rewound past events already delivered. Either way the entries
    // ahead are new, so the cursor drops back to the live end of the ring.
    if (this.nextSeq > total) this.nextSeq = total;

    const r = eventRing(s);
    for (let i = this.nextSeq - oldestSeq; i < count; i++) {
      if (r.frameAt(i) > upToFrame) break;
      cb(r, i);
      this.nextSeq = oldestSeq + i + 1;
    }
  }
}

// =============================================================================
// SunForce — src/ui/intro.ts
// THE ROUND INTRO: 750 ms of black lifting off the stage, then 3 · 2 · 1 · GO.
//
// PRESENTATION ONLY — AND THAT IS THE WHOLE DESIGN
//   src/sim/state.ts opens a round in `RoundState.FIGHT`, not `INTRO`, on
//   purpose: every headless test calls `createState` and then `step` and
//   expects the first punch to land. Teaching the sim to wait would silently
//   break all of them and move the determinism hash besides.
//
//   So the countdown is not a gate, not a sim state and not a flag anywhere in
//   sim/**. It is a COUNTER OWNED BY THE FIGHT SCENE plus the two pure
//   functions below. While the counter runs, game/scenes.ts simply does not
//   call `match.advance(...)`: the fighters stand still because nothing is
//   stepping them, the round timer has not started because `roundTimer` only
//   ticks inside `step`, and the sim never learns any of it happened.
//
// EVERYTHING HERE IS A PURE FUNCTION OF ONE INTEGER
//   `introPhaseAt(frame)` and `drawIntro(out, frame)` hold no state at all, so
//   the same frame number always draws the same pixels. Nothing to reset,
//   nothing to leak between matches, and the timeline can be reasoned about (or
//   asserted) without a GL context.
//
// FRAMES, NOT MILLISECONDS
//   The counter advances once per SIM TICK, which core/loop.ts fixes at
//   `SIM_HZ`. Durations are AUTHORED in ms below and converted once, so the
//   timeline reads as the design does ("750 ms") while the code counts the only
//   clock that matters.
//
// DRAW ORDER IS PUSH ORDER. gfx/batch.ts does not sort and there is no depth
// buffer — an instance pushed later paints on top. The `z` fields below say
// what the intended order IS, but what ENFORCES it is the sequence of pushes in
// `drawIntro`: band, then glyph, then the fade last of all, over everything.
// =============================================================================

import { LOGICAL_H, LOGICAL_W, SIM_HZ } from '@/core/contracts';
import type { InstanceWriter } from '@/core/contracts';
import { writeQuad } from '@/gfx/batch';
import { drawText, measureText } from '@/ui/font';

// -----------------------------------------------------------------------------
// THE TIMELINE
// -----------------------------------------------------------------------------

/** ms -> sim frames at the loop's fixed rate. The ONLY place 60 Hz is used. */
const framesOf = (ms: number): number => Math.round((ms * SIM_HZ) / 1000);

/** Black -> clear: the stage appearing. The user's 750 ms, to the frame. */
export const INTRO_FADE_MS = 750;
/** One counted beat: "3", then "2", then "1". */
export const INTRO_BEAT_MS = 750;
/** "GO" is deliberately shorter — it hands over control, it does not hold it. */
export const INTRO_GO_MS = 500;

export const INTRO_FADE_FRAMES = framesOf(INTRO_FADE_MS);   // 45
export const INTRO_BEAT_FRAMES = framesOf(INTRO_BEAT_MS);   // 45
export const INTRO_GO_FRAMES = framesOf(INTRO_GO_MS);       // 30

/**
 * Where the fight scene is in the sequence. `DONE` is not a beat: it is the
 * frame the sim starts stepping, which is why it is a phase and not a boolean.
 */
export enum IntroPhase { FADE = 0, THREE, TWO, ONE, GO, DONE }

/** 3, derived from the enum rather than written twice. */
export const INTRO_COUNT_FROM = IntroPhase.GO - IntroPhase.THREE;
export const INTRO_COUNT_FRAMES = INTRO_COUNT_FROM * INTRO_BEAT_FRAMES;

/** 210 frames = 3.5 s. The exact number of sim ticks the fight scene holds. */
export const INTRO_TOTAL_FRAMES =
  INTRO_FADE_FRAMES + INTRO_COUNT_FRAMES + INTRO_GO_FRAMES;

/** The first frame of a phase, counted from `enter()`. */
export const introPhaseStart = (p: IntroPhase): number =>
  p <= IntroPhase.FADE ? 0
    : p >= IntroPhase.DONE ? INTRO_TOTAL_FRAMES
      : p === IntroPhase.GO ? INTRO_FADE_FRAMES + INTRO_COUNT_FRAMES
        : INTRO_FADE_FRAMES + (p - IntroPhase.THREE) * INTRO_BEAT_FRAMES;

/** Frames a phase lasts. Only the beats and GO have a length worth asking for. */
export const introPhaseFrames = (p: IntroPhase): number =>
  p === IntroPhase.FADE ? INTRO_FADE_FRAMES
    : p === IntroPhase.GO ? INTRO_GO_FRAMES
      : p >= IntroPhase.DONE ? 0
        : INTRO_BEAT_FRAMES;

/** The phase `frame` falls in. Negative frames read as FADE, so a caller that
 *  counts from somewhere else cannot skip the black. */
export const introPhaseAt = (frame: number): IntroPhase => {
  if (frame < INTRO_FADE_FRAMES) return IntroPhase.FADE;
  const t = frame - INTRO_FADE_FRAMES;
  if (t < INTRO_COUNT_FRAMES) {
    return (IntroPhase.THREE + Math.floor(t / INTRO_BEAT_FRAMES)) as IntroPhase;
  }
  return t < INTRO_COUNT_FRAMES + INTRO_GO_FRAMES ? IntroPhase.GO : IntroPhase.DONE;
};

/** Has the fight been handed over? The scene's whole condition, in one call. */
export const introDone = (frame: number): boolean => frame >= INTRO_TOTAL_FRAMES;

/** What a phase puts on screen. FADE and DONE draw no text. */
export const introLabel = (p: IntroPhase): string =>
  p === IntroPhase.GO ? 'GO'
    : p >= IntroPhase.THREE && p <= IntroPhase.ONE
      ? String(IntroPhase.GO - p)
      : '';

// -----------------------------------------------------------------------------
// THE LOOK
//
// Legibility over a bright painted stage is not optional here: the fade has
// just finished and the panorama behind the numeral can be dawn-lit sky. Every
// glyph therefore gets a dark backing band, a cast shadow and a four-way
// outline, so it survives on top of anything.
// -----------------------------------------------------------------------------

/** The overlay's own screen space: the HUD's fixed 1920x1080 ortho, y UP. */
const CENTER_X = LOGICAL_W * 0.5;
/** A little above the geometric centre — the HUD owns the top of the screen and
 *  the fighters own the bottom third, so this sits in the gap between them. */
const CENTER_Y = LOGICAL_H * 0.54;

const COL_INK = 0xf6efdc;       // bone — the counted digits
const COL_INK_EDGE = 0x17111f;  // their outline: near-black, never pure black
const COL_GO = 0x35e07c;        // wiphala green. GO is a different KIND of word
const COL_GO_EDGE = 0x06240f;
const COL_BAND = 0x07060f;      // the HUD's own plate colour
const COL_DROP = 0x000000;
/** Hairlines on the band: gold while counting, green on GO. */
const ACCENT_COUNT = 0xffc93c;  // the round clock's gold, so they read as a set

const BAND_H = 372;
const BAND_ALPHA = 0.42;
const HAIRLINE = 5;

const DIGIT_SIZE = 344;
const DIGIT_TRACKING = 0;
const GO_SIZE = 272;
const GO_TRACKING = 56;
/** GO is struck again either side to fatten its strokes: weight, not just hue. */
const GO_BOLD = 11;

/** Outline and shadow offsets, as a fraction of the glyph cell, so they hold up
 *  while the numeral is still three times its resting size. */
const EDGE_RATIO = 0.022;
const DROP_RATIO = 0.04;

/** Painter's keys. Above the HUD's 10..12, below nothing: this is the top. */
const Z = { BAND: 40, DROP: 42, EDGE: 44, INK: 46, FADE: 60 } as const;

// -----------------------------------------------------------------------------
// THE MOTION — a fighting game's punch-in, not a fade-in
// -----------------------------------------------------------------------------

/** Frames the numeral takes to slam from oversized down to its resting size. */
const PUNCH_FRAMES = 7;
/** How oversized it starts. Faint and enormous, solid and settled 7 frames on.
 *  Sized so the first, biggest ghost still fits inside 1080 px: an oversized
 *  numeral is a slam, one cut off by the top of the screen is a mistake. */
const PUNCH_SCALE = 2.6;
/** The band wipes open from the centre over this many frames. */
const WIPE_FRAMES = 5;
/** Tail of a beat: the glyph swells slightly and fades, so the NEXT one lands
 *  into empty space instead of colliding with the last. */
const RELEASE_FRAMES = 13;
const RELEASE_SCALE = 1.16;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

interface BeatShape {
  /** Glyph cell multiplier: >1 while punching in, >1 again as it releases. */
  readonly scale: number;
  readonly alpha: number;
  /** 0..1 of the band's full width. */
  readonly wipe: number;
}

/**
 * `local` is frames into the beat, `span` its length. Two independent curves:
 * the SLAM (first `PUNCH_FRAMES`) and the RELEASE (last `RELEASE_FRAMES`). They
 * cannot overlap for any beat in the timeline — 7 + 13 < 30 — so the middle of
 * every beat is a still, solid, perfectly legible numeral.
 */
const beatShape = (local: number, span: number): BeatShape => {
  const punch = clamp01(local / PUNCH_FRAMES);
  const slam = Math.pow(1 - punch, 3);
  const release = clamp01((local - (span - RELEASE_FRAMES)) / RELEASE_FRAMES);
  return {
    scale: 1 + (PUNCH_SCALE - 1) * slam + (RELEASE_SCALE - 1) * release * release,
    // Faint while it is a giant ghost, full the instant it lands, gone by the
    // end of the beat.
    alpha: (0.2 + 0.8 * easeOut(punch)) * Math.pow(1 - release, 1.7),
    wipe: clamp01((local + 1) / WIPE_FRAMES),
  };
};

// -----------------------------------------------------------------------------
// DRAWING
//
// `out` is whatever the caller bound — game/scenes.ts hands us the fight
// renderer's batch with the flat material already selected and the screen ortho
// already set. Nothing here touches GL, a material or a matrix.
// -----------------------------------------------------------------------------

interface Stamp {
  readonly text: string;
  /** Glyph cell height in screen px, already scaled by the beat. */
  readonly size: number;
  readonly tracking: number;
  readonly fill: number;
  readonly edge: number;
  readonly alpha: number;
  /** Extra strikes either side, in px, to fatten the strokes. 0 = plain. */
  readonly bold: number;
}

/**
 * One centred line of text with a cast shadow and a four-way outline: nine
 * `drawText` calls at worst, which over one or two glyphs is under 200 quads in
 * the pass that is already open. The outline is what keeps a bone-white numeral
 * readable against a bright sky.
 */
const drawStamp = (out: InstanceWriter, s: Stamp): void => {
  if (s.alpha <= 0 || s.text.length === 0) return;

  // The font draws from a BASELINE; centring the cell about CENTER_Y keeps the
  // numeral's optical middle put while its size changes underneath it.
  const baseline = CENTER_Y - s.size * 0.5;
  const edge = s.size * EDGE_RATIO;
  const drop = s.size * DROP_RATIO;

  const at = (dx: number, dy: number, color: number, alpha: number, z: number): void => {
    drawText(out, s.text, CENTER_X + dx, baseline + dy, {
      size: s.size, tracking: s.tracking, align: 'center', color, alpha, z,
    });
  };

  at(drop, -drop, COL_DROP, 0.5 * s.alpha, Z.DROP);
  at(-edge, 0, s.edge, 0.92 * s.alpha, Z.EDGE);
  at(edge, 0, s.edge, 0.92 * s.alpha, Z.EDGE);
  at(0, edge, s.edge, 0.92 * s.alpha, Z.EDGE);
  at(0, -edge, s.edge, 0.92 * s.alpha, Z.EDGE);
  if (s.bold > 0) {
    at(-s.bold, 0, s.fill, s.alpha, Z.INK);
    at(s.bold, 0, s.fill, s.alpha, Z.INK);
    at(0, s.bold * 0.5, s.fill, s.alpha, Z.INK);
  }
  at(0, 0, s.fill, s.alpha, Z.INK);
};

/** The dark plate the glyph sits on, wiping open from the centre of the screen. */
const drawBand = (out: InstanceWriter, wipe: number, alpha: number, accent: number): void => {
  const w = LOGICAL_W * easeOut(wipe);
  const x = CENTER_X - w * 0.5;
  const y = CENTER_Y - BAND_H * 0.5;
  writeQuad(out, x, y, w, BAND_H, COL_BAND, BAND_ALPHA * alpha, Z.BAND);
  writeQuad(out, x, y, w, HAIRLINE, accent, 0.55 * alpha, Z.BAND + 1);
  writeQuad(out, x, y + BAND_H - HAIRLINE, w, HAIRLINE, accent, 0.55 * alpha, Z.BAND + 1);
};

/** One beat: band, then glyph, and for GO the bar that underlines the handover. */
const drawBeat = (out: InstanceWriter, phase: IntroPhase, local: number): void => {
  const go = phase === IntroPhase.GO;
  const shape = beatShape(local, introPhaseFrames(phase));
  if (shape.alpha <= 0) return;

  drawBand(out, shape.wipe, shape.alpha, go ? COL_GO : ACCENT_COUNT);

  const size = (go ? GO_SIZE : DIGIT_SIZE) * shape.scale;
  const tracking = (go ? GO_TRACKING : DIGIT_TRACKING) * shape.scale;
  const text = introLabel(phase);

  if (go) {
    // A bar the exact width of the word, so GO reads as a stamped command
    // rather than one more number in the sequence.
    const w = measureText(text, { size, tracking });
    const y = CENTER_Y - size * 0.5 - size * 0.16;
    writeQuad(out, CENTER_X - w * 0.5, y, w, size * 0.07, COL_GO, 0.9 * shape.alpha, Z.EDGE);
  }

  drawStamp(out, {
    text,
    size,
    tracking,
    fill: go ? COL_GO : COL_INK,
    edge: go ? COL_GO_EDGE : COL_INK_EDGE,
    alpha: shape.alpha,
    bold: go ? GO_BOLD * shape.scale : 0,
  });
};

/**
 * The 750 ms curtain: one full-screen black quad at alpha 1 -> 0. It is pushed
 * LAST by `drawIntro` and therefore covers EVERYTHING — stage, fighters, HP
 * bars, the round clock — which is the point. The HUD is part of the frame the
 * fade is lifting off, not an exception to it.
 */
const drawFade = (out: InstanceWriter, frame: number): void => {
  if (frame >= INTRO_FADE_FRAMES) return;
  const a = 1 - clamp01(frame / INTRO_FADE_FRAMES);
  writeQuad(out, 0, 0, LOGICAL_W, LOGICAL_H, COL_DROP, a, Z.FADE);
};

/**
 * THE WHOLE OVERLAY for one frame of the intro, drawn in the renderer's fixed
 * 1920x1080 screen-space ortho (y UP). `frame` counts sim ticks since the fight
 * scene was entered; past `INTRO_TOTAL_FRAMES` this draws nothing, so a caller
 * that keeps calling it costs a comparison and no quads.
 */
export const drawIntro = (out: InstanceWriter, frame: number): void => {
  const phase = introPhaseAt(frame);
  if (phase === IntroPhase.DONE) return;
  if (phase !== IntroPhase.FADE) drawBeat(out, phase, frame - introPhaseStart(phase));
  drawFade(out, frame);   // last, and over the top of all of it
};

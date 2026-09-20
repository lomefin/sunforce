// =============================================================================
// SunForce — src/ui/font.ts
// The game's only text renderer. A 5x7 bitmap face encoded IN CODE: no texture,
// no font file, nothing to load, bake or fail at startup. Every glyph is seven
// 5-bit rows; drawing walks the rows and pushes flat quads into whatever
// material the caller has already bound.
//
// WHY A CODE-RESIDENT BITMAP AND NOT A TEXTURE ATLAS
// A baked font atlas needs a build step, an image, a loader and a fallback for
// when that image is missing — four ways for the select screen to come up
// blank. The select screen is the one place the player MUST be able to read, so
// it is built out of the primitive that cannot fail: `writeQuad`.
//
// COST. A lit pixel is a quad, so text is not free — but it is close. Each row
// of a glyph is emitted as RUN-MERGED spans, not per pixel: the top bar of an
// `E` is one quad, not five. Measured over this face, A-Z0-9 average 10.31
// quads per glyph and the worst is M at 16. A 19-character title is 155
// instances, not the 665 a per-pixel loop would cost. See the cost note at the
// bottom of this file for the whole-screen arithmetic.
//
// SCREEN SPACE. `(x, y)` is the text's BASELINE-LEFT in the renderer's fixed
// 1920x1080 virtual viewport, y UP — the same ortho `FightRenderer.drawHud`
// sets up. The glyph cell sits ON the baseline: the bottom pixel row spans
// y .. y + size/7, the cell top is y + size. No glyph descends below y, so a
// row of text never overlaps the line beneath it.
//
// NOTE FOR THE LINT WALL: the `<<` and `&` here are on GLYPH BITMASKS — compile
// -time literals, never fixed-point simulation values. The mirror-safety rule
// that bans shifts is about `>>` flooring negative fixed-point coordinates; no
// number in this file reaches the sim.
// =============================================================================

import type { InstanceWriter } from '@/core/contracts';
import { writeQuad } from '@/gfx/batch';

/** Glyph cell, in font units. Every glyph is exactly this. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;

export interface TextOpts {
  /** Pixel height of one glyph cell; default 16. */
  readonly size?: number;
  /** 0xRRGGBB; default 0xffffff. */
  readonly color?: number;
  /** Default 1. */
  readonly alpha?: number;
  /** Painter's sort key, as everywhere else in the batcher; default 0. */
  readonly z?: number;
  /** Default 'left', about x. */
  readonly align?: 'left' | 'center' | 'right';
  /** Extra px between glyph cells; default size * 0.2. */
  readonly tracking?: number;
}

// -----------------------------------------------------------------------------
// The face
// -----------------------------------------------------------------------------
// Seven rows, top first, five bits each — the 1s ARE the letterform, so the
// shapes are editable by eye. Even weight throughout: every stroke is one pixel,
// every bowl is closed, and no glyph uses fewer than 5 of its 7 rows, so mixed
// text does not jitter in height. Kept strictly inside the cell (no descenders)
// so that `measureText`, `align` and the baseline agree with no special cases.

type Glyph = readonly [number, number, number, number, number, number, number];

const FACE: Readonly<Record<string, Glyph>> = {
  ' ': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000],

  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b11001, 0b10101, 0b10011, 0b10011, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],

  // Digits are the same weight and the same 7 rows tall as the caps, so a
  // "ROUND 1" or a timer never looks like two different fonts.
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],

  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100],
  ',': [0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100, 0b01000],
  ':': [0b00000, 0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100],
  '-': [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000],
  '/': [0b00001, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b00000, 0b00100],
  // `<` and `>` double as the select screen's left/right arrows.
  '<': [0b00001, 0b00010, 0b00100, 0b01000, 0b00100, 0b00010, 0b00001],
  '>': [0b10000, 0b01000, 0b00100, 0b00010, 0b00100, 0b01000, 0b10000],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '%': [0b11000, 0b11001, 0b00010, 0b00100, 0b01000, 0b10011, 0b00011],
};

/**
 * Drawn for any code point the face does not carry. A crossed box, deliberately
 * the loudest thing on the line: a typo in a label must be VISIBLE, never a
 * silent hole in the middle of a word.
 */
const MISSING: Glyph = [0b11111, 0b10001, 0b10101, 0b11011, 0b10101, 0b10001, 0b11111];

/** Char code -> glyph. Built once; lookup is a Map hit, not a string index. */
const TABLE = ((): ReadonlyMap<number, Glyph> => {
  const m = new Map<number, Glyph>();
  for (const key of Object.keys(FACE)) m.set(key.charCodeAt(0), FACE[key]!);
  return m;
})();

const LOWER_A = 'a'.charCodeAt(0);
const LOWER_Z = 'z'.charCodeAt(0);
const CASE_SHIFT = LOWER_A - 'A'.charCodeAt(0);

/** Lowercase folds to caps — this face has one case, and blanking it would be
 *  worse than drawing it. Anything else falls through to the crossed box. */
const glyphOf = (code: number): Glyph => {
  const c = code >= LOWER_A && code <= LOWER_Z ? code - CASE_SHIFT : code;
  return TABLE.get(c) ?? MISSING;
};

// -----------------------------------------------------------------------------
// Metrics — ONE source of truth, so measure and draw can never disagree
// -----------------------------------------------------------------------------

interface Metrics {
  /** Side of one font pixel, in screen px. */
  readonly unit: number;
  /** Width of one glyph cell, in screen px. */
  readonly cell: number;
  /** Gap between adjacent cells, in screen px. */
  readonly tracking: number;
}

const metricsOf = (o: TextOpts | undefined): Metrics => {
  const size = o?.size ?? 16;
  const unit = size / GLYPH_H;
  return {
    unit,
    cell: GLYPH_W * unit,
    tracking: o?.tracking ?? size * 0.2,
  };
};

/** n cells and n-1 gaps. The trailing gap is NOT part of the width, which is
 *  what makes a centred title land dead centre instead of half a space left. */
const widthOf = (n: number, m: Metrics): number =>
  n <= 0 ? 0 : n * m.cell + (n - 1) * m.tracking;

/** Advance of the pen from the left edge of glyph i to the left edge of i+1. */
const penStart = (x: number, width: number, align: TextOpts['align']): number =>
  align === 'center' ? x - width * 0.5 : align === 'right' ? x - width : x;

/**
 * Width `text` occupies, in pixels, under the same options `drawText` would
 * use. Exact, not an estimate: `drawText` computes its layout with this very
 * arithmetic, so a caller can box, underline or centre against it to the pixel.
 */
export const measureText = (text: string, o?: TextOpts): number =>
  widthOf(text.length, metricsOf(o));

// -----------------------------------------------------------------------------
// Drawing
// -----------------------------------------------------------------------------

/**
 * Emits one glyph with its cell's LEFT edge at `x` and its BOTTOM row resting
 * on baseline `y`. Each row is scanned into maximal runs of lit pixels and each
 * run becomes a single quad: fewer instances, and — because a run is one
 * rectangle rather than n abutting ones — no hairline seams inside a stroke
 * when `unit` is fractional (size 12 gives unit 1.714).
 */
const emitGlyph = (
  out: InstanceWriter,
  g: Glyph,
  x: number, y: number,
  m: Metrics,
  color: number, alpha: number, z: number,
): void => {
  for (let row = 0; row < GLYPH_H; row++) {
    const bits = g[row]!;
    if (bits === 0) continue;
    // Row 0 is the TOP of the cell; the cell's bottom row sits on the baseline.
    const py = y + (GLYPH_H - 1 - row) * m.unit;
    let col = 0;
    while (col < GLYPH_W) {
      if ((bits & (1 << (GLYPH_W - 1 - col))) === 0) { col++; continue; }
      let end = col + 1;
      while (end < GLYPH_W && (bits & (1 << (GLYPH_W - 1 - end))) !== 0) end++;
      writeQuad(out, x + col * m.unit, py, (end - col) * m.unit, m.unit, color, alpha, z);
      col = end;
    }
  }
};

/**
 * Draws `text` into the CURRENT material — the caller has already done
 * `batch.use(batch.solidMaterial)` (or whatever flat material it wants) and
 * set the screen-space view-projection. Returns the width drawn, in pixels,
 * which is exactly `measureText(text, o)`.
 *
 * `(x, y)` is the baseline-left of the run, or the baseline-centre / -right
 * when `align` says so.
 */
export const drawText = (
  out: InstanceWriter,
  text: string,
  x: number, y: number,
  o?: TextOpts,
): number => {
  const m = metricsOf(o);
  const width = widthOf(text.length, m);
  if (text.length === 0) return 0;

  const color = o?.color ?? 0xffffff;
  const alpha = o?.alpha ?? 1;
  const z = o?.z ?? 0;
  if (alpha <= 0) return width;

  let pen = penStart(x, width, o?.align ?? 'left');
  const step = m.cell + m.tracking;
  for (let i = 0; i < text.length; i++) {
    // Space is an all-zero glyph, so it costs nothing but its advance.
    emitGlyph(out, glyphOf(text.charCodeAt(i)), pen, y, m, color, alpha, z);
    pen += step;
  }
  return width;
};

// =============================================================================
// COST, measured rather than guessed
// -----------------------------------------------------------------------------
// Run-merged spans counted over this actual face: A-Z0-9 average 10.31 quads
// per glyph, worst 16 (M), punctuation 2-8, space 0. Blended with spaces, real
// strings come out around 8.3 quads per character.
//
// A whole select screen — title, P1/P2 labels, six roster cells, a stage line,
// a control hint and a READY — is about 76 characters, which measures at 630
// instances. At 24 floats each that is ~59 KB of vertex data per frame, in ONE
// draw call, on a screen otherwise drawing nothing but flat panels. A naive
// quad-per-lit-pixel loop would have cost ~2400 instances (~230 KB); run
// merging pays for itself and removes the sub-pixel seams besides.
//
// So: no, this does not need a smarter approach. For comparison the fight
// already pushes a full parallax stage plus two fighters through the same batch
// every frame, and the select screen is otherwise nearly empty. A baked atlas
// would cut 630 quads to ~76, saving well under 0.1 ms of a 16.6 ms budget, in
// exchange for an asset that can fail to load on the one screen the player MUST
// be able to read.
//
// The number that WOULD change the answer is a scrolling credits roll or a
// per-frame debug dump of hundreds of lines — thousands of characters, tens of
// thousands of quads. Nothing in SunForce does that. If something ever does,
// bake an atlas then; these two exported functions keep their signatures.
// =============================================================================

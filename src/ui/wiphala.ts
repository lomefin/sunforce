// =============================================================================
// SunForce — src/ui/wiphala.ts
// The wiphala as a drawable, and the two HUD pieces built out of it: the
// fighters' health bars and the round clock that sits between them.
//
// -----------------------------------------------------------------------------
// WHAT THE EMBLEM IS — the construction, not a vibe
// -----------------------------------------------------------------------------
// The wiphala is a SQUARE flag of 49 cells, 7 x 7, in seven colours, laid out
// so that every DIAGONAL is a single colour. The diagonal is the whole visual
// identity: a horizontal rainbow is not a wiphala, it is a stripe. It is flown
// across the Bolivian highlands and carried by exactly the troupes this game is
// about, which is why it is the right frame for a health bar and why it is
// built here properly rather than approximated with a gradient.
//
// The colour order is fixed — each colour carries a meaning (earth, society,
// energy, time, resources, cosmos, self-determination) — so the sequence is
// never reshuffled for aesthetics. Nothing in this file renders that meaning;
// it is simply why the order is not ours to touch.
//
// THE OFFSET, DONE AS ARITHMETIC RATHER THAN GUESSED
//
//     colour(row, col) = WIPHALA[(row + col + OFFSET) % 7]      row 0 = TOP
//
// Cells of equal (row + col) share a colour, so the constant-colour diagonals
// run bottom-left to top-right. The Qulla Suyu wiphala — the one co-official in
// Bolivia since 2009 — reads with WHITE on the centre diagonal, the one through
// the middle cell (3, 3), where row + col = 6. White is index 3, so
//
//     (6 + OFFSET) % 7 = 3   ->   OFFSET = 3 - 6 = -3 = 4   (mod 7)
//
// OFFSET = 4, and it is the only value in 0..6 that works. It checks out
// against the real flag: the top row reads green, blue, violet, red, orange,
// yellow, white; white lands on both the bottom-left and the top-right corner
// as the two ends of the centre diagonal; the top-left corner is green.
// WIPHALA_OFFSET below is written as that arithmetic so it cannot drift.
//
// -----------------------------------------------------------------------------
// WHY THE RIGHT-HAND BAR IS NOT MIRRORED
// -----------------------------------------------------------------------------
// A flag does not get mirrored. Flipping the weave would run the white diagonal
// the other way, which is a different flag — and the eye catches it instantly
// where the two bars face each other across the clock. So BOTH bars draw the
// identical, unflipped wiphala: the colour index always advances with screen x,
// left to right, on both sides of the screen.
//
// What IS mirrored is only the layout: which end the fill hugs, and which end
// the band is cut at. Cells are kept exactly square (side = h / 7), so the last
// column rarely divides evenly; that cut is placed at each bar's INNER end by
// anchoring the cell grid to the outer screen edge. The two bars are therefore
// mirror-symmetric in shape while the cloth itself is two lengths cut from the
// same weave — which is what an aguayo band actually is.
//
// DRAIN DIRECTION. Fighting-game convention: remaining health hugs the OUTER
// screen edge and damage eats INWARD toward the centre. The pattern is pinned
// to the PLATE, never to the fill, so taking a hit uncovers dark plate instead
// of making the whole weave crawl sideways.
//
// Pure drawing: no DOM, no GL calls, no module state. Everything is a quad.
// =============================================================================

import type { InstanceWriter } from '@/core/contracts';
import { ROUND_TIME, SIM_HZ } from '@/core/contracts';
import { I, writeQuad } from '@/gfx/batch';
import { drawText } from '@/ui/font';

// -----------------------------------------------------------------------------
// The emblem
// -----------------------------------------------------------------------------

/** Cells per side. The flag is 7 x 7 = 49, and that is not a tunable. */
export const WIPHALA_N = 7;

/** The seven colours, in sequence. Never reorder — see the header. */
export const WIPHALA: readonly number[] = [
  0xd40000, // red      — earth and the Andean people
  0xff8000, // orange   — society and culture
  0xffff00, // yellow   — energy and strength
  0xffffff, // white    — time and change
  0x00a651, // green    — the land and its resources
  0x0080ff, // blue     — the cosmos
  0x8000ff, // violet   — self-determination
];

/** Index of white inside WIPHALA. */
const WHITE_IX = 3;

/**
 * The rotation that puts white on the centre diagonal: white must land where
 * `row + col === WIPHALA_N - 1`, so OFFSET = WHITE_IX - (N - 1) (mod N) = 4.
 * Kept as the arithmetic so the flag stays correct if anything above moves.
 */
export const WIPHALA_OFFSET =
  (((WHITE_IX - (WIPHALA_N - 1)) % WIPHALA_N) + WIPHALA_N) % WIPHALA_N;

/** Colour of cell (row, col) under the diagonal construction. row 0 = TOP. */
export const wiphalaCell = (row: number, col: number): number => {
  const k = (((row + col + WIPHALA_OFFSET) % WIPHALA_N) + WIPHALA_N) % WIPHALA_N;
  return WIPHALA[k]!;
};

// -----------------------------------------------------------------------------
// Furniture — the non-cloth colours. Deliberately outside the flag's palette:
// the seven colours are the CLOTH and nothing else borrows them.
// -----------------------------------------------------------------------------

const PLATE = 0x07060f;     // drop plate, near-black; matches the HUD's own
const EMPTY = 0x171320;     // lost health: dark, and obviously not cloth
const EMPTY_LIP = 0x241d31; // one lighter band, so an empty bar reads as a recess
const BORDER = 0xe8dcc0;    // bone — the thin line that survives a bright stage
const SHEEN = 0xffffff;
const SHADOW = 0x000000;
const INK = 0xffc93c;       // clock digits — gold
const INK_WARN = 0xffe98a;  // under ten seconds: a hotter, brighter gold
                            // rather than red — urgency without leaving the palette

/** NaN- and sign-safe. `NaN > 0` is false, so a bad input reads as empty. */
const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * One flat quad with the instance FX flash slot stamped.
 *
 * `flash` is not mixed on the CPU: the built-in quad program — the one behind
 * `QuadBatch.solidMaterial`, which the HUD binds — already does
 * `mix(rgb, white, fx.x)` per fragment. So a white-hot bar costs one extra
 * float per instance and no extra pass. `writeQuad` returns the instance view,
 * valid until the next push, which is why the stamp happens immediately.
 */
const q = (
  out: InstanceWriter,
  x: number, y: number, w: number, h: number,
  color: number, alpha: number, z: number, flash: number,
): void => {
  if (!(w > 0) || !(h > 0) || alpha <= 0) return;
  const inst = writeQuad(out, x, y, w, h, color, alpha, z);
  if (flash > 0) inst[I.FLASH] = flash;
};

// -----------------------------------------------------------------------------
// The health bar
// -----------------------------------------------------------------------------

export interface HealthBarOpts {
  /** Bottom-left of the bar, screen space (the HUD's 1920x1080 ortho, y UP). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 0..1 remaining. */
  readonly frac: number;
  /** true = this bar belongs to the player on the LEFT of the screen. */
  readonly leftSide: boolean;
  readonly z?: number;
  /** 0..1, flashes the bar white on a big hit. Default 0. */
  readonly flash?: number;
}

/**
 * Draws one fighter's health as a length of wiphala on a dark inset plate.
 *
 * The caller has already bound a flat material (`batch.use(batch.solidMaterial)`)
 * and set the screen-space view-projection — exactly as `drawText` expects.
 */
/** A slim readout under the health bar. Aura, not HP — see AURA_SCALE. */
export interface AuraBarOpts {
  readonly x: number; readonly y: number;
  readonly w: number; readonly h: number;
  /** Current aura over the fighter's own ceiling, 0..1. */
  readonly frac: number;
  /** Where the dash gate sits on THIS fighter's bar, 0..1. Above it, a dash is
   *  affordable; at or below it, refused. Drawn as a notch so the player can
   *  see the line rather than discover it by pressing. */
  readonly threshold: number;
  /** P1 drains toward the screen edge, P2 the other way — same as the HP. */
  readonly leftSide: boolean;
  readonly z?: number;
}

/**
 * AURA. Deliberately NOT a wiphala weave: the flag belongs to the health bar,
 * and a second one under it would compete with the thing the player actually
 * has to read at a glance. This is a plain slim strip in the round clock's
 * gold, so it reads as the same family without shouting.
 *
 * It DIMS below the dash threshold, which is the one state change worth seeing
 * in peripheral vision: above the notch you have the option, below it you do
 * not.
 */
export const drawAuraBar = (out: InstanceWriter, o: AuraBarOpts): void => {
  const { x, y, w, h } = o;
  if (!(w > 0) || !(h > 0)) return;
  const z = o.z ?? 0;
  const frac = clamp01(o.frac);
  const line = Math.max(1, Math.round(h * 0.18));

  // Plate and a dark inset, so the strip keeps a silhouette over bright art.
  writeQuad(out, x - line, y - line, w + line * 2, h + line * 2, 0x090713, 0.92, z);
  writeQuad(out, x, y, w, h, 0x1b1528, 1, z + 1);

  // The fill hugs the same outer edge the health does, and empties inward.
  const fw = Math.round(w * frac);
  if (fw > 0) {
    const fx2 = o.leftSide ? x : x + w - fw;
    const spent = frac <= o.threshold;
    writeQuad(out, fx2, y, fw, h, spent ? 0x8a6a1f : 0xffc93c, spent ? 0.85 : 1, z + 2);
    // A brighter lip along the top: reads as fullness at a glance.
    writeQuad(out, fx2, y + h - line, fw, line, spent ? 0xb98f2c : 0xffe98a, 1, z + 3);
  }

  // The gate. Clamped inside the bar so a ceiling equal to the threshold —
  // Diablo, who can never dash — still shows its notch rather than losing it
  // off the end.
  const t = clamp01(o.threshold);
  const tx = o.leftSide ? x + Math.round(w * t) : x + w - Math.round(w * t);
  const notch = Math.max(1, Math.round(h * 0.22));
  writeQuad(out, Math.min(Math.max(tx - notch * 0.5, x), x + w - notch), y - line, notch, h + line * 2, 0xf6efdc, 0.75, z + 4);
};

export const drawHealthBar = (out: InstanceWriter, o: HealthBarOpts): void => {
  const { x, y, w, h } = o;
  if (!(w > 0) || !(h > 0)) return;

  const z = o.z ?? 0;
  const flash = clamp01(o.flash ?? 0);
  const frac = clamp01(o.frac);

  // All framing is derived from h, so the bar survives being resized.
  const line = Math.max(1, Math.round(h * 0.055));
  const drop = line + Math.max(2, Math.round(h * 0.1));

  // The drop plate is the one thing NOT flashed: on a heavy hit the bar has to
  // keep a dark silhouette, or a white flare over a bright painted stage erases
  // its own outline and the player loses the bar for three frames.
  q(out, x - drop, y - drop, w + drop * 2, h + drop * 2, PLATE, 0.9, z, 0);
  // Bone border, drawn as a solid rect that the inset then covers all but a
  // line of — one quad instead of four, and no corner seams.
  q(out, x - line, y - line, w + line * 2, h + line * 2, BORDER, 0.82, z + 1, flash * 0.5);
  // The inset. This is also the lost portion: dark, flat, clearly empty.
  q(out, x, y, w, h, EMPTY, 1, z + 2, flash);
  q(out, x, y + h - line * 2, w, line * 2, EMPTY_LIP, 0.8, z + 3, flash);

  // --- the cloth -----------------------------------------------------------
  const fillW = w * frac;
  const fill0 = o.leftSide ? x : x + w - fillW;
  const fill1 = fill0 + fillW;

  // Cells stay SQUARE: the column count comes from the bar's height, so the
  // weave is cut to length rather than stretched to fit, at any bar size.
  const cell = h / WIPHALA_N;
  const cols = Math.max(1, Math.ceil(w / cell - 1e-6));
  // Grid anchored to the OUTER screen edge, so the ragged end lands inward.
  const gridX = o.leftSide ? x : x + w - cols * cell;
  // A hairline gap between cells reads as weave at large sizes; below ~9px it
  // would be a sub-pixel gap that shimmers when the HUD is scaled, so it goes.
  const seam = cell >= 9 ? Math.min(1, cell * 0.06) : 0;
  const cellH = cell - seam;
  const zCell = z + 4;

  for (let c = 0; c < cols; c++) {
    const nx = gridX + c * cell;
    if (nx >= fill1) break;                 // columns run left to right
    let x1 = nx + cell - seam;
    if (x1 > fill1) x1 = fill1;             // partial cell at the drain edge
    const x0 = nx < fill0 ? fill0 : nx;
    const cw = x1 - x0;
    if (cw <= 0) continue;
    for (let r = 0; r < WIPHALA_N; r++) {
      // Row 0 is the TOP of the flag; screen y runs UP.
      q(out, x0, y + (WIPHALA_N - 1 - r) * cell, cw, cellH, wiphalaCell(r, c), 1, zCell, flash);
    }
  }

  // Sheen along the top of the cloth and a shadow at its foot: the band reads
  // as something catching the stage light, not as a flat progress fill. The
  // shadow is never flashed — it is what keeps the bottom edge defined.
  q(out, fill0, y + h - h * 0.14, fillW, h * 0.14, SHEEN, 0.16, z + 5, flash);
  q(out, fill0, y, fillW, h * 0.09, SHADOW, 0.22, z + 5, 0);

  // A bright lip on the MOVING end only. A 50-damage punch is 3.9% of the bar;
  // that is a small step, and a hard edge on it is what makes the step visible.
  if (frac > 0 && frac < 1) {
    q(out, o.leftSide ? fill1 - line : fill0, y, line, h, BORDER, 0.9, z + 6, flash);
  }
};

// -----------------------------------------------------------------------------
// The round clock — the 90 second timer, in the middle, between the two bars
// -----------------------------------------------------------------------------

/** The round length, in seconds. Taken from the sim's constant, not re-typed. */
export const ROUND_SECONDS = ROUND_TIME;

/** Border cells of the 7 x 7 — the clock's burn-down track. */
const RING_CELLS = (WIPHALA_N - 1) * 4;

/**
 * `SimState.g.roundTimer` is a FRAME count down from ROUND_TIME * SIM_HZ.
 * Ceiling, so the clock shows 90 on the first frame of the round and only
 * shows 0 when time is genuinely out.
 */
export const secondsFromFrames = (frames: number): number =>
  frames > 0 ? Math.min(ROUND_SECONDS, Math.ceil(frames / SIM_HZ)) : 0;

/**
 * Where a border cell sits in the burn-down order: clockwise from the top-left
 * corner, 0..RING_CELLS-1. Interior cells return -1.
 */
const ringIndex = (row: number, col: number): number => {
  const n = WIPHALA_N - 1;
  if (row === 0 && col < n) return col;
  if (col === n && row < n) return n + row;
  if (row === n && col > 0) return 3 * n - col;
  if (col === 0 && row > 0) return 4 * n - row;
  return -1;
};

export interface RoundTimerOpts {
  /** Centre of the badge, screen space. */
  readonly cx: number;
  readonly cy: number;
  /** Side of the square emblem — the wiphala is a SQUARE, this is its side. */
  readonly size: number;
  /** Seconds remaining, 0..ROUND_SECONDS. */
  readonly seconds: number;
  readonly z?: number;
}

/**
 * The clock as a whole wiphala: 49 cells, the digits on a dark panel inset by
 * one cell so they stay legible, and the 24 border cells burning down clockwise
 * from the top-left corner as the round runs out.
 *
 * Spent cells DIM rather than disappear. The flag is never dismembered to show
 * a number — it only darkens, and at zero it is still a whole wiphala.
 */
export const drawRoundTimer = (out: InstanceWriter, o: RoundTimerOpts): void => {
  const size = o.size;
  if (!(size > 0)) return;

  const z = o.z ?? 0;
  const secs = o.seconds > 0
    ? (o.seconds < ROUND_SECONDS ? Math.round(o.seconds) : ROUND_SECONDS)
    : 0;

  const x0 = o.cx - size * 0.5;
  const y0 = o.cy - size * 0.5;
  const cell = size / WIPHALA_N;
  const line = Math.max(1, Math.round(size * 0.025));
  const drop = line + Math.max(2, Math.round(size * 0.05));
  const seam = cell >= 9 ? Math.min(1.5, cell * 0.05) : 0;

  q(out, x0 - drop, y0 - drop, size + drop * 2, size + drop * 2, PLATE, 0.9, z, 0);
  q(out, x0 - line, y0 - line, size + line * 2, size + line * 2, BORDER, 0.82, z + 1, 0);

  // One cell per RING_CELLS-th of the round. Ceiling, so the last cell goes out
  // exactly when the clock reads 0 and not a beat before.
  const lit = Math.ceil((RING_CELLS * secs) / ROUND_SECONDS);
  for (let r = 0; r < WIPHALA_N; r++) {
    const cy = y0 + (WIPHALA_N - 1 - r) * cell;
    for (let c = 0; c < WIPHALA_N; c++) {
      const ring = ringIndex(r, c);
      const alpha = ring < 0 ? 1 : ring < lit ? 1 : 0.26;
      q(out, x0 + c * cell, cy, cell - seam, cell - seam, wiphalaCell(r, c), alpha, z + 2, 0);
    }
  }

  // The digit panel: inset by exactly one cell, so the burn-down ring is the
  // full border of the flag and the interior still shows through beneath.
  const inset = x0 + cell;
  q(out, inset, y0 + cell, size - cell * 2, size - cell * 2, PLATE, 0.8, z + 3, 0);

  const ts = size * 0.34;
  const base = o.cy - ts * 0.5;
  const text = secs < 10 ? `0${secs}` : `${secs}`;
  const ink = secs <= 10 ? INK_WARN : INK;
  // Shadow first, then ink: two digits is ~22 quads and it keeps the clock
  // readable when the cloth behind it is yellow or white.
  drawText(out, text, o.cx + ts * 0.06, base - ts * 0.06, {
    size: ts, color: SHADOW, alpha: 0.7, align: 'center', z: z + 4,
  });
  drawText(out, text, o.cx, base, { size: ts, color: ink, align: 'center', z: z + 5 });
};

// =============================================================================
// COST, counted rather than guessed
// -----------------------------------------------------------------------------
// A cell is a quad, so a bar's instance count is 7 * ceil(w / (h / 7)) plus six
// pieces of framing. At the HUD's current 780 x 34 that is 161 columns of 7 —
// 1127 cells, 1134 instances, about 109 KB of vertex data — and both bars plus
// the clock come to roughly 2370 instances, ~228 KB, in ONE draw call and one
// bufferSubData. The batch's default ceiling is 65536 instances, so nothing
// auto-flushes and the HUD stays a single flush as it does today.
//
// That is four select screens' worth of text per frame (font.ts measures its
// whole screen at 630 instances), and it is the honest price of drawing cloth
// as cloth. Two things make it cheaper for free: the drained part of a bar
// emits nothing, so the cost falls as the round goes on, and a taller bar has
// FEWER, bigger cells — h = 48 drops each bar to 812 instances.
//
// If it ever needs to be cheaper than that, the answer is not a coarser grid —
// it is to bake one 7 x 7 wiphala into a texture and draw the fill as a single
// tiled quad with a repeating UV rect, which the instance layout already
// carries. That trades 1127 instances for 1, and this file's exports keep their
// signatures. Nothing in M0 is anywhere near needing it.
// =============================================================================

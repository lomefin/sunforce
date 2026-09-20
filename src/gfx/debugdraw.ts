// =============================================================================
// SunForce — src/gfx/debugdraw.ts
// F1: the hurt / hit / push / throw box overlay.
//
// THIS IS M0'S ACCEPTANCE TEST 6, AND IT IS THE ONLY PROOF WE HAVE THAT
// CONCEPT SPACE -> WORLD SPACE IS CORRECT END TO END. A box that is "roughly
// right" reads on screen as a kick that visually connects and mechanically
// whiffs, which is the single most expensive bug class in a fighting game
// because it is blamed on the frame data for weeks. So this file is EXACT:
//
//   - The FX -> float conversion happens ONCE, at the very end, on numbers the
//     simulation itself produced. Every box edge is `px(integer)`, so what you
//     see is literally the integer the AABB test used — not a re-derivation.
//   - The facing flip is applied here and nowhere else, because compiled boxes
//     are FACING-RELATIVE (+x forward) and `data/compile.ts` deliberately does
//     not know which way a fighter is pointing.
//   - The pushbox is read from the STATE (`f.pushX/Y/W/H`), not from the
//     character definition, because the state's copy is the one physics
//     separates with. If those two ever disagree, F1 shows the truth.
//   - Outlines are drawn INSIDE the box, so the drawn rectangle's outer bounds
//     are exactly the box's bounds at any zoom.
//
// The overlay is ordinary batched geometry — four to five instances per box
// through gfx/batch.ts — so it costs one draw call for every box on screen and
// needs no special pass, no line primitives and no state changes.
// =============================================================================

import { BoxKind, FF, S } from '@/core/contracts';
import type {
  CompiledFrame, FX, Facing, FxBox, InstanceWriter, PlayerIx, SimState,
} from '@/core/contracts';
import { px } from '@/core/fixed';
import { charOf } from '@/sim/state';
import { writeQuad } from '@/gfx/batch';
import type { QuadBatch } from '@/gfx/batch';

// -----------------------------------------------------------------------------
// Palette — four classes, four unmistakable colours.
// -----------------------------------------------------------------------------

/**
 * Distinct per box type and chosen to stay legible over the stage AND over a
 * red Caporal: green = "you can be hit here", red = "this hits", amber = "this
 * is your body", violet = "this grabs".
 */
export const DEBUG_BOX_COLOR: Readonly<Record<BoxKind, number>> = {
  [BoxKind.HURT]: 0x35e08b,
  [BoxKind.HIT]: 0xff3b53,
  [BoxKind.PUSH]: 0xffc23d,
  [BoxKind.THROW]: 0xb07cff,
};

/** Origin marker (feet centre, y = 0) — the anchor every box is measured from. */
export const DEBUG_ORIGIN_COLOR = 0xffffff;
const DEBUG_ORIGIN_ALPHA = 0.85;

/** `1 << BoxKind`, for `DebugDrawOptions.kinds`. */
export const DEBUG_KIND_BIT = {
  HURT: 1 << BoxKind.HURT,
  HIT: 1 << BoxKind.HIT,
  PUSH: 1 << BoxKind.PUSH,
  THROW: 1 << BoxKind.THROW,
  ALL: (1 << BoxKind.HURT) | (1 << BoxKind.HIT) | (1 << BoxKind.PUSH) | (1 << BoxKind.THROW),
} as const;

// -----------------------------------------------------------------------------
// The F1 flag
// -----------------------------------------------------------------------------

let boxesOn = false;

export const debugBoxesOn = (): boolean => boxesOn;
export const setDebugBoxes = (on: boolean): void => {
  boxesOn = on;
};
/** What `Renderer.toggleDebugBoxes()` should call. Returns the new state. */
export const toggleDebugBoxes = (): boolean => {
  boxesOn = !boxesOn;
  return boxesOn;
};

let hotkeysAttached = false;

/**
 * Optional one-liner for `main.ts` while `ui/debug.ts` does not exist yet:
 * binds F1 to the toggle (and swallows the browser's own F1 help window, which
 * otherwise steals the key on Windows). Idempotent — calling it twice does not
 * double-toggle — and returns a detach function.
 *
 * If `ui/debug.ts` lands and owns the key table, delete the call site; the flag
 * API above is the real seam.
 */
export const attachDebugHotkeys = (
  target: EventTarget | null = typeof window === 'undefined' ? null : window,
  onToggle?: (on: boolean) => void,
): (() => void) => {
  if (target === null || hotkeysAttached) return () => undefined;
  hotkeysAttached = true;
  const handler = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.code !== 'F1' || e.repeat) return;
    e.preventDefault();
    const on = toggleDebugBoxes();
    onToggle?.(on);
  };
  target.addEventListener('keydown', handler);
  return () => {
    target.removeEventListener('keydown', handler);
    hotkeysAttached = false;
  };
};

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface DebugDrawOptions {
  /**
   * World units covered by one DEVICE pixel, so the outline keeps a constant
   * screen weight through the camera's 0.80..1.30 zoom range. The renderer has
   * it as `(right - left) / viewport.w`. Defaults to 1 (correct at zoom 1 on a
   * 1920-wide, dpr-1 buffer).
   */
  readonly worldPerPixel?: number;
  /** Outline weight in device pixels. */
  readonly lineWidthPx?: number;
  readonly fillAlpha?: number;
  readonly edgeAlpha?: number;
  /** Bitmask of DEBUG_KIND_BIT. */
  readonly kinds?: number;
  /** Draw even when the F1 flag is off. */
  readonly force?: boolean;
  /** Sort key written into the instances. The overlay draws last regardless. */
  readonly z?: number;
  /** Also mark each fighter's origin (feet centre, ground line). */
  readonly origins?: boolean;
}

const DEFAULTS = {
  worldPerPixel: 1,
  lineWidthPx: 2,
  fillAlpha: 0.14,
  edgeAlpha: 0.95,
  kinds: DEBUG_KIND_BIT.ALL,
  force: false,
  z: 0,
  origins: true,
};

// -----------------------------------------------------------------------------
// FX -> world rectangle
// -----------------------------------------------------------------------------

/**
 * Fighter-local FX box -> world float rectangle.
 *
 * Fighter-local boxes are FACING-RELATIVE: +x is forward. Facing right, the
 * box's near edge is `posX + b.x`; facing left, the whole box mirrors about the
 * origin, so the near edge becomes `posX - b.x - b.w`. All of that is integer
 * arithmetic on the sim's own numbers; `px()` runs last, once per edge.
 */
const rectX = (bx: FX, bw: FX, posX: FX, facing: Facing): number =>
  px(facing === 1 ? posX + bx : posX - bx - bw);

const emitRect = (
  out: InstanceWriter,
  x: number, y: number, w: number, h: number,
  color: number, fillAlpha: number, edgeAlpha: number, edge: number, z: number,
): number => {
  if (!(w > 0) || !(h > 0)) return 0;
  let n = 0;
  if (fillAlpha > 0) {
    writeQuad(out, x, y, w, h, color, fillAlpha, z);
    n++;
  }
  if (edgeAlpha > 0 && edge > 0) {
    // Clamped so a box thinner than two outlines still renders as a solid bar
    // instead of inverting — the outline is always INSIDE the box.
    const t = Math.min(edge, w * 0.5, h * 0.5);
    writeQuad(out, x, y, w, t, color, edgeAlpha, z);
    writeQuad(out, x, y + h - t, w, t, color, edgeAlpha, z);
    n += 2;
    const midH = h - 2 * t;
    if (midH > 0) {
      writeQuad(out, x, y + t, t, midH, color, edgeAlpha, z);
      writeQuad(out, x + w - t, y + t, t, midH, color, edgeAlpha, z);
      n += 2;
    }
  }
  return n;
};

const emitBox = (
  out: InstanceWriter,
  b: FxBox, posX: FX, posY: FX, facing: Facing,
  color: number, fillAlpha: number, edgeAlpha: number, edge: number, z: number,
): number =>
  emitRect(
    out,
    rectX(b.x, b.w, posX, facing),
    px(posY + b.y),
    px(b.w),
    px(b.h),
    color, fillAlpha, edgeAlpha, edge, z,
  );

// -----------------------------------------------------------------------------
// Which boxes a fighter has RIGHT NOW
//
// This mirrors the rule sim/collision.ts gathers with: an action's dense
// CompiledFrame owns the boxes while it is playing, and otherwise the boxes
// come from the character's stance set. If collision.ts ever diverges from
// this, F1 is the file that will show it — reconcile here, not by eyeballing.
// -----------------------------------------------------------------------------

/** The dense compiled frame a fighter is playing, or null when it is not in one. */
export const currentActionFrame = (s: SimState, p: PlayerIx): CompiledFrame | null => {
  const f = s.fighter(p);
  if (f.state !== S.ACTION) return null;
  const mv = charOf(s, p).moves[f.action];
  if (mv == null) return null;
  return mv.frames[f.actionFrame] ?? null;
};

const isAirborne = (flags: number, state: S): boolean =>
  (flags & FF.AIRBORNE) !== 0 ||
  state === S.JUMP_RISE || state === S.JUMP_FALL ||
  state === S.HITSTUN_AIR || state === S.BLOCKSTUN_AIR;

const isCrouching = (flags: number, state: S): boolean =>
  (flags & FF.CROUCHING) !== 0 ||
  state === S.CROUCH || state === S.HITSTUN_CROUCH || state === S.BLOCKSTUN_CROUCH;

/** The stance hurtboxes for a fighter that is not inside a move. */
const stanceHurt = (s: SimState, p: PlayerIx): readonly FxBox[] => {
  const f = s.fighter(p);
  const c = charOf(s, p);
  if (isAirborne(f.flags, f.state)) return c.airHurt;
  if (isCrouching(f.flags, f.state)) return c.crouchHurt;
  return c.standHurt;
};

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

/**
 * Pushes the overlay for one fighter. Bind a SOLID material on the batch first
 * (`batch.use(batch.solidMaterial)`), or use `drawDebugBoxes` below.
 * Returns the instance count written.
 */
export const emitFighterBoxes = (out: InstanceWriter, s: SimState, p: PlayerIx, o: DebugDrawOptions = {}): number => {
  const worldPerPixel = o.worldPerPixel ?? DEFAULTS.worldPerPixel;
  const edge = (o.lineWidthPx ?? DEFAULTS.lineWidthPx) * worldPerPixel;
  const fillAlpha = o.fillAlpha ?? DEFAULTS.fillAlpha;
  const edgeAlpha = o.edgeAlpha ?? DEFAULTS.edgeAlpha;
  const kinds = o.kinds ?? DEFAULTS.kinds;
  const z = o.z ?? DEFAULTS.z;

  const f = s.fighter(p);
  const posX = f.posX;
  const posY = f.posY;
  const facing = f.facing;
  const frame = currentActionFrame(s, p);
  let n = 0;

  // Painter order: body, then what can be hit, then what hits. The class you
  // most need to read ends up on top.
  if ((kinds & DEBUG_KIND_BIT.PUSH) !== 0) {
    n += emitRect(
      out,
      rectX(f.pushX, f.pushW, posX, facing),
      px(posY + f.pushY),
      px(f.pushW),
      px(f.pushH),
      DEBUG_BOX_COLOR[BoxKind.PUSH], fillAlpha, edgeAlpha, edge, z,
    );
  }

  if ((kinds & DEBUG_KIND_BIT.HURT) !== 0) {
    const hurt = frame !== null ? frame.hurt : stanceHurt(s, p);
    for (let i = 0; i < hurt.length; i++) {
      n += emitBox(out, hurt[i]!, posX, posY, facing, DEBUG_BOX_COLOR[BoxKind.HURT], fillAlpha, edgeAlpha, edge, z);
    }
  }

  if (frame !== null && (kinds & DEBUG_KIND_BIT.HIT) !== 0) {
    for (let i = 0; i < frame.hit.length; i++) {
      n += emitBox(out, frame.hit[i]!.box, posX, posY, facing, DEBUG_BOX_COLOR[BoxKind.HIT], fillAlpha, edgeAlpha, edge, z);
    }
  }

  if (frame !== null && (kinds & DEBUG_KIND_BIT.THROW) !== 0) {
    for (let i = 0; i < frame.throwBox.length; i++) {
      n += emitBox(out, frame.throwBox[i]!.box, posX, posY, facing, DEBUG_BOX_COLOR[BoxKind.THROW], fillAlpha, edgeAlpha, edge, z);
    }
  }

  if (o.origins ?? DEFAULTS.origins) {
    // A cross on the ground line at the fighter's origin, plus a tick pointing
    // the way it faces. These are SOLID FILLS (edge width 0 draws nothing), and
    // they are the control for the box transform: if the boxes hug the limbs but
    // this sits off the feet, the bug is in posX/posY, not in the box maths.
    const ox = px(posX);
    const oy = px(posY);
    const arm = 14;
    const t = Math.max(edge, 1);
    const a = DEBUG_ORIGIN_ALPHA;
    n += emitRect(out, ox - arm, oy - t * 0.5, arm * 2, t, DEBUG_ORIGIN_COLOR, a, 0, 0, z);
    n += emitRect(out, ox - t * 0.5, oy - arm * 0.5, t, arm * 1.5, DEBUG_ORIGIN_COLOR, a, 0, 0, z);
    n += emitRect(
      out,
      facing === 1 ? ox + arm * 0.4 : ox - arm,
      oy + arm,
      arm * 0.6,
      t,
      DEBUG_ORIGIN_COLOR, a, 0, 0, z,
    );
  }

  return n;
};

/**
 * Both fighters. Returns 0 immediately when F1 is off, so a renderer may call
 * it unconditionally every frame.
 */
export const emitDebugBoxes = (out: InstanceWriter, s: SimState, o: DebugDrawOptions = {}): number => {
  if (!boxesOn && (o.force ?? DEFAULTS.force) !== true) return 0;
  return emitFighterBoxes(out, s, 0, o) + emitFighterBoxes(out, s, 1, o);
};

/** Bind, emit, flush. The renderer's one-liner for the overlay pass. */
export const drawDebugBoxes = (batch: QuadBatch, s: SimState, o: DebugDrawOptions = {}): void => {
  if (!boxesOn && (o.force ?? DEFAULTS.force) !== true) return;
  batch.use(batch.solidMaterial);
  emitDebugBoxes(batch, s, o);
  batch.flush();
};

// -----------------------------------------------------------------------------
// F3 frame-data readout (text only — ui/font.ts draws it)
// -----------------------------------------------------------------------------

/** S in declaration order. Asserted against S.STATE_COUNT at load. */
const STATE_NAMES: readonly string[] = [
  'STAND', 'CROUCH', 'WALK_F', 'WALK_B', 'DASH_F', 'DASH_B',
  'JUMP_SQUAT', 'JUMP_RISE', 'JUMP_FALL', 'LANDING',
  'ACTION',
  'HITSTUN_STAND', 'HITSTUN_CROUCH', 'HITSTUN_AIR',
  'BLOCKSTUN_STAND', 'BLOCKSTUN_CROUCH', 'BLOCKSTUN_AIR',
  'KNOCKDOWN', 'WAKEUP', 'THROW_HOLD', 'THROWN',
  'KO', 'ROUND_FREEZE', 'INTRO', 'WIN_POSE',
];

/**
 * One line of frame data for the F3 overlay.
 *
 * `startup`, `activeFirst`, `activeLast`, `advHit` and `advBlock` are already
 * DERIVED on every CompiledMove by data/compile.ts, so this reads them. It must
 * never recompute them: a readout that disagrees with the number the engine
 * uses is worse than no readout.
 */
export const frameDataLine = (s: SimState, p: PlayerIx): string => {
  const f = s.fighter(p);
  const c = charOf(s, p);
  const state = STATE_NAMES[f.state] ?? `S${f.state}`;
  const head =
    `P${p + 1} ${c.name} ${state} f${f.stateFrame} hp${f.hp}` +
    `${f.hitstop > 0 ? ` STOP${f.hitstop}` : ''}` +
    `${f.hitstun > 0 ? ` STUN${f.hitstun}` : ''}` +
    `${f.blockstun > 0 ? ` BLK${f.blockstun}` : ''}`;

  const mv = c.moves[f.action];
  if (mv == null) return head;

  const name = c.def.moves.find((m) => m.id === f.action)?.name ?? `move${f.action}`;
  const active = mv.activeFirst < 0 ? '-' : `${mv.activeFirst + 1}-${mv.activeLast + 1}`;
  const recovery = mv.activeLast < 0 ? mv.totalFrames : mv.totalFrames - 1 - mv.activeLast;
  const sign = (v: number): string => (v >= 0 ? `+${v}` : String(v));

  return (
    `${head} | ${name} ${f.actionFrame + 1}/${mv.totalFrames}` +
    ` startup ${mv.startup} active ${active} rec ${recovery}` +
    ` onHit ${sign(mv.advHit)} onBlock ${sign(mv.advBlock)}`
  );
};

if (STATE_NAMES.length !== S.STATE_COUNT) {
  console.warn(
    `[sunforce] gfx/debugdraw: STATE_NAMES has ${STATE_NAMES.length} entries but S.STATE_COUNT is ${S.STATE_COUNT}`,
  );
}

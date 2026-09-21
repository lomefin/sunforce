// =============================================================================
// SunForce — src/data/chars/common.ts
// Shared defaults for the roster. Character A is authored longhand in a.ts
// because it is the reference example docs/MOVE-FORMAT.md locks; characters
// B–F are differentiated FROM these baselines, so the one thing that must never
// happen — six agents each inventing their own idea of what a punch feels like —
// cannot.
//
// Everything here is AUTHORING data: concept-space pixels, world units, and
// decimals are all fine. src/data/compile.ts converts once at load and the
// validator asserts every compiled number is an integer. The float ban applies
// to src/sim/** only.
//
// WHAT IS SHARED AND WHAT IS NOT
//   Shared: the impact numbers (hitstop, hitstun, blockstun, counter bonuses,
//     knockback, pushback, sparks, shake) and the stick rig's proportions.
//   NOT shared: reach, startup, active and recovery frames, walk and dash
//     speeds, weight, pushbox width. With two buttons and identical HP, THOSE
//     are the entire axis of character identity — if a character overrides the
//     impact table instead of its frame data, it is being differentiated on the
//     wrong axis and the roster will read as palette swaps.
// =============================================================================

import {
  BLOCKSTUN_KICK, BLOCKSTUN_PUNCH, Bone, CTR_DAMAGE_PCT, CTR_HITSTOP_BONUS,
  CTR_HITSTUN_KICK, CTR_HITSTUN_PUNCH, G, Gd, HITSTOP_BLOCK_KICK, HITSTOP_BLOCK_PUNCH,
  HITSTOP_KICK, HITSTOP_PUNCH, HITSTUN_KICK, HITSTUN_PUNCH, On, Rx, S, SfxId,
  SparkId, THROW_TECH_WINDOW,
} from '@/core/contracts';
import type {
  CancelRule, ConceptSpace, HitProps, JiggleDef, PhysicsDef, StickDef, ThrowProps,
} from '@/core/contracts';

// -----------------------------------------------------------------------------
// CONCEPT SPACE
// -----------------------------------------------------------------------------

/**
 * Character A's measured sheet, and the PLACEHOLDER space for every character
 * whose concept sheet does not exist yet (B, C, E, F).
 *   originX 302   the crotch vertex of caporal.svg's #legs
 *   groundY 858   the #ground-shadow ellipse cy
 *   unitsPerPx .5 756 drawn pixels -> 378 world units == FIGHTER_HEIGHT
 * Boxes authored against this transfer UNCHANGED the day a real sheet lands,
 * because the sheet will be drawn to the same 640x960 frame and ground line.
 */
export const CAPORAL_SPACE: ConceptSpace = {
  w: 640, h: 960, originX: 302, groundY: 858, unitsPerPx: 0.5,
};

/** Character D's sheet. tobas.svg's ground line sits one pixel higher. */
export const TOBAS_SPACE: ConceptSpace = {
  w: 640, h: 960, originX: 302, groundY: 857, unitsPerPx: 0.5,
};

// -----------------------------------------------------------------------------
// STATE MASKS — `MoveDef.stateMask` is a bitmask of the S.* a move may START
// from. S.ACTION is included wherever a move is allowed to come out of a cancel
// window, because during a cancel the fighter is still in S.ACTION.
// -----------------------------------------------------------------------------

/** Standing normals: neutral, walking, running, and out of a cancel. */
export const STAND_MASK =
  (1 << S.STAND) | (1 << S.WALK_F) | (1 << S.WALK_B) | (1 << S.DASH_F) | (1 << S.ACTION);

/** Crouching normals. */
export const CROUCH_MASK = (1 << S.CROUCH) | (1 << S.ACTION);

/** Air normals. */
export const AIR_MASK = (1 << S.JUMP_RISE) | (1 << S.JUMP_FALL) | (1 << S.ACTION);

// DELIBERATE, LOAD-BEARING OMISSION: S.JUMP_SQUAT and S.LANDING appear in NO
// mask above, and must not be added.
//   - jump squat absent  => a jump is a COMMITMENT. You cannot start or cancel
//     a move out of it, which is exactly why it is throwable and punishable and
//     why the 4 frames of crouch are a real tell the opponent can react to.
//   - landing absent     => landing recovery is REAL. It is what makes a badly
//     spaced jump-in punishable instead of free.
// "Fixing" either by adding it to STAND_MASK silently deletes a core mechanic.


/** Throws: grounded and never out of a cancel — a throw is a read, not a link. */
export const THROW_MASK = (1 << S.STAND) | (1 << S.WALK_F) | (1 << S.WALK_B);

// -----------------------------------------------------------------------------
// THE IMPACT TABLE — docs/FEEL-NUMBERS.md, locked.
//
// `blockPushX > kbX` on BOTH buttons is the single most important line in this
// file: blockstrings push you out and end, confirmed hits keep you close and
// combo. That one inequality is the whole offence/defence loop, and it is also
// exactly why throws have to exist — without them, holding back is strictly
// dominant. Do not "balance" a character by narrowing it.
//
// Hitstop is SYMMETRIC (attacker and defender freeze for the same count), which
// is what makes frame advantage arithmetic: adv = stun - (total - 1 - firstActive).
// -----------------------------------------------------------------------------

/** Every field of a punch except its box. damage is pinned to 50 by THE RULE. */
export const PUNCH_PROPS: HitProps = {
  damage: 50,
  guard: Gd.MID,
  hitstun: HITSTUN_PUNCH,
  blockstun: BLOCKSTUN_PUNCH,
  hitstop: HITSTOP_PUNCH,
  blockHitstop: HITSTOP_BLOCK_PUNCH,
  ctrBonusHitstun: CTR_HITSTUN_PUNCH,
  ctrBonusHitstop: CTR_HITSTOP_BONUS,
  ctrDamagePct: CTR_DAMAGE_PCT,
  kbX: 2.4,
  kbY: 0,
  blockPushX: 3.0,
  selfPushBlock: 1.0,
  selfPushHit: 0,
  reaction: Rx.STAND,
  juggleLimit: 5,
  juggleCost: 1,
  hitId: 1,
  sfx: SfxId.HIT_LIGHT,
  blockSfx: SfxId.GUARD_LIGHT,
  spark: SparkId.IMPACT_S,
  shakeAmp: 5,
  shakeFrames: 7,
  chroma: 0,
};

/** Every field of a kick except its box. damage is pinned to 100 by THE RULE. */
export const KICK_PROPS: HitProps = {
  damage: 100,
  guard: Gd.MID,
  hitstun: HITSTUN_KICK,
  blockstun: BLOCKSTUN_KICK,
  hitstop: HITSTOP_KICK,
  blockHitstop: HITSTOP_BLOCK_KICK,
  ctrBonusHitstun: CTR_HITSTUN_KICK,
  ctrBonusHitstop: CTR_HITSTOP_BONUS,
  ctrDamagePct: CTR_DAMAGE_PCT,
  kbX: 4.6,
  kbY: 0,
  blockPushX: 5.2,
  selfPushBlock: 2.2,
  selfPushHit: 0,
  reaction: Rx.STAND,
  juggleLimit: 3,
  juggleCost: 2,
  hitId: 1,
  // Chromatic aberration is reserved for kicks so it stays special.
  sfx: SfxId.HIT_HEAVY,
  blockSfx: SfxId.GUARD_HEAVY,
  spark: SparkId.IMPACT_L,
  shakeAmp: 12,
  shakeFrames: 11,
  chroma: 3.5,
};

/** Throws are kick-equivalent, so "punch 50 / kick 100" stays literally true. */
export const THROW_PROPS: ThrowProps = {
  damage: 100,
  techWindow: THROW_TECH_WINDOW,
  holdFrames: 14,
  kbX: 3.0,
  kbY: 5.5,
  reaction: Rx.SWEEP,
  hitsAir: false,
  sfx: SfxId.THROW_GRAB,
  spark: SparkId.GRAB,
};

/** Anything but `damage`, which THE RULE fixes at 50 for P and 100 for K. */
export type HitOverrides = Partial<Omit<HitProps, 'damage'>>;
export type ThrowOverrides = Partial<Omit<ThrowProps, 'damage'>>;

/** A punch's properties with per-move deviations (reach-driven knockback, a low
 *  guard on a 2K, a different reaction). `damage` cannot be overridden. */
export const punchProps = (over: HitOverrides = {}): HitProps => ({
  ...PUNCH_PROPS, ...over, damage: 50,
});

export const kickProps = (over: HitOverrides = {}): HitProps => ({
  ...KICK_PROPS, ...over, damage: 100,
});

export const throwProps = (over: ThrowOverrides = {}): ThrowProps => ({
  ...THROW_PROPS, ...over, damage: 100,
});

// -----------------------------------------------------------------------------
// CANCELS — declarative, and the currency of offence.
// -----------------------------------------------------------------------------

/**
 * The standard normal-into-normal gatling: cancellable on hit or block from the
 * first active frame through the end of the cancel window. `from` should be the
 * move's first active frame, `to` a few frames into its recovery.
 */
export const gatling = (from: number, to: number, into: number = G.PUNCH | G.KICK | G.SPECIAL): CancelRule => ({
  window: [from, to], on: On.HIT | On.BLOCK, into,
});

/** Hit-confirm-only routes: jump cancels and throw cancels never work on block. */
export const onHitOnly = (from: number, to: number, into: number): CancelRule => ({
  window: [from, to], on: On.HIT, into,
});

// -----------------------------------------------------------------------------
// PHYSICS — character A's numbers are the baseline the roster is tuned against.
// Verified by integration: jumpVelY 24.2 with gravity 1.10 gives 45 airborne
// frames and a 278-unit apex, a 52-frame total cycle with 4f squat and 3f
// landing recovery.
// -----------------------------------------------------------------------------
export const BASE_PHYSICS: PhysicsDef = {
  walkF: 4.0,
  walkB: 3.4,
  dashSpeed: 18.0,
  dashFrames: 22,
  backDashSpeed: 15.0,
  backDashFrames: 20,
  // A step dash is the default; A and C run instead.
  runDash: false,
  jumpSquat: 4,
  jumpVelY: 24.2,
  jumpVelXF: 5.0,
  jumpVelXB: 4.4,
  gravity: 1.1,
  airDrag: 1.0,
  groundFriction: 0.84,
  airJumps: 0,
  weightPct: 100,
  landingLag: 3,
};

// -----------------------------------------------------------------------------
// THE SHARED STICK RIG
// -----------------------------------------------------------------------------

/** Capsule radii in world units, indexed by Bone. Length BONE_COUNT. */
export const BASE_RADII: readonly number[] = [
  0, 13, 12, 14, 7, 17, 0,
  8, 8, 6, 5,
  8, 8, 6, 5,
  10, 8, 6,
  10, 8, 6,
  0, 0, 0,
];

/**
 * Bone rest pose in CONCEPT pixels, measured off caporal.svg, in Bone order.
 * B/F are assigned for facing = +1: the sheet's screen-LEFT limb (x < originX)
 * is the BACK limb. Characters without a sheet start from this and move the
 * joints their silhouette needs.
 */
export const BASE_REST_POSE: readonly (readonly [number, number])[] = [
  [302, 858], [302, 470], [302, 400], [302, 300], [302, 268], [302, 220], [300, 136],
  [214, 320], [214, 320], [200, 450], [196, 548],
  [390, 320], [390, 320], [406, 450], [394, 544],
  [270, 466], [266, 650], [266, 830],
  [340, 466], [340, 650], [356, 830],
  [302, 320], [300, 136], [302, 470],
];

/** Radii + ink weight, shared. Palette and accessory proxies are per character. */
export const BASE_STICK: Omit<StickDef, 'palette' | 'accessories'> = {
  radii: BASE_RADII,
  outline: 3,
};

/**
 * Jiggle springs on the three accessory bones. These are presentation-only and
 * they are NOT optional decoration: the accessory bones are what carry this
 * game's art direction, and a costume that does not move on its own is most of
 * the difference between a rig and a character.
 */
export const BASE_JIGGLE: readonly JiggleDef[] = [
  { bone: Bone.ACC0, stiffness: 0.35, damping: 0.78, limit: 22 },
  { bone: Bone.ACC1, stiffness: 0.28, damping: 0.8, limit: 14 },
  { bone: Bone.ACC2, stiffness: 0.42, damping: 0.72, limit: 26 },
];

/** Ink and rim are shared; base and accent come off each character's own sheet. */
export const BASE_INK = 0x07060f;
export const BASE_RIM = 0xffd9a0;

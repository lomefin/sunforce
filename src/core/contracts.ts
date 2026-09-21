// =============================================================================
// SunForce — src/core/contracts.ts
// THE INTEGRATION CONTRACT. Written first, frozen, imported by every module.
//
// VERIFIED: this file compiles clean (exit 0) under the project's exact
// tsconfig.json — strict, noUncheckedIndexedAccess, isolatedModules,
// verbatimModuleSyntax, noUnusedLocals, noUnusedParameters.
//
// RULES FOR THIS FILE:
//   1. TYPES, ENUMS and CONST TABLES ONLY. No function bodies, no `declare
//      function`. Cross-module functions are expressed as function TYPES
//      (e.g. `StepFn`) so an implementing module writes
//      `export const step: StepFn = (s, i0, i1) => { ... }` and the compiler
//      proves the signature. Nothing here has a runtime import cycle.
//   2. It has ZERO imports. It is the root of the dependency graph.
//   3. Changing it requires re-running `npm run typecheck` across all modules.
//
// PROJECT TSCONFIG IS STRICT: `noUncheckedIndexedAccess` is ON. Indexing an
// array or a typed array yields `T | undefined`. In sim hot loops use `arr[i]!`.
//
// COORDINATE SYSTEMS — there are exactly two, and they never mix.
//
//   CONCEPT SPACE (authoring):  the 640x960 viewBox of concept/<char>.svg.
//     x right, y DOWN, absolute, origin at the sheet's top-left.
//     Boxes, bone rest poses and part pivots are ALL authored here, so a
//     designer reads numbers straight off the artwork. Type: ConceptBox.
//
//   WORLD SPACE (runtime):  fixed-point, x right, y UP, ground at y = 0.
//     Fighter-local boxes are FACING-RELATIVE: +x is always FORWARD.
//     Type: FxBox. Produced ONLY by src/data/compile.ts.
//
//   Conversion (compile.ts, once at load, never per-frame):
//     localX = (cx - cs.originX) * cs.unitsPerPx      // +x forward
//     localY = (cs.groundY - cy) * cs.unitsPerPx      // +y up, 0 = ground
//     then * ONE and truncate to an integer.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. FIXED POINT
// -----------------------------------------------------------------------------

/**
 * A fixed-point scalar. ALWAYS an integer. 1 world unit = ONE (256) FX units.
 *
 * EXACTNESS PROOF (do not "optimise" this away):
 *   IEEE-754 doubles represent every integer < 2^53 exactly. Our largest
 *   operand is posX ~= 3600*256 ~= 2^19.8; scalars are < 2^16. Products stay
 *   below 2^36 < 2^53, so `(a*b)` is exact and `((a*b)/ONE)|0` is exact.
 *
 * MIRROR SAFETY (load-bearing — see tests/mirror.test.ts):
 *   `|0` truncates toward ZERO, so trunc(-x) === -trunc(x). This is the ONLY
 *   reason knockback decays identically leftward and rightward. Measured: at
 *   kbX = 1179 with 88% decay, `|0` gives +-1036 (symmetric) while `>>8` gives
 *   1036 / -1037 (asymmetric). Replacing `((a*b)/256)|0` with `(a*b)>>8`
 *   silently breaks side parity across the entire game. DO NOT DO IT.
 */
export type FX = number;

export const ONE: FX = 256;
export const HALF: FX = 128;

/** Signatures for src/core/fixed.ts. */
export interface FixedMath {
  /** world units (may be fractional) -> FX. Authoring/compile only. */
  fx(units: number): FX;
  /** FX -> float world units. PRESENTATION ONLY. Never called from src/sim. */
  px(v: FX): number;
  /** ((a*b)/ONE)|0 — exact, mirror-safe. */
  fxMul(a: FX, b: FX): FX;
  /** ((a*ONE)/b)|0 */
  fxDiv(a: FX, b: FX): FX;
  fxAbs(a: FX): FX;
  fxSign(a: FX): -1 | 0 | 1;
  fxClamp(v: FX, lo: FX, hi: FX): FX;
  /** ((v*pct)/100)|0 — percentage scaling, mirror-safe. */
  fxPct(v: FX, pct: number): FX;
}

/** 1024-entry table, round(sin(i/1024 * 2pi) * 65536). Build-generated. */
export type SinTable = Int32Array;

// -----------------------------------------------------------------------------
// 2. INTERNED IDS — the sim contains no strings, ever.
// -----------------------------------------------------------------------------

export enum CharId { A = 0, B = 1, C = 2, D = 3, E = 4, F = 5 }
export const CHAR_COUNT = 6;

export enum StageId {
  STAGE_1 = 0, STAGE_2, STAGE_3, STAGE_4, STAGE_5, STAGE_6,
}
export const STAGE_COUNT = 6;

/**
 * Every move in the game. Interned integers so state hashes are stable across
 * machines (a glob-ordered registry is NOT stable — this enum is).
 * Naming: <CHAR>_<notation>. 5=standing, 2=crouching, J=air.
 */
export enum MoveId {
  NONE = 0,
  A_5P, A_5K, A_2P, A_2K, A_JP, A_JK, A_THROW,
  B_5P, B_5K, B_2P, B_2K, B_JP, B_JK, B_THROW,
  C_5P, C_5K, C_2P, C_2K, C_JP, C_JK, C_THROW,
  D_5P, D_5K, D_2P, D_2K, D_JP, D_JK, D_THROW,
  E_5P, E_5K, E_2P, E_2K, E_JP, E_JK, E_THROW,
  F_5P, F_5K, F_2P, F_2K, F_JP, F_JK, F_THROW,
  MOVE_COUNT,
}

/**
 * Presentation-only animation clip ids. The sim never reads these.
 *
 * HIT_STAND vs HIT_STAND_HARD: the sim stores no hit "severity" — but it does
 * not need to. On the frame a hit lands, `hitstun` is set to N and `stateFrame`
 * is reset to 0; thereafter both tick together inside the hitstop gate, so
 *     hitstun + stateFrame === N
 * holds for the whole reaction and the ORIGINAL hitstun is recoverable by
 * presentation at any frame. Punch is 16, kick 21 (counter-hit 22 / 29), so a
 * threshold of 19 separates light from heavy and correctly promotes a
 * counter-hit jab to the heavy reaction. No sim state, no hash change.
 */
export enum AnimId {
  NONE = 0,
  IDLE, CROUCH, WALK_F, WALK_B, DASH_F, DASH_B,
  JUMP_SQUAT, JUMP_RISE, JUMP_FALL, LAND,
  HIT_STAND, HIT_STAND_HARD, HIT_CROUCH, HIT_AIR, BLOCK_STAND, BLOCK_CROUCH, BLOCK_AIR,
  KNOCKDOWN, WAKEUP, KO, WIN, INTRO,
  ATK_5P, ATK_5K, ATK_2P, ATK_2K, ATK_JP, ATK_JK, ATK_THROW, THROW_HELD,
  ANIM_COUNT,
}

export enum SfxId {
  NONE = 0,
  HIT_LIGHT, HIT_HEAVY, HIT_COUNTER, GUARD_LIGHT, GUARD_HEAVY,
  WHIFF_LIGHT, WHIFF_HEAVY, LAND, DASH, JUMP, BELL,
  THROW_GRAB, THROW_TECH, KO, ROUND_START, WALL_HIT, ARMOR, JUGGLE_DENY,
  SFX_COUNT,
}

export enum SparkId {
  NONE = 0, IMPACT_S, IMPACT_L, IMPACT_CH, GUARD_S, GUARD_L, GRAB, DUST, KO_BURST,
}

// -----------------------------------------------------------------------------
// 3. BITFLAG SETS (as const objects — safe under isolatedModules)
// -----------------------------------------------------------------------------

/** Button / direction bits. Directions are ABSOLUTE (L/R as the device reports). */
export const B = {
  U: 1, D: 2, L: 4, R: 8,
  P: 16, K: 32, G: 64,
  TAUNT: 128, START: 256,
  /** Macro: P+K within THROW_MACRO_SLOP frames. Synthesised by input/buffer.ts. */
  THROW: 512,
} as const;
export type ButtonMask = number;

/** Move groups — the currency of cancels. */
export const G = {
  PUNCH: 1, KICK: 2, CMD_NORMAL: 4, SPECIAL: 8,
  JUMP: 16, DASH: 32, THROW: 64, MOVEMENT: 128,
  ALL: 255,
} as const;
export type GroupMask = number;

/** Cancel contact predicate. */
export const On = { HIT: 1, BLOCK: 2, WHIFF: 4, ALWAYS: 7 } as const;
export type OnMask = number;

/** Guard height requirement. */
export const Gd = {
  HIGH: 1,        // blocked standing only
  LOW: 2,         // blocked crouching only
  MID: 3,         // blocked either
  AIR_ONLY: 4,    // only connects vs airborne
  UNBLOCKABLE: 8, // throws
} as const;
export type GuardMask = number;

/** Persistent fighter flags (FighterView.flags). */
export const FF = {
  HIT_CONFIRMED: 1,     // this action's hitbox connected on hit
  BLOCK_CONFIRMED: 2,   // ...on block
  AIRBORNE: 4,
  CROUCHING: 8,
  FACING_LOCKED: 16,
  GUARD_BROKEN: 32,
  COUNTER_STATE: 64,    // set during startup frames; read by hits.commit
  THROW_IMMUNE: 128,    // wakeup frames 0-3, and during hitstun
  JUST_LANDED: 256,
  RUN_HELD: 512,
} as const;
export type FighterFlags = number;

/** Per-keyframe flags (Keyframe.flags). */
export const MF = {
  INVULN: 1, ARMOR: 2, AIRBORNE: 4, NO_GRAVITY: 8,
  LOW_PROFILE: 16, THROW_INVULN: 32, NO_TURN: 64,
} as const;
export type KeyframeFlags = number;

/** Motion command bits, produced by sim/commands.ts into FighterView.commandMask. */
export const Cmd = {
  QCF: 1, QCB: 2, DP: 4, RDP: 8, CHARGE_B: 16, CHARGE_D: 32, HCF: 64,
} as const;
export type CmdMask = number;

// -----------------------------------------------------------------------------
// 4. ENUMS THE WHOLE ENGINE CODES AGAINST
// -----------------------------------------------------------------------------

/** Physical state. Owns physics, collision behaviour, and what input is legal. */
export enum S {
  STAND = 0, CROUCH, WALK_F, WALK_B, DASH_F, DASH_B,
  JUMP_SQUAT, JUMP_RISE, JUMP_FALL, LANDING,
  ACTION,                    // a MoveDef timeline owns boxes + velocity
  HITSTUN_STAND, HITSTUN_CROUCH, HITSTUN_AIR,
  BLOCKSTUN_STAND, BLOCKSTUN_CROUCH, BLOCKSTUN_AIR,
  KNOCKDOWN, WAKEUP,
  THROW_HOLD,                // attacker holding a throw
  THROWN,                    // defender being thrown
  KO, ROUND_FREEZE, INTRO, WIN_POSE,
  STATE_COUNT,
}

/** How the defender reacts to a hit. */
export enum Rx {
  STAND = 0, CROUCH, LAUNCH, SWEEP, STAGGER, WALL_BOUNCE, GROUND_BOUNCE, CRUMPLE,
}

/** Contact result of the CURRENT action (FighterView.lastContact). */
export enum Contact { NONE = 0, HIT = 1, BLOCK = 2, ARMORED = 3 }

/** Box classes. There are exactly four. */
export enum BoxKind { HURT = 0, HIT = 1, PUSH = 2, THROW = 3 }

/** Round phase (GlobalView.roundState). */
export enum RoundState { INTRO = 0, FIGHT, KO, ROUND_END, MATCH_END }

/** Sim -> presentation event codes. */
export enum Ev {
  HIT = 0, BLOCK, WHIFF, COUNTER, ARMOR_ABSORB, JUGGLE_DENY,
  THROW_START, THROW_TECH, THROW_LAND,
  LAND, JUMP, DASH, WALL_HIT, KNOCKDOWN, WAKEUP,
  KO, ROUND_START, ROUND_END, MATCH_END, COMBO_END,
  /** Two strikes met on the same frame: no damage, both shoved apart. */
  CLASH,
}

// -----------------------------------------------------------------------------
// 5. AUTHORING TYPES (concept space) — src/data/** only
// -----------------------------------------------------------------------------

/**
 * A box in CONCEPT SPACE: [x0, y0, x1, y1], absolute pixels of the 640x960
 * sheet, y DOWN, x0<x1, y0<y1. Read these straight off concept/<char>.svg.
 */
export type ConceptBox = readonly [x0: number, y0: number, x1: number, y1: number];

/** Per-character mapping from concept pixels to world units. */
export interface ConceptSpace {
  /** Sheet width/height. Always 640 x 960 today. */
  readonly w: 640;
  readonly h: 960;
  /** Concept x of the character's midline. caporal: 302 (crotch vertex). */
  readonly originX: number;
  /** Concept y of the ground line. caporal: 858 (#ground-shadow ellipse cy). */
  readonly groundY: number;
  /** World units per concept pixel. 0.5 => a 756px-tall sheet = 378 world units. */
  readonly unitsPerPx: number;
}

/** Properties of one connecting strike. Authored in world units (decimals OK). */
export interface HitProps {
  /** THE GAME RULE: punch 50, kick 100. Validator hard-rejects anything else. */
  readonly damage: 50 | 100;
  readonly guard: GuardMask;
  readonly hitstun: number;
  readonly blockstun: number;
  /** SYMMETRIC by contract: attacker and defender freeze for the same count, so
   *  frame advantage reduces to (hitstun - attackerFramesRemaining). The
   *  validator rejects asymmetric hitstop. */
  readonly hitstop: number;
  readonly blockHitstop: number;
  readonly ctrBonusHitstun: number;
  readonly ctrBonusHitstop: number;
  /** Counter-hit damage multiplier, percent. 125 = +25%. */
  readonly ctrDamagePct: number;
  /** Defender velocity on hit, world units/frame, facing-relative (+x = away). */
  readonly kbX: number;
  readonly kbY: number;
  /** Defender velocity on block. MUST be >= kbX (blockstrings push out). */
  readonly blockPushX: number;
  /** Attacker self-pushback on block, world units/frame (positive = backward). */
  readonly selfPushBlock: number;
  readonly selfPushHit: number;
  readonly reaction: Rx;
  /** This hit whiffs if the defender's juggleCount already exceeds it. */
  readonly juggleLimit: number;
  readonly juggleCost: number;
  /** One hitId connects at most once per action. 1..30. */
  readonly hitId: number;
  readonly sfx: SfxId;
  readonly blockSfx: SfxId;
  readonly spark: SparkId;
  /** Screen shake, presentation only. */
  readonly shakeAmp: number;
  readonly shakeFrames: number;
  /** Chromatic aberration pixels, presentation only. Kicks only by convention. */
  readonly chroma: number;
}

/** Properties of one connecting throw. Throws are unblockable and untechable
 *  after THROW_TECH_WINDOW frames. */
export interface ThrowProps {
  /** Kick-equivalent, so "punch 50 / kick 100" stays literally true. */
  readonly damage: 100;
  /** Frames the defender has to press THROW to break. */
  readonly techWindow: number;
  /** Frames the attacker holds before the toss resolves. */
  readonly holdFrames: number;
  readonly kbX: number;
  readonly kbY: number;
  readonly reaction: Rx;
  /** Air throws connect vs airborne; ground throws do not. */
  readonly hitsAir: boolean;
  readonly sfx: SfxId;
  readonly spark: SparkId;
}

/** One entry of a sparse timeline. `at` is an action frame, 0-based, ascending.
 *  Anything omitted is INHERITED from the previous keyframe. `hurt`/`hit`/
 *  `throwBox` REPLACE the previous set when present (use [] to clear). */
export interface Keyframe {
  readonly at: number;
  readonly hurt?: readonly ConceptBox[];
  readonly hit?: readonly { readonly box: ConceptBox; readonly props: HitProps }[];
  readonly throwBox?: readonly { readonly box: ConceptBox; readonly props: ThrowProps }[];
  readonly pushbox?: ConceptBox;
  /** SETS velocity, world units/frame, facing-relative. Omitted = unchanged. */
  readonly velX?: number;
  readonly velY?: number;
  /** Per-frame friction multiplier applied after velocity. 1 = none. */
  readonly friction?: number;
  readonly flags?: KeyframeFlags;
  readonly sfx?: SfxId;
}

/** "This move cancels into that group on hit between frames 6 and 14." */
export interface CancelRule {
  /** Inclusive action-frame window. */
  readonly window: readonly [number, number];
  readonly on: OnMask;
  readonly into: GroupMask;
  /** Optional explicit move whitelist; 0-length = any move in `into`. */
  readonly onlyMoves?: readonly MoveId[];
}

/**
 * Procedural pose fallback. Used by gfx/skin/anim.ts when no AnimClip exists
 * for `MoveDef.anim` — which is TRUE FOR EVERY MOVE ON DAY ONE. This is what
 * stops both fighters T-posing through the entire vertical slice.
 */
export interface PoseHint {
  /** Which limb drives the action. */
  readonly limb: 'armF' | 'armB' | 'legF' | 'legB' | 'body';
  /** Peak extension of that limb, world units forward from the shoulder/hip. */
  readonly reach: number;
  /** World units above ground the limb tip reaches at peak. */
  readonly height: number;
  /** Torso lean, degrees. Positive = forward. */
  readonly lean: number;
  /** Hip drop, world units. Positive = crouch. */
  readonly crouch: number;
  /** Extra rotation applied to accessory bones at peak, degrees. Sells plumes. */
  readonly accSwing: number;
}

export interface MoveDef {
  readonly id: MoveId;
  readonly name: string;
  readonly group: GroupMask;
  readonly input: {
    readonly button: ButtonMask;
    readonly command?: CmdMask;
    readonly negEdge?: true;
    /** Required directional hold, absolute-agnostic: 0 none, 2 down, 4 back, 6 fwd. */
    readonly dir?: 0 | 2 | 4 | 6;
  };
  /** Bitmask of S.* this move may START from: (1 << S.STAND) | ... */
  readonly stateMask: number;
  readonly totalFrames: number;
  /** timeline[0].at MUST be 0; `at` strictly ascending; last at < totalFrames. */
  readonly timeline: readonly Keyframe[];
  readonly cancels: readonly CancelRule[];
  /** Times this move may chain into ITSELF within one combo. 0 = never. */
  readonly selfChain: number;
  /** Frames of recovery added when an air move lands. */
  readonly landingRecovery?: number;
  /** Super-armor window (absorbs N hits, still takes damage, no hitstun). */
  readonly armor?: { readonly window: readonly [number, number]; readonly hits: number; readonly damagePct: number };
  readonly anim: AnimId;
  readonly poseHint: PoseHint;
}

/** Fighter physics, world units. */
export interface PhysicsDef {
  readonly walkF: number;
  readonly walkB: number;
  readonly dashSpeed: number;
  readonly dashFrames: number;
  readonly backDashSpeed: number;
  readonly backDashFrames: number;
  /** True run instead of a step dash (character C, A). */
  readonly runDash: boolean;
  readonly jumpSquat: number;
  readonly jumpVelY: number;
  readonly jumpVelXF: number;
  readonly jumpVelXB: number;
  readonly gravity: number;
  readonly airDrag: number;
  readonly groundFriction: number;
  /** Extra air jumps (D = 1). */
  readonly airJumps: number;
  /** Received knockback percent. 100 = normal, 78 = heavy. */
  readonly weightPct: number;
  readonly landingLag: number;
}

/**
 * Stick-figure skin description. Authored in CONCEPT SPACE so the stick rest
 * pose, the hitboxes and (later) the vector parts all share one frame.
 * ACCESSORY PROXIES ARE MANDATORY: without them nobody ever keys the bones
 * that carry this game's entire art direction.
 */
export interface StickDef {
  /** Limb capsule radii in world units, indexed by BONE. */
  readonly radii: readonly number[];
  /** Ink outline width, world units. */
  readonly outline: number;
  readonly palette: {
    readonly base: number;   // 0xRRGGBB
    readonly accent: number;
    readonly ink: number;
    readonly rim: number;
  };
  /**
   * Crude but POSABLE proxies for the accessory bones. Sized from the real
   * concept-sheet bounding boxes so the silhouette is honest from day one.
   * Each is bound to an ACC bone and inherits its transform + jiggle spring.
   */
  readonly accessories: readonly {
    readonly bone: Bone;
    readonly shape: 'brim' | 'fan' | 'plume' | 'apron' | 'bells' | 'horns' | 'shell' | 'skirt' | 'band' | 'puff';
    /** Proxy extent in CONCEPT pixels, relative to the bone's rest pivot. */
    readonly box: ConceptBox;
    /** Mirrored copy on the opposite side (plume-wings, puffs, horns). */
    readonly mirrored: boolean;
    readonly color: number;
  }[];
}

/** Presentation-only jiggle spring, applied to accessory bones. */
export interface JiggleDef {
  readonly bone: Bone;
  readonly stiffness: number;
  readonly damping: number;
  /** Max deflection, degrees. */
  readonly limit: number;
}

// -----------------------------------------------------------------------------
// TRAITS. One rating per axis, 100 = the baseline every authored number already
// describes, 80..120 = the band the roster lives in. They are NOT a second
// physics system: `data/compile.ts` folds them into the compiled numbers once,
// at build time, and the sim reads exactly the fields it always did. A roster of
// all-100 characters compiles byte-identically to one with no traits at all.
//
// WHY RATINGS AND NOT RAW NUMBERS. "Diablo hits 10% harder and slides 20% less"
// is a balance decision; `jumpVelY: 21.78` is its consequence. Keeping the
// decision in one legible place means retuning a character is one integer, and
// means the six can be compared down a column instead of by reading six
// physics blocks side by side.
// -----------------------------------------------------------------------------

export interface TraitsDef {
  /** Walk, dash and horizontal air speed. */
  readonly movement: number;
  /** Launch velocity. Apex scales with the SQUARE of this, air time linearly,
   *  so one rating moves both "how high" and "how long" — which is how a jump
   *  actually works. Floatiness is `PhysicsDef.gravity` and stays separate. */
  readonly jump: number;
  /** Damage dealt by punches — the 5P / 2P / JP family. */
  readonly punch: number;
  /** Damage dealt by kicks — the 5K / 2K / JK family. */
  readonly kick: number;
  /** MASS. Higher = harder to move: knockback received scales as 100/weight,
   *  so 120 slides 0.83x as far and 90 slides 1.11x. This is the number a
   *  clash divides by, which is why two kicks meeting push the lighter one
   *  further. */
  readonly weight: number;
  /** Recovery speed. Attack recovery scales as 100/stamina, so 105 is back to
   *  neutral 5% sooner and gets more hits into the same window. */
  readonly stamina: number;
}

/** The rating every authored number is already written for. */
export const TRAIT_BASE = 100;
/** The band the roster is balanced inside. The validator warns outside it. */
export const TRAIT_MIN = 80;
export const TRAIT_MAX = 120;

/** All-baseline. A character with these compiles to the authored numbers. */
export const NEUTRAL_TRAITS: TraitsDef = {
  movement: TRAIT_BASE, jump: TRAIT_BASE, punch: TRAIT_BASE,
  kick: TRAIT_BASE, weight: TRAIT_BASE, stamina: TRAIT_BASE,
};

export interface CharDef {
  readonly id: CharId;
  readonly name: string;
  readonly dance: string;
  /** THE GAME RULE. */
  readonly hp: 1000;
  readonly conceptSpace: ConceptSpace;
  /** Ratings, folded into `physics` and into move damage by data/compile.ts.
   *  The `physics` block below is always the BASELINE, written as if 100. */
  readonly traits: TraitsDef;
  readonly physics: PhysicsDef;
  readonly standPush: ConceptBox;
  readonly crouchPush: ConceptBox;
  readonly airPush: ConceptBox;
  readonly standHurt: readonly ConceptBox[];
  readonly crouchHurt: readonly ConceptBox[];
  readonly airHurt: readonly ConceptBox[];
  /** Bone rest pose in CONCEPT pixels. Length BONE_COUNT. */
  readonly restPose: readonly (readonly [x: number, y: number])[];
  /** PRIORITY ORDER for move matching. Data, never object-key order. */
  readonly moveOrder: readonly MoveId[];
  readonly moves: readonly MoveDef[];
  readonly stick: StickDef;
  readonly jiggle: readonly JiggleDef[];
  /** Vector skin assets. Absent until that character's sheet is baked. */
  readonly parts?: { readonly manifest: string };
}

// -----------------------------------------------------------------------------
// 6. COMPILED TYPES (world space, all-integer) — produced by data/compile.ts,
//    consumed read-only by the sim. NOTHING in src/sim reads an authoring type.
// -----------------------------------------------------------------------------

/** Fighter-local box in FX. +x FORWARD, +y UP, origin = feet centre on ground. */
export interface FxBox { readonly x: FX; readonly y: FX; readonly w: FX; readonly h: FX }

export interface CompiledHit { readonly box: FxBox; readonly props: CompiledHitProps }

export interface CompiledHitProps {
  readonly damage: number; readonly guard: GuardMask;
  readonly hitstun: number; readonly blockstun: number;
  readonly hitstop: number; readonly blockHitstop: number;
  readonly ctrBonusHitstun: number; readonly ctrBonusHitstop: number; readonly ctrDamagePct: number;
  readonly kbX: FX; readonly kbY: FX; readonly blockPushX: FX;
  readonly selfPushBlock: FX; readonly selfPushHit: FX;
  readonly reaction: Rx; readonly juggleLimit: number; readonly juggleCost: number;
  readonly hitId: number;
  readonly sfx: SfxId; readonly blockSfx: SfxId; readonly spark: SparkId;
  readonly shakeAmp: number; readonly shakeFrames: number; readonly chroma: number;
}

export interface CompiledThrow { readonly box: FxBox; readonly props: CompiledThrowProps }
export interface CompiledThrowProps {
  readonly damage: number; readonly techWindow: number; readonly holdFrames: number;
  readonly kbX: FX; readonly kbY: FX; readonly reaction: Rx; readonly hitsAir: boolean;
  readonly sfx: SfxId; readonly spark: SparkId;
}

/** Dense per-action-frame data. compile.ts EXPANDS the sparse timeline so the
 *  sim does zero searching: frames[f] is the fully-resolved state at frame f. */
export interface CompiledFrame {
  readonly hurt: readonly FxBox[];
  readonly hit: readonly CompiledHit[];
  readonly throwBox: readonly CompiledThrow[];
  readonly pushbox: FxBox;
  /** VEL_KEEP means "do not set". */
  readonly velX: FX;
  readonly velY: FX;
  readonly friction: FX;
  readonly flags: KeyframeFlags;
  readonly sfx: SfxId;
}

/** Sentinel written into CompiledFrame.velX/velY meaning "inherit". */
export const VEL_KEEP: FX = 0x7fffffff;

export interface CompiledMove {
  readonly id: MoveId;
  readonly group: GroupMask;
  readonly button: ButtonMask;
  readonly command: CmdMask;
  readonly negEdge: boolean;
  readonly dir: 0 | 2 | 4 | 6;
  readonly stateMask: number;
  readonly totalFrames: number;
  /** Length === totalFrames. */
  readonly frames: readonly CompiledFrame[];
  readonly cancels: readonly CancelRule[];
  readonly selfChain: number;
  readonly landingRecovery: number;
  readonly armorWindow: readonly [number, number];
  readonly armorHits: number;
  readonly armorDamagePct: number;
  /** Derived and asserted by the validator; also what the F3 overlay prints. */
  readonly startup: number;
  readonly activeFirst: number;
  readonly activeLast: number;
  readonly advHit: number;
  readonly advBlock: number;
  readonly anim: AnimId;
  readonly poseHint: PoseHint;
}

export interface CompiledChar {
  readonly id: CharId;
  readonly name: string;
  readonly hp: number;
  readonly conceptSpace: ConceptSpace;
  readonly walkF: FX; readonly walkB: FX;
  readonly dashSpeed: FX; readonly dashFrames: number;
  readonly backDashSpeed: FX; readonly backDashFrames: number;
  readonly runDash: boolean;
  readonly jumpSquat: number;
  readonly jumpVelY: FX; readonly jumpVelXF: FX; readonly jumpVelXB: FX;
  readonly gravity: FX; readonly airDrag: FX; readonly groundFriction: FX;
  readonly airJumps: number; readonly weightPct: number; readonly landingLag: number;
  readonly standPush: FxBox; readonly crouchPush: FxBox; readonly airPush: FxBox;
  readonly standHurt: readonly FxBox[];
  readonly crouchHurt: readonly FxBox[];
  readonly airHurt: readonly FxBox[];
  readonly moveOrder: readonly MoveId[];
  /** Indexed by MoveId. Sparse: entries this character does not own are null. */
  readonly moves: readonly (CompiledMove | null)[];
  /** The ratings these numbers were compiled FROM. Carried for tests, the
   *  debug overlay and the clash, which needs both fighters' weights. */
  readonly traits: TraitsDef;
  readonly def: CharDef;
}

/** The sim's ONLY read-only input besides the state buffer. */
export interface DefRegistry {
  readonly chars: readonly CompiledChar[];          // indexed by CharId
  readonly moves: readonly (CompiledMove | null)[]; // indexed by MoveId, global
  readonly stages: readonly StageDef[];             // indexed by StageId
}

export type CompileFn = (chars: readonly CharDef[], stages: readonly StageDef[]) => DefRegistry;

export interface ValidationIssue {
  readonly severity: 'error' | 'warn';
  readonly where: string;
  readonly message: string;
}
/** Runs in CI and in the dev server. Errors fail the build. */
export type ValidateFn = (r: DefRegistry) => readonly ValidationIssue[];

// -----------------------------------------------------------------------------
// 7. SIM STATE — one flat Int32Array. Hidden state is impossible by construction.
// -----------------------------------------------------------------------------

export const GLOBAL_WORDS = 32;
export const FIGHTER_WORDS = 64;
export const INPUT_RING_FRAMES = 64;
export const EVENT_CAP = 48;
export const EVENT_WORDS_EACH = 6;

export const OFF_GLOBAL = 0;
export const OFF_FIGHTER = 32;                 // fighter p at OFF_FIGHTER + p*FIGHTER_WORDS
export const OFF_RING = 160;                   // player p at OFF_RING + p*INPUT_RING_FRAMES
export const OFF_EVENTS = 288;                 // EVENT_CAP * EVENT_WORDS_EACH = 288
export const STATE_WORDS = 576;                // 2304 bytes. Padded; never shrink.

/**
 * Input ring word layout: low 16 bits = held mask, high 16 bits = CONSUMED mask.
 * Consumed bits are per-FRAME-SLOT, not per-button-globally — this is what stops
 * one press from firing two moves AND stops a stale consume from eating a
 * genuinely new press six frames later.
 */
export const RING_HELD_MASK = 0x0000ffff;
export const RING_CONSUMED_SHIFT = 16;

/** Fighter field offsets, word index within the 64-word slot. FROZEN ORDER. */
export enum F {
  posX = 0, posY, velX, velY, facing, charId,
  state, stateFrame, action, actionFrame, prevAction,
  hp, hitstun, blockstun, hitstop, knockdownTimer, wakeupTimer, landingLag,
  comboCount, comboDamage, juggleCount, gravityMulPct,
  hitIdsUsed, usedCancels, chainDepth, chainMoveId,
  flags, lastContact, commandMask, chargeBack, chargeDown,
  pushX, pushY, pushW, pushH,
  lastHitFrame, airJumpsUsed, dashTimer, wallTouch,
  throwTechTimer, throwHoldTimer, throwPartnerAction, armorHitsLeft,
  stunScalePct, blockHeld, jumpDir, roundWins,
  /** CURRENT aura, in ticks — see AURA_SCALE. Max is the stamina rating. */
  aura,
  /** Double-tap detection: the direction bit last tapped, and how long it
   *  stays live. A dash is the second tap arriving while this is still warm. */
  tapDir, tapFrames,
  _pad51, _pad52, _pad53, _pad54, _pad55,
  _pad56, _pad57, _pad58, _pad59, _pad60, _pad61, _pad62, _pad63,
}

/** Global field offsets. FROZEN ORDER. */
export enum GL {
  frame = 0, rngState, roundNo, roundTimer, roundState, roundStateFrame,
  p0Wins, p1Wins, lastHitBy, stageId, teleportEpoch,
  eventCount, eventHead, confirmedFrame, matchOver, seed,
  _pad16, _pad17, _pad18, _pad19, _pad20, _pad21, _pad22, _pad23,
  _pad24, _pad25, _pad26, _pad27, _pad28, _pad29, _pad30, _pad31,
}

export type StateBuf = Int32Array;
export type PlayerIx = 0 | 1;
export type Facing = 1 | -1;

/**
 * Hand-written, monomorphic view over the buffer. NOT code-generated — a
 * generated+committed file is the one thing two parallel agents always collide
 * on. Lives in src/sim/state.ts and is owned by exactly one agent.
 */
export interface FighterView {
  readonly buf: StateBuf;
  readonly base: number;
  readonly ix: PlayerIx;
  posX: FX; posY: FX; velX: FX; velY: FX;
  facing: Facing;
  charId: CharId;
  state: S; stateFrame: number;
  action: MoveId; actionFrame: number; prevAction: MoveId;
  hp: number;
  /** CURRENT aura, in TICKS (AURA_SCALE per point). Ceiling = stamina rating. */
  aura: number;
  /** Double-tap detection for the dash. */
  tapDir: number; tapFrames: number;
  hitstun: number; blockstun: number; hitstop: number;
  knockdownTimer: number; wakeupTimer: number; landingLag: number;
  comboCount: number; comboDamage: number; juggleCount: number; gravityMulPct: number;
  hitIdsUsed: number; usedCancels: GroupMask; chainDepth: number; chainMoveId: MoveId;
  flags: FighterFlags; lastContact: Contact; commandMask: CmdMask;
  chargeBack: number; chargeDown: number;
  pushX: FX; pushY: FX; pushW: FX; pushH: FX;
  lastHitFrame: number; airJumpsUsed: number; dashTimer: number; wallTouch: number;
  throwTechTimer: number; throwHoldTimer: number; throwPartnerAction: MoveId;
  armorHitsLeft: number; stunScalePct: number; blockHeld: number;
  /** FACING-RELATIVE jump direction, latched at jump squat and resolved to an
   *  absolute velocity exactly once at launch: -1 back, 0 neutral, +1 forward.
   *  Facing-relative so it mirrors cleanly under the mirror-symmetry test, and
   *  latched so turning in mid-air cannot reverse a jump already in flight. */
  jumpDir: number; roundWins: number;
}

export interface GlobalView {
  readonly buf: StateBuf;
  frame: number; rngState: number;
  roundNo: number; roundTimer: number; roundState: RoundState; roundStateFrame: number;
  p0Wins: number; p1Wins: number; lastHitBy: PlayerIx;
  stageId: StageId; teleportEpoch: number;
  eventCount: number; eventHead: number; confirmedFrame: number;
  matchOver: number; seed: number;
}

export interface SimState {
  readonly buf: StateBuf;
  readonly g: GlobalView;
  fighter(p: PlayerIx): FighterView;
  /** Read-only defs. Never mutated by the sim. */
  readonly defs: DefRegistry;
}

/**
 * THE ONLY MUTATOR. Pure over (buf, in0, in1). No DOM, no Date, no
 * Math.random, no float, no allocation. `in0`/`in1` are raw held masks with
 * ABSOLUTE directions.
 */
export type StepFn = (s: SimState, in0: ButtonMask, in1: ButtonMask) => void;

export type CreateStateFn = (
  seed: number, charA: CharId, charB: CharId, stage: StageId, defs: DefRegistry,
) => SimState;

export type SnapshotFn = (dst: StateBuf, src: StateBuf) => void;   // dst.set(src)
export type HashFn = (buf: StateBuf) => number;                    // FNV-1a, >>> 0

/**
 * Hash of the MIRRORED state: players swapped, every x negated about the stage
 * centre, every facing flipped. tests/mirror.test.ts asserts
 *   hashMirrored(playA) === hash(playMirroredInputs)
 * for a whole golden replay. This is the ONLY test that catches slot-index
 * tiebreaks, asymmetric rounding, and commit-order leaks — the bug class that
 * produces "that combo only works on P1 side".
 */
export type MirrorHashFn = (buf: StateBuf, stageWidth: FX) => number;

// -----------------------------------------------------------------------------
// 8. EVENTS — the ONLY sim -> presentation channel.
// -----------------------------------------------------------------------------

/** Stored in the state buffer, so events roll back with everything else. */
export interface EventRing {
  readonly count: number;
  type(i: number): Ev;
  /** attacker / actor player index */
  a(i: number): number;
  /** damage / sub-id / sfx id */
  b(i: number): number;
  worldX(i: number): FX;
  worldY(i: number): FX;
  /** packed: bits 0-7 spark, 8-15 shakeAmp, 16-23 shakeFrames, 24-31 chroma */
  extra(i: number): number;
}
export type EventsFn = (s: SimState) => EventRing;

/** Presentation drains only up to g.confirmedFrame, so a rolled-back frame's
 *  sparks and sounds are discarded rather than double-fired. */
export type DrainEventsFn = (s: SimState, upToFrame: number, cb: (r: EventRing, i: number) => void) => void;

// -----------------------------------------------------------------------------
// 9. INPUT
// -----------------------------------------------------------------------------

/** Returns the held mask for exactly one sim frame. Sticky-press applied, so a
 *  4ms tap between two ticks cannot be lost. Directions ABSOLUTE. */
export interface InputSource {
  poll(frame: number): ButtonMask;
  dispose(): void;
}

export type KeyMap = Readonly<Record<string, readonly [player: PlayerIx, bit: number]>>;

/** The CPU dummy. Without this a single player has nothing to fight, and the
 *  user's acceptance test is literally "they fight". Deterministic: its own
 *  xorshift, seeded once, so replays of a dummy match reproduce exactly. */
export enum DummyMode {
  STAND = 0, BLOCK_ALL, CROUCH_BLOCK, JUMP, RANDOM_POKE, CPU_BASIC, RECORD_PLAYBACK,
}
export interface DummySourceOpts {
  readonly mode: DummyMode;
  readonly seed: number;
  /** For CPU_BASIC: 0..100 aggression. */
  readonly aggression: number;
}

// -----------------------------------------------------------------------------
// 10. SKELETON — 24 bones, shared by ALL characters and BOTH skins.
//
// B / F mean BACK / FRONT relative to facing — NOT left/right. This is the
// whole reason a facing flip is `scaleX = -1` on root with no bone swapping,
// no mirrored clips, and no z-order inversion bug when a fighter turns around.
// When binding a front-facing concept sheet: for facing = +1 (facing right),
// the sheet's screen-LEFT limb (x < originX) is the BACK limb.
// -----------------------------------------------------------------------------

export enum Bone {
  ROOT = 0, HIP, SPINE_LOW, SPINE_UP, NECK, HEAD, HEADWEAR,
  SHOULDER_B, UPPER_ARM_B, FOREARM_B, HAND_B,
  SHOULDER_F, UPPER_ARM_F, FOREARM_F, HAND_F,
  THIGH_B, SHIN_B, FOOT_B,
  THIGH_F, SHIN_F, FOOT_F,
  ACC0, ACC1, ACC2,
}
export const BONE_COUNT = 24;

/** Parent index per bone, -1 for root. Parents ALWAYS precede children, so
 *  `solve` is one forward pass. */
export const BONE_PARENTS: readonly number[] = [
  -1,                    // ROOT
  Bone.ROOT,             // HIP
  Bone.HIP,              // SPINE_LOW
  Bone.SPINE_LOW,        // SPINE_UP
  Bone.SPINE_UP,         // NECK
  Bone.NECK,             // HEAD
  Bone.HEAD,             // HEADWEAR
  Bone.SPINE_UP,         // SHOULDER_B
  Bone.SHOULDER_B,       // UPPER_ARM_B
  Bone.UPPER_ARM_B,      // FOREARM_B
  Bone.FOREARM_B,        // HAND_B
  Bone.SPINE_UP,         // SHOULDER_F
  Bone.SHOULDER_F,       // UPPER_ARM_F
  Bone.UPPER_ARM_F,      // FOREARM_F
  Bone.FOREARM_F,        // HAND_F
  Bone.HIP,              // THIGH_B
  Bone.THIGH_B,          // SHIN_B
  Bone.SHIN_B,           // FOOT_B
  Bone.HIP,              // THIGH_F
  Bone.THIGH_F,          // SHIN_F
  Bone.SHIN_F,           // FOOT_F
  Bone.SPINE_UP,         // ACC0  (plume-wings, puffs, shell)
  Bone.HEADWEAR,         // ACC1  (headwear-fan, horns, brim)
  Bone.HIP,              // ACC2  (apron, skirt, bells-belt)
];

/** Default painter z per bone. Back limbs behind torso, front limbs in front.
 *  Because bones are B/F, this is CORRECT AFTER A FACING FLIP with no work. */
export const BONE_Z: readonly number[] = [
  0,    // ROOT (ground shadow)
  500,  // HIP
  500, 510, 520, 800, 900,        // SPINE_LOW, SPINE_UP, NECK, HEAD, HEADWEAR
  200, 210, 220, 230,             // *_B arm chain
  700, 710, 720, 730,             // *_F arm chain
  100, 110, 120,                  // *_B leg chain
  600, 610, 620,                  // *_F leg chain
  250, 910, 490,                  // ACC0 (behind torso), ACC1 (over hat), ACC2 (over hip)
];

/** Presentation-only pose. Floats. Rebuilt every render frame from the sim's
 *  (charId, action, actionFrame, state, stateFrame) — pose is NEVER sim state,
 *  so animation quality can change daily without touching a determinism hash. */
export interface PoseBuffer {
  readonly count: number;             // BONE_COUNT
  /** Local rotation, radians. */
  readonly rot: Float32Array;
  /** Local translation relative to parent, world units. */
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly sx: Float32Array;
  readonly sy: Float32Array;
  /** World 2x3 affine per bone, row-major [a b tx / c d ty]. BONE_COUNT * 6. */
  readonly world: Float32Array;
  /** Squash/stretch per bone, 1 = neutral. */
  readonly stretch: Float32Array;
  readonly visible: Uint8Array;
}

export type SolveFn = (p: PoseBuffer) => void;

/**
 * Int16 keyframe clip. [rot(1/1024 turn), tx(1/16 unit), ty, sx(1/256), sy]
 * per bone per key, plus a frame index table.
 */
export interface AnimClip {
  readonly id: AnimId;
  readonly frameCount: number;
  readonly keyFrames: Int16Array;   // keys * BONE_COUNT * 5
  readonly keyAt: Int16Array;       // keys
  /** Loop point, -1 = no loop. */
  readonly loopAt: number;
}

/**
 * Samples `clip` into `out`. WHEN NO CLIP EXISTS for the requested AnimId
 * (true for every move on day one), implementations MUST synthesise a pose
 * from `hint` and the move's phases instead of failing or T-posing.
 * `alpha` is 0 unless the state opted into interpolatePose.
 */
export type SampleFn = (
  out: PoseBuffer,
  restPose: readonly (readonly [number, number])[],
  clip: AnimClip | null,
  hint: PoseHint,
  frame: number,
  totalFrames: number,
  phase: { startup: number; activeFirst: number; activeLast: number },
  alpha: number,
) => void;

/** Presentation-only spring on accessory bones, driven by the DERIVATIVE of
 *  root position. Costumes that move on their own are most of "alive". */
export type JiggleFn = (
  p: PoseBuffer, defs: readonly JiggleDef[], prevRootX: number, rootX: number, prevRootY: number, rootY: number, dtMs: number,
) => void;

// -----------------------------------------------------------------------------
// 11. SKINS — ONE interface, two implementations. The seam CLAUDE.md mandates.
// -----------------------------------------------------------------------------

/** One instance = one textured quad. 24 floats, interleaved.
 *  [0] a, b, c, d                     (2x2 affine)
 *  [1] tx, ty, z, glintPhase
 *  [2] u0, v0, u1, v1
 *  [3] tintR, tintG, tintB, tintA
 *  [4] flash, rimStrength, alpha, sparkleAmt
 *  [5] matU0, matV0, matU1, matV1     (material atlas UVs; equal to [2] when
 *                                      the atlases share a layout)
 */
export const INSTANCE_FLOATS = 24;
export interface InstanceWriter {
  /** Returns a 24-float subarray view to fill. Zero allocation. */
  push(): Float32Array;
  readonly count: number;
}

export interface SkinDrawOpts {
  readonly worldX: number;
  readonly worldY: number;
  readonly facing: Facing;
  /** 0..1 mix-to-white. Drives the hit flash. */
  readonly flash: number;
  readonly tint: readonly [number, number, number, number];
  /** Mirror-match / P2 colourway. */
  readonly costume: 0 | 1;
  /** 0 for the back fighter, 1000 for the front fighter. */
  readonly zBase: number;
  /** Advanced by |velocity| — sequins sparkle when you move. */
  readonly glintPhase: number;
  /** Defender hitstop vibration, render only. */
  readonly shakeX: number;
  readonly shakeY: number;
  readonly alpha: number;
  /**
   * WHICH IMAGE TO DRAW. A skeletal skin ignores these (it is handed a solved
   * PoseBuffer instead); a SPRITE skin needs them, because blitting frame N of
   * a clip is the entire job. `frame` is the move's actionFrame, or the state
   * frame when no move is playing.
   */
  readonly anim: AnimId;
  readonly frame: number;
}

export interface CharacterSkin {
  readonly kind: 'stick' | 'parts' | 'sprite';
  readonly charId: CharId;
  /** Batching key. Instances sharing it flush together. */
  readonly materialKey: number;
  load(gl: WebGL2RenderingContext): Promise<void>;
  emit(out: InstanceWriter, pose: PoseBuffer, o: SkinDrawOpts): void;
  /** Local-space visual bounds, world units, for culling and the camera. */
  localBounds(): FxBox;
  dispose(): void;
}

// -----------------------------------------------------------------------------
// 11b. SPRITE SHEETS — the shipping render path.
//
// SunForce renders like Guilty Gear XX: one hand-drawn (or baked) IMAGE per
// animation frame, blitted as a single quad. No bones at runtime.
//
// The format is deliberately TOOL-AGNOSTIC — a PNG atlas plus this JSON — so it
// can be produced by the offline rig baker, by an artist exporting from
// Aseprite / Photoshop, or by any other pipeline, without the runtime caring.
//
// The sim is unaffected by any of this: CompiledMove.frames[] already carries
// per-frame hurt/hit/pushbox data indexed by frame number, which is exactly the
// model a sprite game needs.
// -----------------------------------------------------------------------------

export interface SpriteFrame {
  /** Source rect in ATLAS PIXELS: [x, y, w, h]. */
  readonly uv: readonly [number, number, number, number];
  /**
   * The pivot for this frame, in frame-local pixels, x from the left and y from
   * the TOP. It maps onto the fighter's world origin (feet centre, on the
   * ground line). Per-frame, because a crouch and a jump do not share one.
   * Getting this wrong is what makes sprites jitter or sink into the floor.
   *
   * IT MAY LIE OUTSIDE THE TRIMMED RECT, and on airborne frames it usually
   * does: when the feet tuck up, world (0,0) falls BELOW the bitmap, so
   * `origin[1] > h`. That is correct and unavoidable for any sprite whose feet
   * leave the ground line. DO NOT CLAMP IT INTO THE RECT — clamping silently
   * drops every jump back onto the floor.
   */
  readonly origin: readonly [number, number];
  /** Sim frames this image is held for. 1 = one image per sim frame. */
  readonly dur: number;
}

export interface SpriteClip {
  readonly frames: readonly SpriteFrame[];
  /** Frame index to loop back to, -1 for a one-shot. */
  readonly loopAt: number;
}

export interface SpriteSheet {
  /** Atlas filename, relative to the sheet's own location. */
  readonly image: string;
  readonly atlasW: number;
  readonly atlasH: number;
  /** ATLAS PIXELS -> WORLD UNITS. Lets art be drawn at any resolution. */
  readonly unitsPerPx: number;
  /** Keyed by the AnimId NAME (e.g. "IDLE", "ATK_5P") — stable across builds,
   *  unlike a numeric index, which shifts the moment the enum grows. */
  readonly clips: Readonly<Record<string, SpriteClip>>;
}

// -----------------------------------------------------------------------------
// 12. BAKED VECTOR PARTS — the art pipeline's output contract.
// -----------------------------------------------------------------------------

/**
 * Hand-authored glue: art/<char>.rig.json. Maps concept SVG groups to bones.
 *
 * THE SPLIT PROBLEM, SOLVED WITHOUT GEOMETRY CODE:
 * caporal's #legs is ONE fused path containing both legs (verified: crotch
 * vertex at 302,506; only 2 of 27 elements in the group cross x=302 at all —
 * #arms, #footwear and #puffs cross ZERO, and tobas crosses zero everywhere).
 * So a part does NOT split paths. It declares a CLIP RECT in concept space and
 * the rasteriser renders the group clipped to it. Left leg = clip
 * [0,0,302,960]; right leg = [302,0,640,960]. This is one line in the baker,
 * it is exact on the 2 crossing paths, it preserves stroke joins, and it needs
 * no Bezier splitting anywhere.
 */
export interface RigPartDef {
  /** SVG group id, e.g. "legs". Several parts may share one group. */
  readonly group: string;
  /** Unique part name, e.g. "legB". */
  readonly name: string;
  readonly bone: Bone;
  /** Optional concept-space clip rect applied at bake time. */
  readonly clip?: ConceptBox;
  /** Rotation pivot, CONCEPT coordinates. */
  readonly pivot: readonly [number, number];
  /** Painter order within the fighter. Overrides BONE_Z when present. */
  readonly z?: number;
  /** Upgrade this part from a rigid quad to a 5x5 grid mesh skinned to 2 bones.
   *  Use on plume-wings, headwear-fan, waist-and-apron — the parts that read as
   *  a pivoting sticker when rigid. */
  readonly mesh?: 'grid5';
  readonly meshBoneB?: Bone;
  readonly rimStrength?: number;
}

export interface RigDef {
  readonly svg: string;
  readonly conceptSpace: ConceptSpace;
  /** 2 => 1280x1920 raster => 4x world resolution. */
  readonly bakeScale: number;
  readonly parts: readonly RigPartDef[];
  /** Annotation groups deleted before rasterising. */
  readonly strip: readonly string[];
  /**
   * MATERIAL RULES, keyed by the artwork's own fill/stroke hex. The baker
   * re-renders each part a second time with these substitutions to produce
   * mat.png. This is the ONLY mechanism that yields Oruro sequin/gold glint
   * with zero hand-painted maps, and unlike a clipPath heuristic it works on
   * tobas.svg (which has ZERO clipPaths) and on the four unmade sheets.
   *   R = specular/sequin mask, G = rim mask, B = emissive, A = palette row.
   */
  readonly materials: Readonly<Record<string, {
    readonly spec?: number; readonly rim?: number; readonly emis?: number; readonly paletteRow?: number;
  }>>;
  /** Costume variants: hex -> hex remap, rendered as separate atlas entries. */
  readonly costumes: readonly Readonly<Record<string, string>>[];
}

export interface PartRecord {
  readonly name: string;
  readonly bone: Bone;
  /** Normalised albedo AND material UVs (both atlases share the layout). */
  readonly uv: readonly [number, number, number, number];
  /** Cropped size in world units. */
  readonly size: readonly [number, number];
  /** Pivot inside the crop, normalised 0..1. */
  readonly pivot: readonly [number, number];
  readonly z: number;
  readonly mesh: 'quad' | 'grid5';
  readonly meshBoneB: Bone;
  readonly rimStrength: number;
}

export interface AtlasManifest {
  readonly charId: CharId;
  readonly albedo: string;      // public/baked/<char>/atlas.png,    2048^2 RGBA8
  readonly material: string;    // public/baked/<char>/mat.png,      1024^2 RGBA8
  readonly albedoSize: number;
  readonly materialSize: number;
  /** Pre-sorted by z at bake time, so the runtime never sorts parts. */
  readonly parts: readonly PartRecord[];
  readonly costumes: number;
}

// -----------------------------------------------------------------------------
// 13. STAGE + CAMERA
// -----------------------------------------------------------------------------

export interface StageLayer {
  readonly texture: string;
  /** 0 = infinitely far, 1 = play plane, >1 = foreground. */
  readonly parallax: number;
  /** Vertical parallax runs at PARALLAX_Y_FACTOR * this. */
  readonly yOffset: number;
  readonly scale: number;
  readonly scrollX?: number;
  readonly tint?: readonly [number, number, number];
  readonly hazeAmount?: number;
  readonly blend?: 'normal' | 'add';
  readonly drawOverFighters?: boolean;
  /** Crowd bob / 2-frame sway. */
  readonly bob?: { readonly amp: number; readonly hz: number };
  /** Reflection strip alpha, 0 = off. */
  readonly reflect?: number;
}

export interface StageDef {
  readonly id: StageId;
  readonly name: string;
  /** World units. X in [0, width]. */
  readonly width: number;
  readonly wallPad: number;
  readonly ceiling: number;
  readonly startX: readonly [number, number];
  readonly layers: readonly StageLayer[];
  readonly ambientLight: readonly [number, number, number];
  readonly rimLightDir: readonly [number, number];
  readonly rimColor: number;
  /**
   * Music is CONVENTION, not configuration: public/audio/music/<musicId>.<ext>,
   * loader tries webm, ogg, m4a, mp3 in that order. The user drops a file in
   * and nothing else changes. Missing file => silence + one console warning.
   */
  readonly musicId: string;
  readonly loopStart?: number;
  readonly loopEnd?: number;
  readonly ambienceId?: string;
  readonly particles?: readonly {
    readonly kind: 'confetti' | 'dust' | 'snow';
    readonly count: number;
    readonly parallax: number;
  }[];
}

/** Presentation, float, outside the sim, runs on the RENDER clock. */
export interface Camera {
  x: number; y: number; zoom: number;
  shakeX: number; shakeY: number;
  update(s: SimState, def: StageDef, dtMs: number): void;
  /** Applied AFTER the wall clamp — a corner hit must still shake. */
  addShake(nx: number, ny: number, amp: number, frames: number): void;
  punchZoom(amount: number, frames: number): void;
  onEvent(r: EventRing, i: number): void;
  /** 3x3 column-major view-projection into `out` (length 9). */
  viewMatrix(out: Float32Array): void;
}

// -----------------------------------------------------------------------------
// 14. AUDIO
// -----------------------------------------------------------------------------

export interface AudioBuses {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly music: GainNode;
  readonly musicDuck: GainNode;
  readonly sfx: GainNode;
  readonly hit: GainNode;
  readonly voice: GainNode;
  readonly foley: GainNode;
  readonly ambience: GainNode;
}

export interface AudioApi {
  /** Created lazily on the first user gesture (the character-select click). */
  unlock(): Promise<AudioBuses>;
  playSfx(id: SfxId, worldX: number, gain?: number, pitch?: number): void;
  /** Manual sidechain. A DynamicsCompressor keyed off a bus is imprecise. */
  duck(amount: number, holdSeconds: number, releaseSeconds: number): void;
  playStageMusic(def: StageDef): Promise<void>;
  stopMusic(fadeSeconds: number): void;
  setMasterGain(v: number): void;
}

// -----------------------------------------------------------------------------
// 15. LOOP, SCENES, RENDERER
// -----------------------------------------------------------------------------

export interface LoopStats {
  simSteps: number; hitches: number; accMs: number; fps: number; droppedMs: number;
}

export interface Scene {
  enter(): void;
  /** Return non-null to transition. */
  tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null;
  /** `alpha` is 0 unless interpolation is enabled this frame. */
  draw(alpha: number, dtMs: number): void;
  exit(): void;
}

export type StartLoopFn = (root: Scene, onStats?: (s: LoopStats) => void) => void;

export interface Renderer {
  init(gl: WebGL2RenderingContext): Promise<void>;
  resize(cssW: number, cssH: number, dpr: number): void;
  /** THE ONLY place gl.draw* is called. */
  draw(s: SimState, prev: StateBuf, alpha: number, dtMs: number): void;
  setSkin(p: PlayerIx, skin: CharacterSkin): void;
  /**
   * PRESENTATION-ONLY stage dressing: draw this StageDef's art instead of the
   * one `SimState` names, until cleared with null. The fight scene uses it so a
   * troupe can bring its own backdrop to a shared stage (src/data/troupes.ts).
   *
   * The sim is not told and MUST NOT be: the override is required to differ
   * from the real stage in art alone, so nothing it changes can reach a
   * pushbox, a wall or a hash. Optional, so a cut-down renderer can omit it.
   */
  setStageDressing?(def: StageDef | null): void;
  toggleDebugBoxes(): void;
  dispose(): void;
}

/** Match configuration handed to the fight scene. */
export interface MatchConfig {
  readonly chars: readonly [CharId, CharId];
  readonly stage: StageId;
  readonly seed: number;
  readonly roundsToWin: number;
  readonly timerSeconds: number;
  readonly skins: readonly [CharacterSkin['kind'], CharacterSkin['kind']];
  readonly p2IsDummy: boolean;
  readonly dummy: DummySourceOpts;
}

// -----------------------------------------------------------------------------
// 16. TUNABLE CONSTANTS. Every one an integer; every one referenced by name.
//     Lives here so the sim, the data and the validator cannot disagree.
// -----------------------------------------------------------------------------

/**
 * THE CLASH. Two strikes landing on the same frame cancel: neither fighter
 * takes damage, and both are shoved apart by this much, world units per frame,
 * BEFORE each fighter's own weight scales it. Scaled by `weightPct` exactly as
 * knockback is, so the lighter fighter slides further — a Tinku meeting a
 * Diablo goes 1.11x while the Diablo goes 0.83x.
 *
 * Sits between a jab's kbX (2.4) and a kick's (4.6): a trade should read as a
 * real collision without launching either of them across the stage.
 */
export const CLASH_PUSH = 4.0;

// -----------------------------------------------------------------------------
// AURA — the live half of stamina
//
// STAMINA is the base condition: a rating, static, the CEILING. AURA is what a
// fighter actually has right now. Everyone starts a round at full aura, equal
// to their stamina, and spends it acting: aura is what decides whether you can
// throw the next hit or have to wait a moment.
//
// STORED IN TICKS, NOT POINTS, and this is the whole reason the regen is exact.
// Aura recovers at `stamina / 100` points per second — Caporal's 105 gives
// 1.05 points a second, so the 10 points a dash costs come back in
// (100/105) * 10 = 9.52 seconds. Per FRAME that is stamina/6000 points, which
// is not an integer and would drift if it were rounded every tick. Counting in
// 1/6000ths of a point instead makes the regen exactly `stamina` ticks per
// frame: integer, exact, and identical on every machine.
// -----------------------------------------------------------------------------

/** Ticks per aura point. SIM_HZ * 100, so regen is `stamina` ticks per frame. */
export const AURA_SCALE = 6000;

/** What an action costs, in whole aura points. */
export const AURA_COST_PUNCH = 3;
export const AURA_COST_KICK = 5;
/** Taking a hit on guard. Cheaper than throwing one: blocking is the patient
 *  option and should not exhaust you faster than attacking does. */
export const AURA_COST_BLOCK = 1;
export const AURA_COST_DASH = 10;

/**
 * A dash needs aura STRICTLY above this, so a fighter whose ceiling is 90 can
 * never dash at all — which is Diablo, and is the intent: the heavy does not
 * get the mobility option. Caporal's 105 affords two dashes (105 -> 95 -> 85)
 * before the third is refused.
 */
export const AURA_DASH_MIN = 90;

/** A dash also needs this much MOVEMENT rating. Slow characters cannot dash
 *  however much aura they are holding. */
export const DASH_MIN_MOVEMENT = 100;

/**
 * Frames a first tap stays live waiting for its partner.
 *
 * NOT the window you get: the counter is decremented by the same per-frame
 * timer pass that counts it, so the usable gap is one frame shorter at each
 * end. 20 gives about a fifth of a second of real slack, which is what a human
 * double tap actually lands in — 12 measured out at roughly 10 usable frames
 * and the dash simply refused to come out.
 */
export const DOUBLE_TAP_FRAMES = 20;

export const SIM_HZ = 60;
export const SIM_DT_MS = 1000 / 60;
export const MAX_STEPS_PER_FRAME = 5;
export const MAX_DELTA_MS = 250;

/** World. 3600 units wide = 1.875 logical screens. */
export const STAGE_WIDTH = 3600;
/**
 * How far the walls sit INSIDE the stage, world units.
 *
 * It is a RENDERING constraint before it is a gameplay one. The camera clamps
 * its view to [0, STAGE_WIDTH], so a fighter pinned at the wall is drawn at
 * exactly `WALL_PAD` from the view's edge — and a sprite is far wider than the
 * pushbox it is anchored by. The widest frame in the roster (Machona's 5K)
 * reaches 230 units behind her origin, so at the old 90 a cornered fighter had
 * 140 units of herself cut off by the edge of the screen.
 *
 * 240 is that 230 plus a little air. Raising it costs 300 units of the 3600
 * the fighters can actually use, which is the right trade: a corner you cannot
 * see is worse than a slightly smaller stage.
 */
export const WALL_PAD = 240;
export const CEILING = 900;
export const LOGICAL_W = 1920;
export const LOGICAL_H = 1080;
/** 756 concept px of caporal * 0.5 unitsPerPx. 35% of screen height. */
export const FIGHTER_HEIGHT = 378;

/** Input. */
export const INPUT_LENIENCY = 6;
export const MOTION_WINDOW = 12;
export const CHARGE_FRAMES = 40;
export const THROW_TECH_WINDOW = 3;
/** P and K within this many frames of each other count as a THROW macro. */
export const THROW_MACRO_SLOP = 2;

/** Combat. */
export const HITSTOP_PUNCH = 9;
export const HITSTOP_KICK = 14;
export const HITSTOP_BLOCK_PUNCH = 7;
export const HITSTOP_BLOCK_KICK = 10;
export const HITSTUN_PUNCH = 16;
export const HITSTUN_KICK = 21;
export const BLOCKSTUN_PUNCH = 11;
export const BLOCKSTUN_KICK = 14;
export const CTR_HITSTUN_PUNCH = 6;
export const CTR_HITSTUN_KICK = 8;
export const CTR_HITSTOP_BONUS = 4;
export const CTR_DAMAGE_PCT = 125;

/** Damage proration. Hit #1 is ALWAYS full, so "a punch takes 50" is literally
 *  true for every non-combo hit — which is what the user's rule means. */
export const DAMAGE_SCALE: readonly number[] = [100, 80, 70, 60, 50, 42, 36, 32, 30];
export const DAMAGE_SCALE_FLOOR = 30;
export const DAMAGE_MIN = 10;

/** Hitstun proration is SEPARATE and much gentler than damage proration.
 *  Coupling them collapses every combo route by hit 5. */
export const STUN_SCALE: readonly number[] = [100, 100, 94, 88, 82, 76, 72, 68, 64];
export const STUN_SCALE_FLOOR = 64;

/** Juggle. Gravity rises per air hit so air combos self-terminate. */
export const JUGGLE_GRAVITY_STEP_PCT = 10;
export const JUGGLE_GRAVITY_MAX_PCT = 180;

/** Physics. */
export const KNOCKBACK_DECAY_PCT = 88;
export const PUSH_SEP_MAX = 6;
export const PUSH_SEP_AIR = 3;
export const AIR_VS_AIR_PUSH = false;

/** Round. */
export const ROUND_TIME = 90;
export const ROUNDS_TO_WIN = 2;
/** Sim frames the KO sequence holds before the round ends. At
 *  KO_TIMESCALE_PCT they take 45 / 0.30 = 150 real frames, about 2.5 seconds. */
export const KO_SLOWMO_FRAMES = 60;
/** The loop's accumulator runs at this percentage during a KO. */
export const KO_TIMESCALE_PCT = 30;

/**
 * THE KO LAUNCH. The losing fighter is thrown backwards and up as it dies —
 * on top of whatever knockback killed it, which has already played out by then.
 * World units per frame, scaled by the victim's own weight exactly as knockback
 * is, so a Diablo goes down heavily and a Tinku is flung.
 *
 * 15.0 against gravity 1.10 is a 102-unit arc over 27 frames, which finishes
 * comfortably inside KO_SLOWMO_FRAMES — the fighter lands before the round ends
 * rather than being cut off mid-flight.
 */
export const KO_LAUNCH_X = 9.0;
export const KO_LAUNCH_Y = 15.0;

/** Camera. */
export const CAM_MIN_ZOOM = 0.80;
export const CAM_MAX_ZOOM = 1.30;
export const CAM_MARGIN = 260;
export const CAM_BLEED = 64;
export const PARALLAX_Y_FACTOR = 0.4;

/** Render. */
export const INTERP_MIN_HZ = 62;
export const ATLAS_ALBEDO_SIZE = 2048;
export const ATLAS_MATERIAL_SIZE = 1024;
export const ATLAS_PADDING = 8;
export const BAKE_SCALE = 2;

// -----------------------------------------------------------------------------
// 17. DEV / TEST SEAMS
// -----------------------------------------------------------------------------

export interface ReplayFile {
  readonly version: 1;
  readonly seed: number;
  readonly chars: readonly [CharId, CharId];
  readonly stage: StageId;
  /** 2 masks per frame, interleaved [p0,p1,p0,p1,...]. */
  readonly inputs: readonly number[];
  /** Hash every HASH_EVERY frames. */
  readonly hashes: readonly number[];
}
export const HASH_EVERY = 60;

/** 60 lines today; the GGPO seam tomorrow. Nothing outside src/game/ knows
 *  which Runner it is holding. */
export interface Runner {
  advance(): void;
  readonly state: SimState;
  readonly confirmedFrame: number;
}
export interface RollbackHarness {
  save(s: SimState): void;
  resimulate(s: SimState, fromFrame: number, inputs: Int32Array): void;
  verify(s: SimState, expectedHash: number): boolean;
}

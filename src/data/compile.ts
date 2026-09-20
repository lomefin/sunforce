// =============================================================================
// SunForce — src/data/compile.ts
// THE SEAM. Authoring types (concept space, floats, sparse) in; compiled types
// (world space, all-integer, dense) out. Runs ONCE at load and never again.
// Nothing under src/sim/ ever reads an authoring type, and nothing here runs
// per frame.
//
// -----------------------------------------------------------------------------
// COORDINATE CONVERSION — the one calculation the whole art pipeline rests on.
// -----------------------------------------------------------------------------
// CONCEPT SPACE is the 640x960 viewBox of concept/<char>.svg: x right, y DOWN,
// absolute, origin at the sheet's top-left. A designer reads a box straight off
// the artwork; boxes, bone rest poses and part pivots all live here.
//
// WORLD SPACE is fixed point: x right, y UP, ground at y = 0, and fighter-local
// boxes are FACING-RELATIVE so +x is always FORWARD.
//
//   localX = (cx - cs.originX)  * cs.unitsPerPx      // +x forward
//   localY = (cs.groundY - cy)  * cs.unitsPerPx      // +y up, 0 = ground
//   FX     = trunc(local * ONE)
//
// For character A: originX 302 (the crotch vertex of #legs), groundY 858 (the
// #ground-shadow ellipse cy), unitsPerPx 0.5 (756 px of drawn character = 378
// world units = FIGHTER_HEIGHT).
//
// THE Y FLIP INVERTS THE EDGES. A ConceptBox is [x0, y0, x1, y1] with y0 < y1
// because concept y runs downward, so y0 is the TOP edge and y1 is the BOTTOM
// edge. In world space the bottom edge is the SMALLER y and becomes FxBox.y,
// and the height is topWorld - bottomWorld. Getting this backwards produces
// boxes that are upside down about the hips, which reads as "the hitboxes are
// roughly right but the kick whiffs high" — which is exactly why M0's
// acceptance test 6 is "F1 boxes line up with the limbs".
//
// Each edge is converted independently and the extent is the DIFFERENCE of two
// converted edges, never a converted difference. That way x + w lands exactly on
// the converted far edge and two boxes authored flush in concept space stay
// flush after truncation.
//
// -----------------------------------------------------------------------------
// SPARSE TIMELINE -> DENSE FRAMES
// -----------------------------------------------------------------------------
// frames[f] is the fully resolved state at action frame f, so the simulation
// does zero searching and zero interpolation. Resolution rules:
//
//   STICKY (carried forward until replaced): hurt, hit, throwBox, pushbox,
//     friction, flags. A present array REPLACES the previous one; `[]` clears.
//   IMPULSE (apply on that frame only, VEL_KEEP / SfxId.NONE elsewhere):
//     velX, velY, sfx.
//
// velX/velY MUST be impulses. A keyframe SETS velocity; if the compiler carried
// the last value forward, `{ at: 0, velX: 0 }` would pin the fighter's velocity
// to zero for the whole move and friction, knockback and pushbox separation
// would all be silently overwritten every frame. VEL_KEEP is the sentinel for
// "do not set", which is why it exists. sfx is an impulse for the same reason:
// an inherited sound retriggers 29 times.
// =============================================================================

import {
  BONE_COUNT, G, MoveId, NEUTRAL_TRAITS, ONE, SfxId, TRAIT_BASE, TRAIT_MAX, TRAIT_MIN, VEL_KEEP,
} from '@/core/contracts';
import type {
  CharDef, CompileFn, CompiledChar, CompiledFrame, CompiledHit, CompiledHitProps,
  CompiledMove, CompiledThrow, CompiledThrowProps, ConceptBox, ConceptSpace,
  FX, FxBox, GroupMask, HitProps, MoveDef, StageDef, ThrowProps, TraitsDef,
} from '@/core/contracts';
import { assert } from '@/core/assert';
import { fx } from '@/core/fixed';

// Shared immutable singletons, so an untouched frame costs nothing.
const NO_BOXES: readonly FxBox[] = [];
const NO_HITS: readonly CompiledHit[] = [];
const NO_THROWS: readonly CompiledThrow[] = [];

/** An empty armor window: no frame f satisfies f >= 0 && f <= -1. */
const NO_ARMOR: readonly [number, number] = [0, -1];

/**
 * World units -> FX with a load-time guard. `fx()` turns NaN and undefined into
 * 0 (because `NaN | 0 === 0`), so a mistyped field would compile to a silent
 * zero instead of an error. Catching it here costs one dev-only check per
 * authored number, once, at load.
 */
const toFx = (units: number, where: string): FX => {
  assert(Number.isFinite(units), `${where}: expected a finite number, got ${units}`);
  return fx(units);
};

/**
 * Presentation scalars (screen shake amplitude and duration, chromatic
 * aberration) are authored in SCREEN PIXELS, not world units, and are packed
 * one-per-byte into the event ring's `extra` word. They are rounded to whole
 * pixels here so that packing is lossless: A's kick authors 3.5 px of chroma
 * and compiles to 4.
 */
const toPixels = (v: number, where: string): number => {
  assert(Number.isFinite(v), `${where}: expected a finite number, got ${v}`);
  return Math.round(v) | 0;
};

// -----------------------------------------------------------------------------
// Concept space -> world space
// -----------------------------------------------------------------------------

/** Concept x -> facing-relative world x in FX. +x is FORWARD. */
export const conceptX = (cx: number, cs: ConceptSpace): FX => fx((cx - cs.originX) * cs.unitsPerPx);

/** Concept y (DOWN) -> world y in FX. +y is UP and 0 is the ground line. */
export const conceptY = (cy: number, cs: ConceptSpace): FX => fx((cs.groundY - cy) * cs.unitsPerPx);

/** [x0, y0, x1, y1] in concept pixels -> { x, y, w, h } in FX. */
export const conceptBox = (b: ConceptBox, cs: ConceptSpace, where: string): FxBox => {
  const [x0, y0, x1, y1] = b;
  assert(Number.isFinite(x0 + y0 + x1 + y1), `${where}: concept box has a non-finite edge: ${String(b)}`);
  assert(x1 > x0, `${where}: concept box needs x1 > x0, got [${x0}, ${y0}, ${x1}, ${y1}]`);
  assert(y1 > y0, `${where}: concept box needs y1 > y0 (concept y runs DOWN), got [${x0}, ${y0}, ${x1}, ${y1}]`);
  assert(
    x0 >= 0 && x1 <= cs.w && y0 >= 0 && y1 <= cs.h,
    `${where}: concept box [${x0}, ${y0}, ${x1}, ${y1}] is outside the ${cs.w}x${cs.h} sheet`,
  );

  const left = conceptX(x0, cs);
  const right = conceptX(x1, cs);
  const bottom = conceptY(y1, cs); // larger concept y = lower on the sheet = smaller world y
  const top = conceptY(y0, cs);
  return { x: left, y: bottom, w: right - left, h: top - bottom };
};

// -----------------------------------------------------------------------------
// TRAITS -> NUMBERS
//
// Every rating is a PERCENTAGE OF THE AUTHORED VALUE, folded in exactly once,
// here, at build time. The sim never sees a trait: it reads the same compiled
// fields it always did, so a roster of all-100 characters compiles to precisely
// the numbers that were authored and nothing downstream can tell the difference.
//
// ROUNDING. These are balance scalars on plain integers — damage, frame counts,
// percentages — not fixed-point coordinates, so they ROUND rather than truncate:
// 50 * 95% is 47.5 and 48 is the honest answer, where the `|0` truncation the
// rest of the engine insists on would quietly shave a point off. That rule
// exists to keep mirrored POSITIONS symmetric, and no number here is a position.
// -----------------------------------------------------------------------------

/** `v` scaled by a percentage rating, rounded, never below 1. */
const byTrait = (v: number, pct: number): number => Math.max(1, Math.round((v * pct) / 100));

/**
 * INVERSE ratings: the ones where a bigger number means LESS of the thing.
 * Weight is mass, so knockback received goes as 100/weight — 120 slides 0.83x
 * as far, 90 slides 1.11x. Stamina is recovery speed, so recovery frames go the
 * same way. Both are the reciprocal because both describe RESISTANCE.
 */
const inverse = (pct: number): number => Math.max(1, Math.round((100 * 100) / pct));

/** Which power rating a move's damage answers to. A move declares its own
 *  group, so this never has to guess from a name or a MoveId. */
const powerOf = (group: GroupMask, t: TraitsDef): number =>
  (group & G.KICK) !== 0 ? t.kick : (group & G.PUNCH) !== 0 ? t.punch : TRAIT_BASE;

// -----------------------------------------------------------------------------
// Hit / throw properties
// -----------------------------------------------------------------------------

const compileHitProps = (p: HitProps, where: string, powerPct: number): CompiledHitProps => ({
  // THE GAME RULE, still: a punch is authored 50 and a kick 100. The rating is
  // a bonus ON TOP of that base — Tinku Supay's 90 punch is 50 * 0.90 = 45.
  damage: byTrait(p.damage, powerPct),
  guard: p.guard,
  hitstun: p.hitstun | 0,
  blockstun: p.blockstun | 0,
  hitstop: p.hitstop | 0,
  blockHitstop: p.blockHitstop | 0,
  ctrBonusHitstun: p.ctrBonusHitstun | 0,
  ctrBonusHitstop: p.ctrBonusHitstop | 0,
  ctrDamagePct: p.ctrDamagePct | 0,
  kbX: toFx(p.kbX, `${where}.kbX`),
  kbY: toFx(p.kbY, `${where}.kbY`),
  blockPushX: toFx(p.blockPushX, `${where}.blockPushX`),
  selfPushBlock: toFx(p.selfPushBlock, `${where}.selfPushBlock`),
  selfPushHit: toFx(p.selfPushHit, `${where}.selfPushHit`),
  reaction: p.reaction,
  juggleLimit: p.juggleLimit | 0,
  juggleCost: p.juggleCost | 0,
  hitId: p.hitId | 0,
  sfx: p.sfx,
  blockSfx: p.blockSfx,
  spark: p.spark,
  shakeAmp: toPixels(p.shakeAmp, `${where}.shakeAmp`),
  shakeFrames: toPixels(p.shakeFrames, `${where}.shakeFrames`),
  chroma: toPixels(p.chroma, `${where}.chroma`),
});

const compileThrowProps = (p: ThrowProps, where: string): CompiledThrowProps => ({
  damage: p.damage,
  techWindow: p.techWindow | 0,
  holdFrames: p.holdFrames | 0,
  kbX: toFx(p.kbX, `${where}.kbX`),
  kbY: toFx(p.kbY, `${where}.kbY`),
  reaction: p.reaction,
  hitsAir: p.hitsAir,
  sfx: p.sfx,
  spark: p.spark,
});

// -----------------------------------------------------------------------------
// Moves
// -----------------------------------------------------------------------------

/**
 * Expands one sparse move timeline into `totalFrames` fully resolved frames and
 * derives the frame-data numbers the F3 overlay and the validator print.
 *
 * `fallbackPush` is the character's standing pushbox, used for any frame before
 * the timeline sets one — a fighter with a zero-width pushbox falls through the
 * separation pass.
 */
export const compileMove = (
  m: MoveDef, cs: ConceptSpace, fallbackPush: FxBox, traits: TraitsDef = NEUTRAL_TRAITS,
): CompiledMove => {
  const powerPct = powerOf(m.group, traits);

  // STAMINA USED TO TRIM THE RECOVERY TAIL HERE. It does not any more: aura
  // owns the cadence of hits now, as a live resource the fighter spends, and
  // having stamina ALSO shorten every move would be the same rating paying
  // twice. Stamina is the ceiling of the aura pool and nothing else.
  //
  // Move length is therefore the authored length, for everyone.
  const totalFrames = m.totalFrames;
  const where = `${m.name} [MoveId ${m.id}]`;
  assert(m.totalFrames > 0, `${where}: totalFrames must be positive, got ${m.totalFrames}`);
  assert(m.timeline.length > 0, `${where}: timeline is empty`);
  assert(m.timeline[0]!.at === 0, `${where}: timeline[0].at must be 0, got ${m.timeline[0]!.at}`);

  // Sticky state, carried frame to frame.
  let hurt: readonly FxBox[] = NO_BOXES;
  let hit: readonly CompiledHit[] = NO_HITS;
  let throwBox: readonly CompiledThrow[] = NO_THROWS;
  let pushbox: FxBox = fallbackPush;
  let friction: FX = ONE;
  let flags = 0;

  const frames: CompiledFrame[] = [];
  let k = 0;
  let prevAt = -1;

  for (let f = 0; f < m.totalFrames; f++) {
    // Impulses: default to "do not set" every frame.
    let velX: FX = VEL_KEEP;
    let velY: FX = VEL_KEEP;
    let sfx: SfxId = SfxId.NONE;

    while (k < m.timeline.length && m.timeline[k]!.at === f) {
      const kf = m.timeline[k]!;
      assert(kf.at > prevAt, `${where}: keyframe .at must strictly ascend, saw ${kf.at} after ${prevAt}`);
      prevAt = kf.at;

      if (kf.hurt !== undefined) {
        hurt = kf.hurt.map((b, i) => conceptBox(b, cs, `${where} f${f} hurt[${i}]`));
      }
      if (kf.hit !== undefined) {
        hit = kf.hit.map((h, i) => ({
          box: conceptBox(h.box, cs, `${where} f${f} hit[${i}]`),
          props: compileHitProps(h.props, `${where} f${f} hit[${i}]`, powerPct),
        }));
      }
      if (kf.throwBox !== undefined) {
        throwBox = kf.throwBox.map((t, i) => ({
          box: conceptBox(t.box, cs, `${where} f${f} throwBox[${i}]`),
          props: compileThrowProps(t.props, `${where} f${f} throwBox[${i}]`),
        }));
      }
      if (kf.pushbox !== undefined) pushbox = conceptBox(kf.pushbox, cs, `${where} f${f} pushbox`);
      if (kf.velX !== undefined) velX = toFx(kf.velX, `${where} f${f}.velX`);
      if (kf.velY !== undefined) velY = toFx(kf.velY, `${where} f${f}.velY`);
      if (kf.friction !== undefined) friction = toFx(kf.friction, `${where} f${f}.friction`);
      if (kf.flags !== undefined) flags = kf.flags;
      if (kf.sfx !== undefined) sfx = kf.sfx;
      k++;
    }

    frames.push({ hurt, hit, throwBox, pushbox, velX, velY, friction, flags, sfx });
  }

  assert(
    k === m.timeline.length,
    `${where}: keyframe at frame ${m.timeline[k]?.at} is past totalFrames ${m.totalFrames}`,
  );

  // NOW trim. Every authored frame was expanded above, so the timeline is fully
  // consumed and the assert above still means what it says; stamina only
  // decides how many of the trailing recovery frames survive into the move the
  // sim actually runs. `recoverFrom` is one past the last hitbox, so this can
  // never reach startup or an active frame.
  if (totalFrames < frames.length) frames.length = totalFrames;

  // --- derived frame data ----------------------------------------------------
  // "Active" is any frame carrying a hitbox OR a throwbox, so a throw reports a
  // real startup to the block predicate and the F3 overlay.
  let activeFirst = -1;
  let activeLast = -1;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f]!;
    if (fr.hit.length === 0 && fr.throwBox.length === 0) continue;
    if (activeFirst < 0) activeFirst = f;
    activeLast = f;
  }

  // A move with no active frames is never "past startup", so it stays blockable
  // out of and cancellable by the normal rules.
  const startup = activeFirst < 0 ? totalFrames : activeFirst;

  // adv = stun - (totalFrames - 1 - firstActiveFrame). Hitstop is symmetric by
  // contract, so it cancels out of both sides and advantage is arithmetic.
  let advHit = 0;
  let advBlock = 0;
  if (activeFirst >= 0) {
    const firstProps = frames[activeFirst]!.hit[0]?.props;
    if (firstProps !== undefined) {
      const tail = totalFrames - 1 - activeFirst;
      advHit = firstProps.hitstun - tail;
      advBlock = firstProps.blockstun - tail;
    }
  }

  return {
    id: m.id,
    group: m.group,
    button: m.input.button,
    command: m.input.command ?? 0,
    negEdge: m.input.negEdge === true,
    dir: m.input.dir ?? 0,
    stateMask: m.stateMask,
    totalFrames,
    frames,
    cancels: m.cancels,
    selfChain: m.selfChain,
    landingRecovery: m.landingRecovery ?? 0,
    armorWindow: m.armor?.window ?? NO_ARMOR,
    armorHits: m.armor?.hits ?? 0,
    armorDamagePct: m.armor?.damagePct ?? 100,
    startup,
    activeFirst,
    activeLast,
    advHit,
    advBlock,
    anim: m.anim,
    poseHint: m.poseHint,
  };
};

// -----------------------------------------------------------------------------
// Characters
// -----------------------------------------------------------------------------

export const compileChar = (def: CharDef): CompiledChar => {
  const cs = def.conceptSpace;
  const where = `char ${def.name} (${def.dance})`;
  assert(cs.unitsPerPx > 0, `${where}: conceptSpace.unitsPerPx must be positive`);

  // The rig is not compiled (pose is presentation state), but a short restPose
  // or radii array silently leaves bones at the origin, which reads on screen as
  // a mysterious partial T-pose rather than as a data error.
  assert(
    def.restPose.length === BONE_COUNT,
    `${where}: restPose has ${def.restPose.length} entries, expected BONE_COUNT (${BONE_COUNT})`,
  );
  assert(
    def.stick.radii.length === BONE_COUNT,
    `${where}: stick.radii has ${def.stick.radii.length} entries, expected BONE_COUNT (${BONE_COUNT})`,
  );

  const standPush = conceptBox(def.standPush, cs, `${where}.standPush`);
  const ph = def.physics;
  const t = def.traits;
  for (const [k, v] of Object.entries(t)) {
    assert(
      Number.isFinite(v) && v >= TRAIT_MIN && v <= TRAIT_MAX,
      `${where}: trait ${k} is ${String(v)}, outside the ${TRAIT_MIN}..${TRAIT_MAX} band`,
    );
  }

  // MOVEMENT is horizontal — walk, dash, and the speed you carry into a jump.
  // JUMP is vertical — launch velocity only. Apex therefore scales with the
  // SQUARE of the rating and air time linearly, so one number moves both "how
  // high" and "how far", which is how a jump actually behaves. Floatiness stays
  // `gravity`, authored per character, because how high and how heavy are
  // different feels: Virtud is the only one who uses both knobs.
  const mv = (v: number): number => (v * t.movement) / 100;
  const jp = (v: number): number => (v * t.jump) / 100;

  const moves = new Array<CompiledMove | null>(MoveId.MOVE_COUNT).fill(null);
  for (const m of def.moves) {
    assert(m.id > MoveId.NONE && m.id < MoveId.MOVE_COUNT, `${where}: move "${m.name}" has an out-of-range MoveId ${m.id}`);
    assert(moves[m.id] === null, `${where}: MoveId ${m.id} is declared twice`);
    moves[m.id] = compileMove(m, cs, standPush, def.traits);
  }
  // moveOrder is the PRIORITY table the transition ladder walks, and a typo in
  // it would silently make a move unreachable rather than fail.
  for (const id of def.moveOrder) {
    assert(moves[id] != null, `${where}: moveOrder lists MoveId ${id}, which this character does not define`);
  }

  return {
    id: def.id,
    name: def.name,
    hp: def.hp,
    conceptSpace: cs,

    walkF: toFx(mv(ph.walkF), `${where}.walkF`),
    walkB: toFx(mv(ph.walkB), `${where}.walkB`),
    dashSpeed: toFx(mv(ph.dashSpeed), `${where}.dashSpeed`),
    dashFrames: ph.dashFrames | 0,
    backDashSpeed: toFx(mv(ph.backDashSpeed), `${where}.backDashSpeed`),
    backDashFrames: ph.backDashFrames | 0,
    runDash: ph.runDash,
    jumpSquat: ph.jumpSquat | 0,
    jumpVelY: toFx(jp(ph.jumpVelY), `${where}.jumpVelY`),
    jumpVelXF: toFx(mv(ph.jumpVelXF), `${where}.jumpVelXF`),
    jumpVelXB: toFx(mv(ph.jumpVelXB), `${where}.jumpVelXB`),
    gravity: toFx(ph.gravity, `${where}.gravity`),
    airDrag: toFx(ph.airDrag, `${where}.airDrag`),
    groundFriction: toFx(ph.groundFriction, `${where}.groundFriction`),
    airJumps: ph.airJumps | 0,
    // The authored weightPct is the baseline; the rating is mass on top of it.
    weightPct: byTrait(ph.weightPct, inverse(t.weight)),
    landingLag: ph.landingLag | 0,

    standPush,
    crouchPush: conceptBox(def.crouchPush, cs, `${where}.crouchPush`),
    airPush: conceptBox(def.airPush, cs, `${where}.airPush`),
    standHurt: def.standHurt.map((b, i) => conceptBox(b, cs, `${where}.standHurt[${i}]`)),
    crouchHurt: def.crouchHurt.map((b, i) => conceptBox(b, cs, `${where}.crouchHurt[${i}]`)),
    airHurt: def.airHurt.map((b, i) => conceptBox(b, cs, `${where}.airHurt[${i}]`)),

    moveOrder: def.moveOrder,
    moves,
    traits: t,
    def,
  };
};

// -----------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------

/**
 * Compiles a roster and a stage list into the simulation's read-only inputs.
 *
 * Both `chars` and `stages` are placed BY ENUM ID, never in argument order:
 * `registry.chars[CharId.A]` is character A no matter how the caller sorted the
 * array. Ids nobody supplied are left as holes — in M0 only character A and one
 * stage exist, so `chars` has length 1 — and `createState` asserts the slot it
 * was asked for is populated.
 */
export const compile: CompileFn = (chars, stages) => {
  const compiledChars: CompiledChar[] = [];
  const globalMoves = new Array<CompiledMove | null>(MoveId.MOVE_COUNT).fill(null);

  for (const def of chars) {
    const c = compileChar(def);
    assert(compiledChars[c.id] === undefined, `data/compile: CharId ${c.id} was compiled twice`);
    compiledChars[c.id] = c;

    for (let id = 0; id < c.moves.length; id++) {
      const m = c.moves[id];
      if (m == null) continue;
      assert(globalMoves[id] === null, `data/compile: MoveId ${id} is claimed by two characters`);
      globalMoves[id] = m;
    }
  }

  const compiledStages: StageDef[] = [];
  for (const st of stages) {
    assert(compiledStages[st.id] === undefined, `data/compile: StageId ${st.id} was supplied twice`);
    compiledStages[st.id] = st;
  }

  return { chars: compiledChars, moves: globalMoves, stages: compiledStages };
};

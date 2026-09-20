// =============================================================================
// SunForce — src/sim/physics.ts
// Phases 4, 5, 6 and 7 of the canonical frame order, in that order and as four
// separate calls, because src/sim/step.ts owns the order and this file owns the
// arithmetic:
//
//   4 integrate()     damping, authored impulses, position, then gravity
//   5 groundClamp()   ground, ceiling, landing
//   6 wallClamp()     hard walls, wallTouch (= "cornered")
//   7 separate()      pushbox separation with corner transfer
//
// HITSTOP IS PER FIGHTER AND IT APPLIES HERE TOO. Phase 3's freeze gate is not
// enough on its own: if a frozen fighter still integrated, a 14-frame kick
// freeze would slide the victim backwards while both fighters stand perfectly
// still, which is the exact opposite of the effect hitstop exists to produce.
// So every pass below skips a fighter with `hitstop > 0` — and the event ring,
// the frame counter, the camera and the sparks all keep running, which is what
// makes a big kick read as FIGHTERS FROZEN, WORLD EXPLODING.
//
// THE INTEGRATION ORDER IS NOT ARBITRARY — it is the one docs/FEEL-NUMBERS.md
// was measured with. Position is advanced BEFORE gravity is applied for the
// next frame:
//     pos += vel;  vel -= g
// With jumpVelY 24.2 and gravity 1.10 that gives apex
//     max over n of (n*v0 - g*n*(n-1)/2) = 22*24.2 - 1.1*231 = 278.3 -> 278 u
// and 45 airborne frames, both exactly as documented. Applying gravity first
// instead yields 254 u and 44 frames, so the jump arc in the design document
// would be a jump arc the game does not have.
//
// PUSHBOX SEPARATION IS PERFECTLY ANTISYMMETRIC. At exactly equal positions
// each fighter is pushed along -own.facing. There is NO tiebreak on slot index:
// `a.posX <= b.posX ? -1 : 1` with `a` hardcoded as fighter 0 is a real mirror
// bug, not a theoretical one — it is one of the three violations
// tests/mirror.test.ts was written to catch.
// =============================================================================

import {
  AIR_VS_AIR_PUSH, Ev, FF, KNOCKBACK_DECAY_PCT, MF, ONE, PUSH_SEP_AIR, PUSH_SEP_MAX,
  S, SfxId, SparkId, VEL_KEEP,
} from '@/core/contracts';
import type { FighterView, FX, PlayerIx, SimState, StageDef } from '@/core/contracts';
import { fxMul, fxPct } from '@/core/fixed';
import { charOf, stageCeilingFx, stageLeftFx, stageOf, stageRightFx } from '@/sim/state';
import {
  createWorldBox, currentFrame, isAirborne, moveOf, overlapX, overlaps, pushAabb,
} from '@/sim/collision';
import { packB, packExtra, pushEvent } from '@/sim/events';

/** Separation caps, converted once. Integer constants, so this is exact. */
const SEP_CAP_GROUND: FX = PUSH_SEP_MAX * ONE;
const SEP_CAP_AIR: FX = PUSH_SEP_AIR * ONE;

/** A wall contact below one world unit per frame is a nudge, not an impact. */
const WALL_HIT_SPEED: FX = ONE;

const boxA = createWorldBox();
const boxB = createWorldBox();

// -----------------------------------------------------------------------------
// PHASE 4 — integrate
// -----------------------------------------------------------------------------

/**
 * Damping, authored impulses, position, gravity. Once per fighter, skipping
 * anyone frozen in hitstop.
 *
 * ORDER WITHIN ONE FIGHTER
 *   1. damping applies to the velocity the fighter ARRIVED with,
 *   2. an authored keyframe velocity then OVERWRITES it, so `velX: 1.5` means
 *      exactly 1.5 u/f on that frame and not 1.5 * friction,
 *   3. position advances,
 *   4. gravity is applied for the next frame (see the arc proof above).
 *
 * VEL_KEEP. CompiledFrame.velX/velY is VEL_KEEP on every frame the timeline did
 * not author a velocity. Assigning it blind writes 0x7fffffff into posX and the
 * fighter leaves the solar system.
 */
export const integrate = (s: SimState): void => {
  for (let p = 0; p < 2; p++) {
    const f = s.fighter(p as PlayerIx);
    if (f.hitstop > 0) continue;

    const c = charOf(s, p as PlayerIx);
    const fr = currentFrame(s, p as PlayerIx);
    const air = isAirborne(f);

    // --- 1. damping ----------------------------------------------------------
    if (air) {
      f.velX = fxMul(f.velX, c.airDrag);
    } else if (f.hitstun > 0 || f.blockstun > 0) {
      // Knockback decay. fxPct truncates toward zero, so leftward and rightward
      // knockback decay to the same magnitude. `>> 8` would not. See core/fixed.
      f.velX = fxPct(f.velX, KNOCKBACK_DECAY_PCT);
    } else if (fr !== null) {
      f.velX = fxMul(f.velX, fr.friction);
    } else if (f.state !== S.WALK_F && f.state !== S.WALK_B
      && f.state !== S.DASH_F && f.state !== S.DASH_B) {
      // States that drive their own velocity every frame (walks, dashes) must
      // not also be damped, or a 4.0 u/f walk quietly becomes 3.36 u/f.
      f.velX = fxMul(f.velX, c.groundFriction);
    }

    // --- 2. authored impulses ------------------------------------------------
    if (fr !== null) {
      // Authored x is FACING-RELATIVE (+x forward); authored y is absolute.
      if (fr.velX !== VEL_KEEP) f.velX = fr.velX * f.facing;
      if (fr.velY !== VEL_KEEP) f.velY = fr.velY;
    }

    // --- 3. position ---------------------------------------------------------
    f.posX = (f.posX + f.velX) | 0;
    f.posY = (f.posY + f.velY) | 0;

    // --- 4. gravity for the next frame --------------------------------------
    if (air && (fr === null || (fr.flags & MF.NO_GRAVITY) === 0)) {
      // gravityMulPct rises 10% per air hit so juggles self-terminate. It
      // initialises to 100, never 0 — a reset that zeroes it turns gravity off.
      f.velY = (f.velY - fxPct(c.gravity, f.gravityMulPct)) | 0;
    }
  }
};

// -----------------------------------------------------------------------------
// PHASE 5 — ground and ceiling
// -----------------------------------------------------------------------------

/**
 * Clamps a fighter to the ground line (y = 0) and to the stage ceiling, and
 * owns the landing transition: it clears FF.AIRBORNE, raises FF.JUST_LANDED for
 * sim/fighter.ts to consume on the next frame, charges landing recovery and
 * emits Ev.LAND.
 *
 * Landing recovery comes from the AIR MOVE if one is playing
 * (CompiledMove.landingRecovery — the whole point of a move being punishable on
 * landing), and from the character otherwise.
 */
export const groundClamp = (s: SimState): void => {
  const ceiling = stageCeilingFx(stageOf(s));

  for (let p = 0; p < 2; p++) {
    const ix = p as PlayerIx;
    const f = s.fighter(ix);
    if (f.hitstop > 0) continue;

    if (f.posY > 0) {
      f.flags |= FF.AIRBORNE;
      if (f.posY > ceiling) {
        f.posY = ceiling;
        if (f.velY > 0) f.velY = 0;
      }
      continue;
    }

    const wasAirborne = (f.flags & FF.AIRBORNE) !== 0;
    f.posY = 0;
    if (f.velY < 0) f.velY = 0;

    if (!wasAirborne) continue;

    const m = moveOf(s, ix);
    f.flags = (f.flags & ~FF.AIRBORNE) | FF.JUST_LANDED;
    f.landingLag = m !== null && m.landingRecovery > 0
      ? m.landingRecovery
      : charOf(s, ix).landingLag;
    f.airJumpsUsed = 0;
    // Juggle gravity is a property of ONE trip through the air, so it ends when
    // the trip does. Left to decay only at resetRound it would survive the
    // combo that raised it and quietly apply up to 180% gravity to every jump
    // that fighter made for the rest of the round — the 45-frame, 278-unit arc
    // in docs/FEEL-NUMBERS.md would be an arc only the first jump ever has.
    f.gravityMulPct = 100;
    pushEvent(s, Ev.LAND, ix, packB(0, SfxId.LAND), f.posX, 0, packExtra(SparkId.DUST, 0, 0, 0));
  }
};

// -----------------------------------------------------------------------------
// PHASE 6 — walls
// -----------------------------------------------------------------------------

/**
 * `wallTouch` is THE cornered flag: -1 against the left wall, +1 against the
 * right, 0 free. hits.commit freezes it and pushbox separation reads it, so
 * "cornering sticks" is one integer rather than three modules each deciding
 * what a corner is.
 */
const clampToWalls = (f: FighterView, lo: FX, hi: FX): number => {
  if (f.posX <= lo) {
    f.posX = lo;
    return -1;
  }
  if (f.posX >= hi) {
    f.posX = hi;
    return 1;
  }
  return 0;
};

export const wallClamp = (s: SimState): void => {
  const st: StageDef = stageOf(s);
  const lo = stageLeftFx(st);
  const hi = stageRightFx(st);

  for (let p = 0; p < 2; p++) {
    const ix = p as PlayerIx;
    const f = s.fighter(ix);
    const was = f.wallTouch;
    const touch = clampToWalls(f, lo, hi);
    f.wallTouch = touch;
    if (touch === 0) continue;

    const speed = f.velX < 0 ? -f.velX : f.velX;
    const intoWall = (touch < 0 && f.velX < 0) || (touch > 0 && f.velX > 0);
    if (!intoWall) continue;
    if (was === 0 && speed >= WALL_HIT_SPEED && f.hitstop === 0) {
      pushEvent(s, Ev.WALL_HIT, ix, packB(0, SfxId.WALL_HIT), f.posX, f.posY, packExtra(SparkId.DUST, 0, 0, 0));
    }
    f.velX = 0;
  }
};

// -----------------------------------------------------------------------------
// PHASE 7 — pushbox separation
// -----------------------------------------------------------------------------

/** True when this fighter cannot give ground in `dir`: walled, or frozen. */
const blockedTowards = (f: FighterView, dir: number): boolean =>
  f.hitstop > 0 || (dir < 0 && f.wallTouch < 0) || (dir > 0 && f.wallTouch > 0);

/** Centre of a world box on x. Truncates toward zero, so it mirrors exactly. */
const centreX = (x0: FX, x1: FX): FX => ((x0 + x1) / 2) | 0;

/**
 * Separates overlapping pushboxes, symmetrically, capped, with corner transfer.
 *
 * THE EQUAL-POSITION RULE. When the two centres are exactly equal there is no
 * "who is on the left" to read, so each fighter is pushed along -own.facing.
 * Two fighters facing each other separate; the result is the exact negation of
 * itself under the mirror transform; and no fighter slot is privileged. The
 * obvious alternative — comparing posX and breaking the tie by slot index —
 * silently makes P1's side different from P2's.
 *
 * CORNER TRANSFER. A fighter that cannot move (against a wall, or frozen in
 * hitstop) donates its half to the other, up to the same per-frame cap. This is
 * what makes cornering stick: the attacker is pushed out of the corner it is
 * trying to hold rather than both fighters sinking into the wall.
 *
 * AIR-VS-AIR IS DISABLED (AIR_VS_AIR_PUSH = false), the standard convention:
 * juggled opponents must not be shoved out of a combo by the pushbox pass.
 */
export const separate = (s: SimState): void => {
  const a = s.fighter(0);
  const b = s.fighter(1);

  const aAir = isAirborne(a);
  const bAir = isAirborne(b);
  if (!AIR_VS_AIR_PUSH && aAir && bAir) return;
  if (a.hitstop > 0 && b.hitstop > 0) return;

  pushAabb(a, boxA);
  pushAabb(b, boxB);
  if (!overlaps(boxA, boxB)) return;

  const depth = overlapX(boxA, boxB);
  if (depth <= 0) return;

  const ca = centreX(boxA.x0, boxA.x1);
  const cb = centreX(boxB.x0, boxB.x1);
  let dirA: number;
  if (ca < cb) dirA = -1;
  else if (ca > cb) dirA = 1;
  else dirA = -a.facing;
  const dirB = ca === cb ? -b.facing : -dirA;

  const cap = aAir || bAir ? SEP_CAP_AIR : SEP_CAP_GROUND;
  // Both fighters move the SAME amount, and `(depth + 1) / 2 | 0` rounds up so
  // an odd overlap fully separates instead of leaving one unit of jitter.
  let half = ((depth + 1) / 2) | 0;
  if (half > cap) half = cap;

  const aBlocked = blockedTowards(a, dirA);
  const bBlocked = blockedTowards(b, dirB);
  let moveA = aBlocked ? 0 : half;
  let moveB = bBlocked ? 0 : half;
  if (aBlocked && !bBlocked) moveB = depth > cap ? cap : depth;
  if (bBlocked && !aBlocked) moveA = depth > cap ? cap : depth;

  if (moveA !== 0) a.posX = (a.posX + moveA * dirA) | 0;
  if (moveB !== 0) b.posX = (b.posX + moveB * dirB) | 0;

  // Separation must never push anyone through a wall, and `wallTouch` has to
  // stay true after the last thing that moves a fighter this frame.
  const st = stageOf(s);
  const lo = stageLeftFx(st);
  const hi = stageRightFx(st);
  a.wallTouch = clampToWalls(a, lo, hi);
  b.wallTouch = clampToWalls(b, lo, hi);
};

/**
 * True when a fighter pinned at `wallTouch` cannot give ground in `awayDir`, so
 * its pushback belongs to the attacker instead. hits.commit uses this against
 * the FROZEN pre-commit snapshot, which is why it takes the flag and not a
 * live view.
 */
export const corneredTowards = (wallTouch: number, awayDir: number): boolean =>
  (awayDir < 0 && wallTouch < 0) || (awayDir > 0 && wallTouch > 0);

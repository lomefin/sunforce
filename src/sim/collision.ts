// =============================================================================
// SunForce — src/sim/collision.ts
// Axis-aligned integer collision, and the GATHER pass (phase 8 of the canonical
// frame order).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: gather() APPLIES NOTHING.
// It takes ONE position snapshot, tests every box pair for BOTH fighters
// against that snapshot, and writes its findings into a caller-owned result.
// Damage, stun, knockback and state changes all happen later, in hits.commit,
// from a frozen pre-commit snapshot. Resolving a hit the moment it is found is
// what makes simultaneous hits order-dependent: the first fighter resolved
// moves, and the second fighter is then tested against a position the first
// fighter's own knockback created. P1 hits, P2 whiffs, and it only reproduces
// on one side of the screen.
//
// FIGHTER-LOCAL BOXES ARE FACING-RELATIVE. compile.ts emits +x = FORWARD and
// does NOT apply facing; this file is the only place that does. For facing = -1
// a local interval [x, x+w] maps to world [posX - x - w, posX - x], which is
// the exact negation about posX of the facing = +1 case — no rounding, no
// asymmetry, nothing for tests/mirror.test.ts to catch.
//
// EDGES DO NOT TOUCH. Overlap is four STRICT compares, so two boxes that share
// an edge exactly do not collide. Integer coordinates make that decision exact
// and identical on every machine; there is no epsilon anywhere in this file.
// =============================================================================

import { FF, Gd, MF, MoveId, S } from '@/core/contracts';
import type {
  CompiledChar, CompiledFrame, CompiledHit, CompiledMove, CompiledThrow, FighterView,
  FX, FxBox, PlayerIx, SimState,
} from '@/core/contracts';
import { charOf, otherPlayer } from '@/sim/state';

// -----------------------------------------------------------------------------
// World-space AABB
// -----------------------------------------------------------------------------

/** A world-space axis-aligned box. Mutable so callers can reuse one forever. */
export interface WorldBox {
  x0: FX;
  y0: FX;
  x1: FX;
  y1: FX;
}

export const createWorldBox = (): WorldBox => ({ x0: 0, y0: 0, x1: 0, y1: 0 });

/**
 * Fighter-local, facing-relative box -> world AABB, written into `out`.
 *
 * `posX`/`posY` are the fighter's origin (feet centre, y = 0 on the ground) and
 * `facing` is +1 or -1. This is the ONLY transform between compiled box data
 * and world space; gfx/debugdraw.ts draws exactly what this produces, which is
 * what makes M0 acceptance test 6 ("the boxes line up with the limbs") a real
 * end-to-end proof of concept space -> world space.
 */
export const worldBox = (
  posX: FX, posY: FX, facing: number, b: FxBox, out: WorldBox,
): WorldBox => {
  if (facing >= 0) {
    out.x0 = posX + b.x;
    out.x1 = posX + b.x + b.w;
  } else {
    out.x0 = posX - b.x - b.w;
    out.x1 = posX - b.x;
  }
  out.y0 = posY + b.y;
  out.y1 = posY + b.y + b.h;
  return out;
};

/** Four strict compares. Exact, allocation-free, no epsilon. */
export const overlaps = (a: WorldBox, b: WorldBox): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Overlap depth on x, <= 0 when the boxes do not overlap on x. */
export const overlapX = (a: WorldBox, b: WorldBox): FX =>
  (a.x1 < b.x1 ? a.x1 : b.x1) - (a.x0 > b.x0 ? a.x0 : b.x0);

/** Overlap depth on y, <= 0 when the boxes do not overlap on y. */
export const overlapY = (a: WorldBox, b: WorldBox): FX =>
  (a.y1 < b.y1 ? a.y1 : b.y1) - (a.y0 > b.y0 ? a.y0 : b.y0);

/**
 * Centre of a ∩ b on x. THE SPARK SPAWNS HERE — at the centroid of hitbox ∩
 * hurtbox, never at the attacker's hand. Almost every amateur fighting game
 * gets this wrong and it is most of what makes a hit look connected.
 *
 * `(lo + hi) / 2 | 0` truncates toward zero, so the mirrored pair produces the
 * exact negation. `>> 1` would floor and break that.
 */
export const contactX = (a: WorldBox, b: WorldBox): FX => {
  const lo = a.x0 > b.x0 ? a.x0 : b.x0;
  const hi = a.x1 < b.x1 ? a.x1 : b.x1;
  return ((lo + hi) / 2) | 0;
};

export const contactY = (a: WorldBox, b: WorldBox): FX => {
  const lo = a.y0 > b.y0 ? a.y0 : b.y0;
  const hi = a.y1 < b.y1 ? a.y1 : b.y1;
  return ((lo + hi) / 2) | 0;
};

// -----------------------------------------------------------------------------
// What a fighter is showing this frame
// -----------------------------------------------------------------------------

export const isAirborne = (f: FighterView): boolean => (f.flags & FF.AIRBORNE) !== 0;

export const isCrouching = (f: FighterView): boolean => (f.flags & FF.CROUCHING) !== 0;

/** The CompiledMove a fighter is playing, or null when it is not in an action. */
export const moveOf = (s: SimState, p: PlayerIx): CompiledMove | null => {
  const f = s.fighter(p);
  if (f.action === MoveId.NONE) return null;
  return charOf(s, p).moves[f.action] ?? null;
};

/**
 * The dense frame a fighter's action is on, or null when it is not in an action.
 * Never allocates and never searches: compile.ts already expanded the timeline.
 */
export const currentFrame = (s: SimState, p: PlayerIx): CompiledFrame | null => {
  const m = moveOf(s, p);
  if (m === null) return null;
  const f = s.fighter(p);
  if (f.actionFrame < 0 || f.actionFrame >= m.totalFrames) return null;
  return m.frames[f.actionFrame] ?? null;
};

/** Empty singleton for an invulnerable frame. Read-only, shared, never mutated. */
const NO_BOXES: readonly FxBox[] = [];

/**
 * The hurtboxes a fighter presents right now.
 *
 * An action OWNS its hurtboxes — that is the whole point of authoring the arm
 * as a hurtbox on a jab's active frames — so a fighter in S.ACTION uses the
 * timeline's set even when it is empty, which is how MF.INVULN and an authored
 * `hurt: []` both read as "cannot be hit" rather than falling back to standing.
 */
export const hurtBoxesOf = (s: SimState, p: PlayerIx): readonly FxBox[] => {
  const f = s.fighter(p);
  const fr = currentFrame(s, p);
  if (fr !== null) {
    return (fr.flags & MF.INVULN) !== 0 ? NO_BOXES : fr.hurt;
  }
  const c = charOf(s, p);
  if (isAirborne(f)) return c.airHurt;
  if (isCrouching(f)) return c.crouchHurt;
  return c.standHurt;
};

/**
 * The pushbox a fighter should be carrying this frame. sim/fighter.ts copies it
 * into the state buffer every frame (f.pushX/pushY/pushW/pushH) so that physics
 * reads four words instead of chasing the move tables, and so a fighter frozen
 * in hitstop keeps the box it was frozen with.
 */
export const pushBoxOf = (s: SimState, p: PlayerIx): FxBox => {
  const fr = currentFrame(s, p);
  if (fr !== null) return fr.pushbox;
  const f = s.fighter(p);
  const c: CompiledChar = charOf(s, p);
  if (isAirborne(f)) return c.airPush;
  if (isCrouching(f)) return c.crouchPush;
  return c.standPush;
};

/** The fighter's live pushbox, in world space, from the four buffered words. */
export const pushAabb = (f: FighterView, out: WorldBox): WorldBox => {
  if (f.facing >= 0) {
    out.x0 = f.posX + f.pushX;
    out.x1 = f.posX + f.pushX + f.pushW;
  } else {
    out.x0 = f.posX - f.pushX - f.pushW;
    out.x1 = f.posX - f.pushX;
  }
  out.y0 = f.posY + f.pushY;
  out.y1 = f.posY + f.pushY + f.pushH;
  return out;
};

/** One hitId occupies one bit of `f.hitIdsUsed`. hitId is 1..30 by contract. */
export const hitIdBit = (hitId: number): number => 1 << ((hitId - 1) & 31);

// -----------------------------------------------------------------------------
// GATHER — phase 8. Finds; never applies.
// -----------------------------------------------------------------------------

/** One attacker's strike contact for this frame, or `hit === null` for none. */
export interface HitCandidate {
  readonly attacker: PlayerIx;
  readonly defender: PlayerIx;
  /** null = this attacker connected with nothing this frame. */
  hit: CompiledHit | null;
  /** Centroid of hitbox ∩ hurtbox. Where the spark goes. */
  contactX: FX;
  contactY: FX;
}

/** One attacker's throw contact for this frame. */
export interface ThrowCandidate {
  readonly attacker: PlayerIx;
  readonly defender: PlayerIx;
  grab: CompiledThrow | null;
  contactX: FX;
  contactY: FX;
}

/**
 * The result of one gather.
 *
 * INDEXED BY ATTACKER SLOT, never a list. A list would impose an order on
 * simultaneous contacts, and an order is exactly the thing that leaks into the
 * result and makes a trade resolve differently for P1 and P2. With one fixed
 * cell per attacker there is no order to leak: hits.commit walks both cells and
 * both read the same frozen snapshot.
 */
export interface GatherResult {
  readonly hit: readonly [HitCandidate, HitCandidate];
  readonly grab: readonly [ThrowCandidate, ThrowCandidate];
}

export const createGatherResult = (): GatherResult => ({
  hit: [
    { attacker: 0, defender: 1, hit: null, contactX: 0, contactY: 0 },
    { attacker: 1, defender: 0, hit: null, contactX: 0, contactY: 0 },
  ],
  grab: [
    { attacker: 0, defender: 1, grab: null, contactX: 0, contactY: 0 },
    { attacker: 1, defender: 0, grab: null, contactX: 0, contactY: 0 },
  ],
});

/** Clears a result without allocating. gather() calls this first. */
export const clearGather = (g: GatherResult): void => {
  for (let p = 0; p < 2; p++) {
    const h = g.hit[p]!;
    h.hit = null;
    h.contactX = 0;
    h.contactY = 0;
    const t = g.grab[p]!;
    t.grab = null;
    t.contactX = 0;
    t.contactY = 0;
  }
};

// The ONE position snapshot, plus scratch boxes. Module-level and reused: the
// simulation is single-threaded and gather() is not re-entrant.
const snapX: FX[] = [0, 0];
const snapY: FX[] = [0, 0];
const snapFacing: number[] = [0, 0];
const boxA: WorldBox = createWorldBox();
const boxB: WorldBox = createWorldBox();

/** True when this strike cannot connect with this defender at all. */
const whiffsOnGuard = (guard: number, defAirborne: boolean): boolean =>
  (guard & Gd.AIR_ONLY) !== 0 && !defAirborne;

/**
 * PHASE 8. Collects every potential contact for BOTH fighters against ONE
 * position snapshot, and applies nothing.
 *
 * A fighter in hitstop is not gathered as an attacker: its action is frozen, so
 * its hitbox is frozen too, and the hit it already landed is recorded in
 * `hitIdsUsed`. Testing it again every frozen frame would find the same box in
 * the same place for 9 or 14 frames.
 *
 * At most one strike per attacker per frame. A multi-hit move separates its
 * hits by frame, not by stacking two boxes on one frame, and `hitIdsUsed` keeps
 * one hitId from connecting twice in the same action.
 */
export const gather = (s: SimState, out: GatherResult): void => {
  clearGather(out);

  // ONE SNAPSHOT. Everything below reads these, never the live view, so the
  // order the two attackers are tested in cannot matter.
  for (let p = 0; p < 2; p++) {
    const f = s.fighter(p as PlayerIx);
    snapX[p] = f.posX;
    snapY[p] = f.posY;
    snapFacing[p] = f.facing;
  }

  for (let p = 0; p < 2; p++) {
    const atk = p as PlayerIx;
    const def = otherPlayer(atk);
    const a = s.fighter(atk);
    if (a.hitstop > 0) continue;
    if (a.state !== S.ACTION) continue;

    const fr = currentFrame(s, atk);
    if (fr === null) continue;
    if (fr.hit.length === 0 && fr.throwBox.length === 0) continue;

    const d = s.fighter(def);
    const defAir = isAirborne(d);
    const hurt = hurtBoxesOf(s, def);
    const used = a.hitIdsUsed;

    // --- strikes vs hurtboxes ------------------------------------------------
    if (hurt.length > 0) {
      const cell = out.hit[atk]!;
      scan: for (let i = 0; i < fr.hit.length; i++) {
        const h = fr.hit[i]!;
        if ((used & hitIdBit(h.props.hitId)) !== 0) continue;
        if (whiffsOnGuard(h.props.guard, defAir)) continue;
        worldBox(snapX[atk]!, snapY[atk]!, snapFacing[atk]!, h.box, boxA);
        for (let j = 0; j < hurt.length; j++) {
          worldBox(snapX[def]!, snapY[def]!, snapFacing[def]!, hurt[j]!, boxB);
          if (!overlaps(boxA, boxB)) continue;
          cell.hit = h;
          cell.contactX = contactX(boxA, boxB);
          cell.contactY = contactY(boxA, boxB);
          break scan;
        }
      }
    }

    // --- throws vs the defender's pushbox ------------------------------------
    // A throw tests against the pushbox, not the hurtboxes: it is a grab at a
    // body, so it must not be dodged by a move that shrinks its hurtboxes, and
    // it must still connect on a frame the defender is strike-invulnerable.
    if (fr.throwBox.length > 0 && (d.flags & FF.THROW_IMMUNE) === 0) {
      const cell = out.grab[atk]!;
      worldBox(snapX[def]!, snapY[def]!, snapFacing[def]!, pushBoxOf(s, def), boxB);
      for (let i = 0; i < fr.throwBox.length; i++) {
        const t = fr.throwBox[i]!;
        if (defAir && !t.props.hitsAir) continue;
        if (!defAir && t.props.hitsAir) continue;
        worldBox(snapX[atk]!, snapY[atk]!, snapFacing[atk]!, t.box, boxA);
        if (!overlaps(boxA, boxB)) continue;
        cell.grab = t;
        cell.contactX = contactX(boxA, boxB);
        cell.contactY = contactY(boxA, boxB);
        break;
      }
    }
  }
};

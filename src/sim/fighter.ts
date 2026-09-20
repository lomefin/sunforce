// =============================================================================
// SunForce — src/sim/fighter.ts
// THE STATE MACHINE. Phase 3 of the canonical frame order, for one fighter.
//
// TRANSITIONS HAVE EXACTLY ONE OWNER: resolveTransitions, one function, one
// switch, one fixed priority ladder. No enter/exit callbacks, no state objects,
// no observers, and no second place that assigns `f.state`. Two writers to one
// state variable is how a fighting game acquires the bug where a move comes out
// of hitstun, and it is never found by reading either writer alone.
//
// THE LADDER, highest priority first:
//   0. round is not FIGHT      -> nothing voluntary happens
//   1. KO                      -> S.KO, terminal until resetRound
//   2. hitstun / blockstun     -> forced, and they TICK INSIDE the hitstop gate
//   3. the action is over      -> release, then fall through to 4/5/6
//   4. cancel window & buffer  -> the next move, by moveOrder priority
//   5. movement                -> walk forward / back
//   6. idle                    -> stand
//
// WHAT IS CLEARED IN startAction AND NOWHERE ELSE: hitIdsUsed, usedCancels,
// chainDepth, chainMoveId, lastContact and the two CONFIRMED flags. Reading
// hitIdsUsed without ever writing it, or never clearing usedCancels, is the
// documented way to ship a gatling system that works once per round.
//
// M0 STATES: STAND, WALK_F, WALK_B, JUMP_SQUAT, JUMP_RISE, JUMP_FALL, LANDING,
// ACTION, HITSTUN_*, BLOCKSTUN_*, KO.
// Crouch, dash, knockdown and wakeup are deferred; their cases are present in
// the switch and resolve to neutral rather than being absent, so a state that
// arrives early can never wedge a fighter.
//
// THE JUMP IS FOUR STATES AND THE TWO ENDS ARE THE POINT. JUMP_SQUAT is a
// GROUND state in no move's stateMask: four frames of commitment, throwable and
// punishable. LANDING holds landingLag frames, which is what makes a whiffed
// jump-in punishable. Delete either end and the correct play is to jump
// forever. The airborne middle belongs to sim/physics.ts.
// =============================================================================

import {
  B, Contact, Ev, FF, INPUT_LENIENCY, MF, MoveId, RoundState, S, SfxId,
} from '@/core/contracts';
import type {
  ButtonMask, CompiledMove, FighterView, GroupMask, PlayerIx, SimState,
} from '@/core/contracts';
import { On } from '@/core/contracts';
import {
  ringConsume, ringConsumed, ringFindPress, ringHeld, ringReleaseEdge,
} from '@/core/ring';
import { charOf, otherPlayer } from '@/sim/state';
import { currentFrame, isAirborne, moveOf, pushBoxOf } from '@/sim/collision';
import { endCombo } from '@/sim/hits';
import { packB, pushEvent } from '@/sim/events';

// -----------------------------------------------------------------------------
// Small state helpers
// -----------------------------------------------------------------------------

/** Changing state resets stateFrame; re-entering the same state does not. */
const setState = (f: FighterView, st: S): void => {
  if (f.state === st) return;
  f.state = st;
  f.stateFrame = 0;
};

const isHitstun = (st: S): boolean =>
  st === S.HITSTUN_STAND || st === S.HITSTUN_CROUCH || st === S.HITSTUN_AIR;

const isBlockstun = (st: S): boolean =>
  st === S.BLOCKSTUN_STAND || st === S.BLOCKSTUN_CROUCH || st === S.BLOCKSTUN_AIR;

/** Facing-relative direction bits. The ring stores ABSOLUTE directions. */
const forwardBit = (f: FighterView): ButtonMask => (f.facing >= 0 ? B.R : B.L);
const backBit = (f: FighterView): ButtonMask => (f.facing >= 0 ? B.L : B.R);

// -----------------------------------------------------------------------------
// PHASE 3a — timers
// -----------------------------------------------------------------------------

/**
 * Ticks every per-fighter countdown. Called INSIDE the hitstop gate, which is
 * the whole point: a fighter frozen in hitstop must not burn hitstun, or every
 * combo loses 9 to 14 frames of advantage and drops.
 *
 * A fighter is actionable on the frame its counter reaches zero, so `hitstun`
 * is "frames until this fighter may act again", counted from the frame after
 * the hit. See the note in the module summary returned with this work: this is
 * one frame shorter than the printed advHit/advBlock table, which counts the
 * defender's stun from the hit frame and the attacker's recovery from the frame
 * after it.
 */
export const tickTimers = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);
  if (f.hitstun > 0) {
    f.hitstun--;
    // A combo is over the instant the victim can act again. Ending it here,
    // from the victim's own timer, keeps the HUD counter honest without any
    // module polling the other fighter.
    if (f.hitstun === 0) endCombo(s, otherPlayer(p));
  }
  if (f.blockstun > 0) f.blockstun--;
  if (f.knockdownTimer > 0) f.knockdownTimer--;
  if (f.wakeupTimer > 0) f.wakeupTimer--;
  if (f.landingLag > 0) f.landingLag--;
  if (f.dashTimer > 0) f.dashTimer--;
  if (f.throwTechTimer > 0) f.throwTechTimer--;
  if (f.throwHoldTimer > 0) f.throwHoldTimer--;
};

// -----------------------------------------------------------------------------
// Move matching
// -----------------------------------------------------------------------------

/** Is the required directional hold satisfied this frame? 0 none, 2 D, 4 back, 6 fwd. */
const dirHeld = (s: SimState, p: PlayerIx, dir: 0 | 2 | 4 | 6): boolean => {
  if (dir === 0) return true;
  const held = ringHeld(s.buf, p, s.g.frame);
  if (dir === 2) return (held & B.D) !== 0;
  const f = s.fighter(p);
  return (held & (dir === 6 ? forwardBit(f) : backBit(f))) !== 0;
};

/** Newest unconsumed RELEASE of `bits` within the leniency window, or -1. */
const findRelease = (s: SimState, p: PlayerIx, bits: ButtonMask): number => {
  const frame = s.g.frame;
  const oldest = frame - INPUT_LENIENCY > 0 ? frame - INPUT_LENIENCY : 0;
  for (let fr = frame; fr >= oldest; fr--) {
    if ((ringReleaseEdge(s.buf, p, fr) & bits & ~ringConsumed(s.buf, p, fr)) !== 0) return fr;
  }
  return -1;
};

/**
 * The input frame that would start `m`, or -1. Consuming is the CALLER's job,
 * and only after it has decided the move actually comes out — a press retired
 * by a move that was then rejected is a press the player never gets back.
 */
const inputFor = (s: SimState, p: PlayerIx, m: CompiledMove): number => {
  if (!dirHeld(s, p, m.dir)) return -1;
  if (m.command !== 0 && (s.fighter(p).commandMask & m.command) !== m.command) return -1;
  return m.negEdge
    ? findRelease(s, p, m.button)
    : ringFindPress(s.buf, p, s.g.frame, m.button, INPUT_LENIENCY);
};

/**
 * Groups this move can currently cancel into, for the F3 overlay and for tests.
 * The matcher below does NOT use this — it asks per candidate move so that a
 * rule's `onlyMoves` whitelist is honoured exactly rather than flattened away.
 */
export const cancelMask = (m: CompiledMove, actionFrame: number, contact: Contact): GroupMask => {
  const bit = contactBit(contact);
  let into = 0;
  for (let i = 0; i < m.cancels.length; i++) {
    const r = m.cancels[i]!;
    if (actionFrame < r.window[0] || actionFrame > r.window[1]) continue;
    if ((r.on & bit) === 0) continue;
    into |= r.into;
  }
  return into;
};

/** An armored connection still counts as a connection for cancel purposes. */
function contactBit(c: Contact): number {
  return c === Contact.HIT || c === Contact.ARMORED
    ? On.HIT
    : c === Contact.BLOCK ? On.BLOCK : On.WHIFF;
}

/** Does some cancel rule of `from` permit `into` right now? */
const cancelAllows = (
  from: CompiledMove, actionFrame: number, contact: Contact, into: CompiledMove,
): boolean => {
  const bit = contactBit(contact);
  for (let i = 0; i < from.cancels.length; i++) {
    const r = from.cancels[i]!;
    if (actionFrame < r.window[0] || actionFrame > r.window[1]) continue;
    if ((r.on & bit) === 0) continue;
    if ((r.into & into.group) === 0) continue;
    const only = r.onlyMoves;
    if (only !== undefined && only.length > 0 && !only.includes(into.id)) continue;
    return true;
  }
  return false;
};

// -----------------------------------------------------------------------------
// Starting a move
// -----------------------------------------------------------------------------

/**
 * THE one place an action begins. Everything a previous action accumulated is
 * cleared here, and the new move's frame 0 is applied immediately so that
 * phases 4 to 8 of this very frame see the right pushbox, flags and velocity.
 */
export const startAction = (s: SimState, p: PlayerIx, m: CompiledMove): void => {
  const f = s.fighter(p);
  f.prevAction = f.action;
  f.action = m.id;
  f.actionFrame = 0;
  f.state = S.ACTION;
  f.stateFrame = 0;

  f.hitIdsUsed = 0;
  f.usedCancels = 0;
  f.chainDepth = 0;
  f.chainMoveId = MoveId.NONE;
  f.lastContact = Contact.NONE;
  f.flags &= ~(FF.HIT_CONFIRMED | FF.BLOCK_CONFIRMED);

  applyFrameData(s, p, m, 0);
};

/** Ends the current action without starting another. */
const releaseAction = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);
  if (f.action !== MoveId.NONE) f.prevAction = f.action;
  f.action = MoveId.NONE;
  f.actionFrame = 0;
  f.flags &= ~FF.COUNTER_STATE;
  setState(f, isAirborne(f) ? S.JUMP_FALL : S.STAND);
  syncPushbox(s, p);
};

/**
 * Per-frame consequences of a move's timeline that live in the state buffer:
 * the pushbox, the airborne flag, the counter-hit window, the armor charge and
 * the frame's one-shot sound.
 */
const applyFrameData = (s: SimState, p: PlayerIx, m: CompiledMove, af: number): void => {
  const f = s.fighter(p);
  const fr = m.frames[af];
  if (fr === undefined) return;

  if ((fr.flags & MF.AIRBORNE) !== 0) f.flags |= FF.AIRBORNE;

  // Counter-hit state is the move's startup window. hits.commit reads the flag;
  // M0 leaves the bonus itself deferred, so this is the plumbing, live and
  // correct, waiting for one branch in decide().
  if (af < m.startup) f.flags |= FF.COUNTER_STATE;
  else f.flags &= ~FF.COUNTER_STATE;

  if (m.armorHits > 0 && af === m.armorWindow[0]) f.armorHitsLeft = m.armorHits;
  else if (m.armorHits > 0 && af > m.armorWindow[1]) f.armorHitsLeft = 0;

  // SfxId.NONE on every frame but its own, so firing unconditionally plays the
  // sound once instead of 29 times.
  if (fr.sfx !== SfxId.NONE) {
    pushEvent(s, Ev.WHIFF, p, packB(0, fr.sfx), f.posX, f.posY, 0);
  }

  syncPushbox(s, p);
};

/** Copies the frame's pushbox into the four state words physics reads. */
const syncPushbox = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);
  const b = pushBoxOf(s, p);
  f.pushX = b.x;
  f.pushY = b.y;
  f.pushW = b.w;
  f.pushH = b.h;
};

/**
 * Walks `moveOrder` — AUTHORED PRIORITY, never object-key order — and starts
 * the first move that is legal from this state and has a live press. `from`
 * non-null means we are looking for a CANCEL out of that move rather than a
 * fresh action, and the chain bookkeeping is carried across.
 */
const tryStartMove = (s: SimState, p: PlayerIx, from: CompiledMove | null): boolean => {
  const f = s.fighter(p);
  const c = charOf(s, p);
  const stateBit = 1 << f.state;
  const contact = f.lastContact;
  const af = f.actionFrame;
  const inheritedUsed = f.usedCancels;
  const chainId = f.chainMoveId;
  const chainDepth = f.chainDepth;

  for (let i = 0; i < c.moveOrder.length; i++) {
    const id = c.moveOrder[i]!;
    const m = c.moves[id];
    if (m == null) continue;
    if ((m.stateMask & stateBit) === 0) continue;

    let selfChained = false;
    if (from !== null) {
      if (!cancelAllows(from, af, contact, m)) continue;
      if (m.id === from.id) {
        // A move may chain into ITSELF only as often as its data allows.
        const used = chainId === m.id ? chainDepth : 0;
        if (used >= m.selfChain) continue;
        selfChained = true;
      } else if ((inheritedUsed & m.group) !== 0) {
        // Each group is available once per chain, so a gatling terminates.
        continue;
      }
    }

    const pressFrame = inputFor(s, p, m);
    if (pressFrame < 0) continue;

    ringConsume(s.buf, p, pressFrame, m.button);
    startAction(s, p, m);
    if (from !== null) {
      // startAction cleared these; the CHAIN owns them, so restore them here —
      // this is the one caller allowed to write them after a start.
      f.usedCancels = selfChained ? inheritedUsed : inheritedUsed | m.group;
      f.chainMoveId = selfChained ? m.id : MoveId.NONE;
      f.chainDepth = selfChained ? (chainId === m.id ? chainDepth : 0) + 1 : 0;
    }
    return true;
  }
  return false;
};

// -----------------------------------------------------------------------------
// Jumping
// -----------------------------------------------------------------------------

/** `FighterView.jumpDir`, FACING-RELATIVE so it mirrors: -1 back, 0 up, 1 fwd. */
const JUMP_NEUTRAL = 0;
const JUMP_FORWARD = 1;
const JUMP_BACK = -1;

/** What the stick is asking for, facing-relative, on the frame it is read. */
const jumpDirFrom = (f: FighterView, held: ButtonMask): number => {
  if ((held & forwardBit(f)) !== 0) return JUMP_FORWARD;
  if ((held & backBit(f)) !== 0) return JUMP_BACK;
  return JUMP_NEUTRAL;
};

/**
 * Enters jump squat — a GROUND state, deliberately committed: no stateMask in
 * the game contains S.JUMP_SQUAT, so nothing starts or cancels out of it and
 * the fighter stands there throwable for `jumpSquat` frames (A: 4).
 *
 * The UP press is RETIRED here. INPUT_LENIENCY is 6 and jump squat is 4, so a
 * press left in the ring is still inside the leniency window on the launch
 * frame and would immediately spend an air jump on the way up.
 */
const startJumpSquat = (s: SimState, p: PlayerIx, held: ButtonMask): void => {
  const f = s.fighter(p);
  const up = ringFindPress(s.buf, p, s.g.frame, B.U, INPUT_LENIENCY);
  if (up >= 0) ringConsume(s.buf, p, up, B.U);
  f.jumpDir = jumpDirFrom(f, held);
  // A squat is a full stop, so a walk's momentum does not leak into the arc.
  f.velX = 0;
  setState(f, S.JUMP_SQUAT);
};

/**
 * Leaves the ground. `dir` is facing-relative and is resolved to an ABSOLUTE
 * velocity exactly once, here: turning around in mid-air must never reverse a
 * jump already in flight, which is the whole basis of a crossup.
 *
 * Raising FF.AIRBORNE is the whole of "fly". Gravity, the ceiling and the
 * landing belong to sim/physics.ts, and a second copy of any of them here is
 * how the arc in docs/FEEL-NUMBERS.md stops being the arc the game has.
 */
const launchJump = (s: SimState, p: PlayerIx, dir: number): void => {
  const f = s.fighter(p);
  const c = charOf(s, p);
  f.jumpDir = dir;
  f.velY = c.jumpVelY;
  f.velX = dir === JUMP_FORWARD
    ? c.jumpVelXF * f.facing
    : dir === JUMP_BACK ? -c.jumpVelXB * f.facing : 0;
  f.flags |= FF.AIRBORNE;
  setState(f, S.JUMP_RISE);
  pushEvent(s, Ev.JUMP, p, packB(0, SfxId.JUMP), f.posX, f.posY, 0);
};

/**
 * An air jump, if this character has one left (A: 0, D: 1). groundClamp resets
 * `airJumpsUsed` on landing, so the budget is per jump, not per round.
 *
 * It needs a FRESH press. Reading the hold the way the ground jump does would
 * spend the double jump on the first airborne frame of every jump, because up
 * is still down from the jump that got the fighter up there.
 */
const tryAirJump = (s: SimState, p: PlayerIx): boolean => {
  const f = s.fighter(p);
  const c = charOf(s, p);
  if (f.airJumpsUsed >= c.airJumps) return false;
  const up = ringFindPress(s.buf, p, s.g.frame, B.U, INPUT_LENIENCY);
  if (up < 0) return false;
  ringConsume(s.buf, p, up, B.U);
  f.airJumpsUsed++;
  launchJump(s, p, jumpDirFrom(f, ringHeld(s.buf, p, s.g.frame)));
  return true;
};

// -----------------------------------------------------------------------------
// Ground movement
// -----------------------------------------------------------------------------

/**
 * Walking, and the entry to a jump. Velocity is SET every frame here, which is
 * exactly why physics.integrate does not apply ground friction in a walk state.
 *
 * UP OUTRANKS WALKING, and lives here rather than in the ladder so that every
 * route back to neutral — recovery, hitstun, blockstun, landing — can buffer a
 * jump out of itself through the one branch below.
 */
const groundMovement = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);
  const c = charOf(s, p);

  if (f.landingLag > 0) {
    setState(f, S.STAND);
    return;
  }

  const held = ringHeld(s.buf, p, s.g.frame);
  if ((held & B.U) !== 0) {
    startJumpSquat(s, p, held);
    return;
  }
  if ((held & forwardBit(f)) !== 0) {
    setState(f, S.WALK_F);
    f.velX = c.walkF * f.facing;
    return;
  }
  if ((held & backBit(f)) !== 0) {
    setState(f, S.WALK_B);
    f.velX = -c.walkB * f.facing;
    return;
  }
  setState(f, S.STAND);
};

/** Neutral: no action, walking or standing as the stick says. */
const toNeutral = (s: SimState, p: PlayerIx): void => {
  releaseAction(s, p);
  if (!isAirborne(s.fighter(p))) groundMovement(s, p);
};

// -----------------------------------------------------------------------------
// PHASE 3b — THE LADDER
// -----------------------------------------------------------------------------

/**
 * The ONLY function that assigns `f.state`. Call it once per fighter per frame,
 * inside the hitstop gate, after the timers have ticked.
 */
export const resolveTransitions = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);

  // --- 0. the round is not running ------------------------------------------
  if (s.g.roundState !== RoundState.FIGHT) return;

  // --- 1. KO. The knockback plays out first: a fighter killed mid-hitstun
  //        still flies, and only then locks into the KO pose. -----------------
  if (f.hp <= 0 && f.hitstun === 0) {
    if (f.state !== S.KO) {
      releaseAction(s, p);
      setState(f, S.KO);
    }
    return;
  }

  // --- 2. forced stun. hits.commit already chose the flavour (stand, crouch
  //        or air); this only repairs a state that is not a stun state at all.
  if (f.hitstun > 0) {
    if (!isHitstun(f.state)) setState(f, isAirborne(f) ? S.HITSTUN_AIR : S.HITSTUN_STAND);
    return;
  }
  if (f.blockstun > 0) {
    if (!isBlockstun(f.state)) setState(f, isAirborne(f) ? S.BLOCKSTUN_AIR : S.BLOCKSTUN_STAND);
    return;
  }

  // --- 3..6 -----------------------------------------------------------------
  switch (f.state) {
    case S.ACTION: {
      const m = moveOf(s, p);
      if (m === null) {
        toNeutral(s, p);
        return;
      }
      // TOUCHING THE GROUND ENDS AN AIR MOVE. groundClamp already charged
      // CompiledMove.landingRecovery; a move left to play out its airborne
      // timeline on the floor would skip the recovery that is the entire
      // reason that field exists.
      if ((f.flags & FF.JUST_LANDED) !== 0 && f.landingLag > 0) {
        releaseAction(s, p);
        setState(f, S.LANDING);
        return;
      }
      // A cancel outranks the move finishing, which is what makes a gatling
      // faster than waiting out recovery.
      if (tryStartMove(s, p, m)) return;
      if (f.actionFrame >= m.totalFrames - 1) {
        releaseAction(s, p);
        if (!tryStartMove(s, p, null)) groundMovement(s, p);
      }
      return;
    }

    case S.HITSTUN_STAND:
    case S.HITSTUN_CROUCH:
    case S.HITSTUN_AIR:
    case S.BLOCKSTUN_STAND:
    case S.BLOCKSTUN_CROUCH:
    case S.BLOCKSTUN_AIR:
      // The counters hit zero above, so the fighter is free this frame.
      toNeutral(s, p);
      return;

    case S.STAND:
    case S.WALK_F:
    case S.WALK_B:
      if (f.landingLag > 0) {
        setState(f, S.STAND);
        return;
      }
      if (tryStartMove(s, p, null)) return;
      groundMovement(s, p);
      return;

    // --- the jump. Four states; physics owns everything between them. --------

    case S.JUMP_SQUAT:
      // Committed: no move, no cancel, no change of mind about the direction.
      // `stateFrame` counts COMPLETED frames, so `>=` spends exactly
      // `jumpSquat` of them on the ground (A: 4).
      if (f.stateFrame < charOf(s, p).jumpSquat) return;
      launchJump(s, p, f.jumpDir);
      return;

    case S.JUMP_RISE:
    case S.JUMP_FALL:
      // groundClamp raised JUST_LANDED in phase 5 of last frame and
      // advanceAction clears it at the end of this one, so this is the only
      // frame it is visible — read it first or the landing is missed entirely.
      if ((f.flags & FF.JUST_LANDED) !== 0) {
        setState(f, S.LANDING);
        return;
      }
      // The apex is wherever gravity says it is; nothing here counts frames.
      if (f.state === S.JUMP_RISE && f.velY <= 0) setState(f, S.JUMP_FALL);
      if (tryStartMove(s, p, null)) return;
      tryAirJump(s, p);
      return;

    case S.LANDING:
      // tickTimers already spent this frame's landingLag, so the fighter is
      // free on the frame it reads zero — the same rule hitstun follows, and
      // why the documented cycle is 52 frames and not 53.
      if (f.landingLag > 0) return;
      // No move's stateMask contains S.LANDING, so the ground state has to be
      // restored BEFORE asking for one or the first actionable frame silently
      // accepts nothing.
      setState(f, S.STAND);
      if (tryStartMove(s, p, null)) return;
      groundMovement(s, p);
      return;

    case S.KO:
      // Terminal until resetRound. sim/round.ts owns the victory sequence.
      return;

    default:
      // Every state M0 defers — crouch, dash, knockdown, wakeup, throws, intro,
      // win pose — lands here. Resolving to neutral means an early arrival is a
      // visual oddity for one frame instead of a fighter that never moves
      // again.
      toNeutral(s, p);
      return;
  }
};

// -----------------------------------------------------------------------------
// PHASE 3c — advance the timeline
// -----------------------------------------------------------------------------

/**
 * Advances the playing move by one frame and applies that frame's data.
 *
 * The move's frame 0 is played on the frame startAction ran, so the advance is
 * skipped while `stateFrame` is still 0. Without that, every move would skip
 * its own first frame and a 5-frame startup would be a 4-frame startup.
 */
export const advanceAction = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);

  if (f.state !== S.ACTION) {
    f.stateFrame++;
    f.flags &= ~FF.JUST_LANDED;
    syncPushbox(s, p);
    return;
  }

  const m = moveOf(s, p);
  if (m === null) {
    releaseAction(s, p);
    f.stateFrame++;
    return;
  }

  if (f.stateFrame > 0) f.actionFrame++;
  f.stateFrame++;
  f.flags &= ~FF.JUST_LANDED;

  if (f.actionFrame >= m.totalFrames) {
    // Safety net. resolveTransitions releases a finished move first, so this
    // only fires if a move was started with a shorter timeline than it claims.
    releaseAction(s, p);
    return;
  }
  applyFrameData(s, p, m, f.actionFrame);
};

/**
 * The whole of phase 3 for one fighter, gate included. step.ts may call this,
 * or call the four parts in the canonical order itself.
 * Returns false when the fighter was frozen in hitstop this frame.
 */
export const stepFighter = (s: SimState, p: PlayerIx): boolean => {
  const f = s.fighter(p);
  if (f.hitstop > 0) {
    f.hitstop--;
    return false;
  }
  tickTimers(s, p);
  resolveTransitions(s, p);
  advanceAction(s, p);
  return true;
};

// -----------------------------------------------------------------------------
// PHASE 11 — facing
// -----------------------------------------------------------------------------

/**
 * Turns each fighter toward the other, once per frame, and only while it is
 * free to turn: mid-move and mid-stun a fighter keeps the facing it committed
 * to, which is what makes a crossup a crossup.
 *
 * At EXACTLY equal positions nobody turns. Picking a winner there would be a
 * slot-index tiebreak wearing a different hat.
 */
export const updateFacing = (s: SimState): void => {
  for (let p = 0; p < 2; p++) {
    const ix = p as PlayerIx;
    const f = s.fighter(ix);
    if (f.hitstop > 0) continue;
    if ((f.flags & FF.FACING_LOCKED) !== 0) continue;
    if (f.state === S.ACTION || f.hitstun > 0 || f.blockstun > 0) continue;
    const fr = currentFrame(s, ix);
    if (fr !== null && (fr.flags & MF.NO_TURN) !== 0) continue;

    const o = s.fighter(otherPlayer(ix));
    if (o.posX > f.posX) f.facing = 1;
    else if (o.posX < f.posX) f.facing = -1;
  }
};

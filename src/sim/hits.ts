// =============================================================================
// SunForce — src/sim/hits.ts
// Phases 9 and 10 of the canonical frame order: freeze(), then commit().
//
// WHY THERE ARE TWO FUNCTIONS AND NOT ONE
// Gathering simultaneously but COMMITTING sequentially still leaks. Resolve
// fighter 0's hit first and fighter 1's resolution then reads an opponent that
// has already lost health, already been shoved into the corner, and already
// had its combo counter advanced. The trade resolves one way for P1 and the
// other way for P2, and it shows up as "that combo only works on one side".
//
// So: freeze() copies every field commit() reads into a pre-commit snapshot,
// and commit() reads ONLY that snapshot. The live views are write targets, not
// read sources. Two strikes landing on the same frame are then genuinely
// order-independent, by construction rather than by care.
//
// THE THREE PLACES ORDER COULD STILL LEAK, AND WHAT IS DONE ABOUT THEM
//   1. hitstop. On a trade each fighter is owed two different counts (a 9-frame
//      punch and a 14-frame kick). Assignment would make the last writer win.
//      We take the MAXIMUM, which is commutative, and both fighters therefore
//      freeze for the same count — which is also what keeps frame advantage
//      arithmetic: adv = stun - (total - 1 - firstActive).
//   2. velocity. A fighter can be both attacker (owed self-pushback) and
//      defender (owed knockback) on one frame. Precedence is fixed by RULE, not
//      by loop order: BEING HIT WINS. A fighter whose velocity was assigned as
//      a defender ignores its own self-push entirely.
//   3. the event ring. Two simultaneous events are appended in slot order.
//      That order is presentation only, but it IS inside the hashed buffer, so
//      sim/hash.ts's mirrored hash has to swap the two players' events the same
//      way it swaps their fighter slots.
//
// M0 SCOPE. Damage is FLAT — 50 and 100, exactly, with no proration and no
// counter-hit bonus — because M0 acceptance test 7 is "ten kicks KO" and
// proration would make that eleven. Both are deferred, and both are additive:
// the proration tables and the counter branch drop into `decide` alone.
// =============================================================================

import {
  B, Contact, Ev, FF, Gd, JUGGLE_GRAVITY_MAX_PCT, JUGGLE_GRAVITY_STEP_PCT, MoveId,
  RoundState, Rx, S, SfxId, SparkId,
} from '@/core/contracts';
import type { FX, GuardMask, PlayerIx, SimState } from '@/core/contracts';
import { fxPct } from '@/core/fixed';
import { ringHeld } from '@/core/ring';
import { charOf, otherPlayer } from '@/sim/state';
import { hitIdBit, isAirborne, isCrouching, moveOf } from '@/sim/collision';
import type { GatherResult, HitCandidate } from '@/sim/collision';
import { corneredTowards } from '@/sim/physics';
import { packB, packExtra, pushEvent } from '@/sim/events';

// -----------------------------------------------------------------------------
// THE PRE-COMMIT SNAPSHOT
// -----------------------------------------------------------------------------

/**
 * Every field commit() is allowed to read. If a new rule needs another field,
 * it goes in HERE first — reading one live word is all it takes to put the
 * order dependency back.
 */
export interface FighterSnapshot {
  hp: number;
  /** -1 left wall, +1 right wall, 0 free. THE cornered flag. */
  wallTouch: number;
  juggleCount: number;
  comboCount: number;
  comboDamage: number;
  facing: number;
  state: S;
  flags: number;
  posX: FX;
  posY: FX;
  velX: FX;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  knockdownTimer: number;
  stunScalePct: number;
  gravityMulPct: number;
  action: MoveId;
  actionFrame: number;
  /** startup of the move being played; the block predicate reads it. */
  actionStartup: number;
  hitIdsUsed: number;
  /** 1 when this fighter is holding guard this frame. Derived in freeze(). */
  blockHeld: number;
  airborne: boolean;
  crouching: boolean;
  /** Received-knockback scaling, percent. From the character def. */
  weightPct: number;
}

export interface PreCommit {
  readonly f: readonly [FighterSnapshot, FighterSnapshot];
}

const blankSnapshot = (): FighterSnapshot => ({
  hp: 0, wallTouch: 0, juggleCount: 0, comboCount: 0, comboDamage: 0,
  facing: 1, state: S.STAND, flags: 0,
  posX: 0, posY: 0, velX: 0,
  hitstun: 0, blockstun: 0, hitstop: 0, knockdownTimer: 0,
  stunScalePct: 100, gravityMulPct: 100,
  action: MoveId.NONE, actionFrame: 0, actionStartup: 0,
  hitIdsUsed: 0, blockHeld: 0,
  airborne: false, crouching: false, weightPct: 100,
});

/** Allocated once by step.ts, reused every frame. */
export const createPreCommit = (): PreCommit => ({ f: [blankSnapshot(), blankSnapshot()] });

/**
 * PHASE 9. Copies both fighters into `snap`.
 *
 * It also DERIVES one field: `blockHeld`, from this frame's input ring. Guard
 * is an input state, not a stored one, and deriving it here means commit() can
 * keep its promise of reading nothing but the snapshot. The derived value is
 * written back into the state buffer too, so it rolls back, hashes and shows up
 * in the debug overlay like every other fighter field.
 */
export const freeze = (s: SimState, snap: PreCommit): void => {
  const frame = s.g.frame;
  for (let p = 0; p < 2; p++) {
    const ix = p as PlayerIx;
    const f = s.fighter(ix);
    const t = snap.f[p]!;

    // Directions in the ring are ABSOLUTE; "back" is facing-relative.
    const held = ringHeld(s.buf, ix, frame);
    const backBit = f.facing >= 0 ? B.L : B.R;
    f.blockHeld = (held & backBit) !== 0 || (held & B.G) !== 0 ? 1 : 0;

    const m = moveOf(s, ix);

    t.hp = f.hp;
    t.wallTouch = f.wallTouch;
    t.juggleCount = f.juggleCount;
    t.comboCount = f.comboCount;
    t.comboDamage = f.comboDamage;
    t.facing = f.facing;
    t.state = f.state;
    t.flags = f.flags;
    t.posX = f.posX;
    t.posY = f.posY;
    t.velX = f.velX;
    t.hitstun = f.hitstun;
    t.blockstun = f.blockstun;
    t.hitstop = f.hitstop;
    t.knockdownTimer = f.knockdownTimer;
    t.stunScalePct = f.stunScalePct;
    t.gravityMulPct = f.gravityMulPct;
    t.action = f.action;
    t.actionFrame = f.actionFrame;
    t.actionStartup = m !== null ? m.startup : 0;
    t.hitIdsUsed = f.hitIdsUsed;
    t.blockHeld = f.blockHeld;
    t.airborne = isAirborne(f);
    t.crouching = isCrouching(f);
    t.weightPct = charOf(s, ix).weightPct;
  }
};

// -----------------------------------------------------------------------------
// THE BLOCK PREDICATE — docs/ENGINE-DECISIONS.md section 9, locked.
// -----------------------------------------------------------------------------

/**
 * BLOCKSTUN IS DELIBERATELY NOT EXCLUDED. Requiring the defender to be
 * "actionable" is the bug that makes every two-hit blockstring an unblockable
 * counter-hit: the second hit arrives while the defender is still in blockstun
 * from the first, finds them non-actionable, and lands clean. A fighter in
 * blockstun holding back MUST be able to block the next hit.
 *
 * Hitstun is excluded (you cannot block out of a combo), knockdown is excluded,
 * and a fighter past its own move's startup is committed and cannot block —
 * which is exactly what makes throwing out a move a risk.
 */
export const canBlock = (d: FighterSnapshot, guard: GuardMask): boolean => {
  if ((guard & Gd.UNBLOCKABLE) !== 0) return false;
  if ((d.flags & FF.GUARD_BROKEN) !== 0) return false;
  if (d.hitstun > 0) return false;
  if (d.knockdownTimer > 0) return false;
  if (d.state === S.ACTION && d.actionFrame >= d.actionStartup) return false;
  if (d.blockHeld === 0) return false;
  if (d.airborne) return true;
  if (d.crouching) return (guard & Gd.LOW) !== 0;
  return (guard & Gd.HIGH) !== 0;
};

/** Which hitstun state a reaction puts a grounded or airborne defender into. */
const hitstunState = (reaction: Rx, d: FighterSnapshot): S => {
  if (d.airborne || reaction === Rx.LAUNCH) return S.HITSTUN_AIR;
  if (reaction === Rx.CROUCH || d.crouching) return S.HITSTUN_CROUCH;
  return S.HITSTUN_STAND;
};

/** A guard spark, chosen from the strike's own impact spark. */
const guardSpark = (spark: SparkId): SparkId =>
  spark === SparkId.IMPACT_L || spark === SparkId.IMPACT_CH ? SparkId.GUARD_L : SparkId.GUARD_S;

// -----------------------------------------------------------------------------
// DECIDE — pure over the snapshot. Writes nothing to the state.
// -----------------------------------------------------------------------------

interface Outcome {
  attacker: PlayerIx;
  defender: PlayerIx;
  connected: boolean;
  blocked: boolean;
  /** The juggle limit refused this hit: consume the hitId, apply nothing. */
  denied: boolean;
  damage: number;
  stun: number;
  hitstop: number;
  defVelX: FX;
  defVelY: FX;
  /** false when the corner ate the pushback and the attacker gets it instead. */
  defAssignVel: boolean;
  atkPushX: FX;
  juggleAdd: number;
  gravityAdd: number;
  reaction: Rx;
  contactX: FX;
  contactY: FX;
  sfx: SfxId;
  spark: SparkId;
  shakeAmp: number;
  shakeFrames: number;
  chroma: number;
  idBit: number;
}

const blankOutcome = (attacker: PlayerIx): Outcome => ({
  attacker,
  defender: otherPlayer(attacker),
  connected: false, blocked: false, denied: false,
  damage: 0, stun: 0, hitstop: 0,
  defVelX: 0, defVelY: 0, defAssignVel: false, atkPushX: 0,
  juggleAdd: 0, gravityAdd: 0,
  reaction: Rx.STAND, contactX: 0, contactY: 0,
  sfx: SfxId.NONE, spark: SparkId.NONE, shakeAmp: 0, shakeFrames: 0, chroma: 0,
  idBit: 0,
});

/** Module scratch: the sim is single-threaded and commit() is not re-entrant. */
const OUT: readonly [Outcome, Outcome] = [blankOutcome(0), blankOutcome(1)];

const decide = (snap: PreCommit, cand: HitCandidate, o: Outcome): void => {
  o.connected = false;
  o.blocked = false;
  o.denied = false;
  o.damage = 0;
  o.stun = 0;
  o.hitstop = 0;
  o.defVelX = 0;
  o.defVelY = 0;
  o.defAssignVel = false;
  o.atkPushX = 0;
  o.juggleAdd = 0;
  o.gravityAdd = 0;

  const h = cand.hit;
  if (h === null) return;

  const a = snap.f[cand.attacker]!;
  const d = snap.f[cand.defender]!;
  const props = h.props;

  o.connected = true;
  o.idBit = hitIdBit(props.hitId);
  o.contactX = cand.contactX;
  o.contactY = cand.contactY;
  o.reaction = props.reaction;

  // Past its juggle limit a hit whiffs ENTIRELY, with its own feedback tick, so
  // the player learns the rule instead of being confused by it. The hitId is
  // still consumed or the same box would be re-tested every active frame.
  if (d.airborne && d.juggleCount > props.juggleLimit) {
    o.denied = true;
    o.sfx = SfxId.JUGGLE_DENY;
    o.spark = SparkId.NONE;
    return;
  }

  o.blocked = canBlock(d, props.guard);

  // DEFERRED (M0): counter-hit. The detection would be
  // `(d.flags & FF.COUNTER_STATE) !== 0 && !o.blocked`, worth
  // +ctrBonusHitstun, +ctrBonusHitstop and xctrDamagePct. fighter.ts already
  // raises the flag on startup frames, so this is a three-line change.
  const counter = false;

  o.hitstop = o.blocked ? props.blockHitstop : props.hitstop;
  o.damage = o.blocked ? 0 : props.damage;
  // Hitstun proration is a SEPARATE, much gentler table than damage proration;
  // stunScalePct is 100 until sim/round.ts turns proration on, so this is
  // identity in M0 rather than a branch that has to be remembered later.
  o.stun = o.blocked
    ? props.blockstun
    : ((props.hitstun * d.stunScalePct) / 100) | 0;
  if (counter) o.stun += props.ctrBonusHitstun;

  // --- knockback -----------------------------------------------------------
  // `away` is the direction the defender travels: the ATTACKER's facing, never
  // a comparison of the two positions (which is a slot-order tiebreak in
  // disguise and breaks at exactly equal x).
  const away = a.facing >= 0 ? 1 : -1;
  const push = fxPct(o.blocked ? props.blockPushX : props.kbX, d.weightPct);
  const cornered = corneredTowards(d.wallTouch, away);

  o.defAssignVel = !cornered;
  o.defVelX = push * away;
  o.defVelY = o.blocked ? 0 : fxPct(props.kbY, d.weightPct);

  // Corner transfer: a defender with a wall behind it cannot take the pushback,
  // so the ATTACKER does. This is what makes cornering stick and what stops
  // infinite corner blockstrings — blockPushX > kbX pushes the attacker out of
  // its own pressure.
  const self = (o.blocked ? props.selfPushBlock : props.selfPushHit) + (cornered ? push : 0);
  o.atkPushX = -self * away;

  if (!o.blocked && d.airborne) {
    o.juggleAdd = props.juggleCost;
    o.gravityAdd = JUGGLE_GRAVITY_STEP_PCT;
  }

  o.sfx = o.blocked ? props.blockSfx : props.sfx;
  o.spark = o.blocked ? guardSpark(props.spark) : props.spark;
  // A blocked hit shakes, but not as hard as one that landed.
  o.shakeAmp = o.blocked ? (props.shakeAmp / 2) | 0 : props.shakeAmp;
  o.shakeFrames = props.shakeFrames;
  o.chroma = o.blocked ? 0 : props.chroma;
};

// -----------------------------------------------------------------------------
// APPLY
// -----------------------------------------------------------------------------

/**
 * THE SPENT HIT FRAME. A hit is resolved in phase 10, AFTER both fighters have
 * already taken their phase 3 for that frame, so the frame of contact costs the
 * defender nothing. Stun therefore runs for `stun` frames starting the frame
 * AFTER contact, and the counter has to carry the spent frame: a 16-frame
 * hitstun stores 17, is ticked on 17 frames, and the defender's next actionable
 * frame is hitFrame + 17.
 *
 * This is exactly the one frame that makes the MEASURED advantage equal the
 * PRINTED one. docs/FEEL-NUMBERS.md locks adv = stun - (total - 1 - firstActive)
 * = 16 - 11 = +5 for 5P, compile.ts derives the same number into
 * CompiledMove.advHit, and the F3 overlay prints it. Without the carry the
 * simulation runs every move at one frame less advantage than its own frame
 * data says it has — which is precisely the silent, uniform offset the engine
 * decisions rejected `hitstopAtk = hitstopDef - 2` for. Verified by walking a
 * jab in and counting: attacker actionable on frame 92, defender on 97, +5.
 */
const STUN_CARRY = 1;

const applyOne = (s: SimState, snap: PreCommit, o: Outcome): void => {
  if (!o.connected) return;

  const atk = s.fighter(o.attacker);
  const as = snap.f[o.attacker]!;

  // The hitId is retired whatever happened, including a juggle denial: one
  // hitId connects at most once per action.
  atk.hitIdsUsed = as.hitIdsUsed | o.idBit;

  if (o.denied) {
    pushEvent(
      s, Ev.JUGGLE_DENY, o.attacker, packB(0, o.sfx), o.contactX, o.contactY,
      packExtra(SparkId.NONE, 0, 0, 0),
    );
    return;
  }

  const def = s.fighter(o.defender);
  const ds = snap.f[o.defender]!;

  // --- attacker ------------------------------------------------------------
  atk.lastContact = o.blocked ? Contact.BLOCK : Contact.HIT;
  atk.flags = as.flags | (o.blocked ? FF.BLOCK_CONFIRMED : FF.HIT_CONFIRMED);
  // MAX, not assignment: on a trade each fighter is owed two counts and the
  // larger one is the only answer that is the same from both sides.
  if (atk.hitstop < o.hitstop) atk.hitstop = o.hitstop;

  if (!o.blocked) {
    // A combo is "the defender was already in stun". Reading it from the
    // snapshot means the counter is right even when both fighters connect.
    const continuing = ds.hitstun > 0 || ds.blockstun > 0;
    atk.comboCount = (continuing ? as.comboCount : 0) + 1;
    atk.comboDamage = (continuing ? as.comboDamage : 0) + o.damage;
  }

  // --- defender ------------------------------------------------------------
  if (def.hitstop < o.hitstop) def.hitstop = o.hitstop;

  if (o.blocked) {
    def.blockstun = o.stun + STUN_CARRY;
    def.hitstun = 0;
    def.state = ds.airborne
      ? S.BLOCKSTUN_AIR
      : ds.crouching ? S.BLOCKSTUN_CROUCH : S.BLOCKSTUN_STAND;
  } else {
    const hp = ds.hp - o.damage;
    def.hp = hp > 0 ? hp : 0;
    def.hitstun = o.stun + STUN_CARRY;
    def.blockstun = 0;
    def.state = hitstunState(o.reaction, ds);
    def.juggleCount = ds.juggleCount + o.juggleAdd;
    const gm = ds.gravityMulPct + o.gravityAdd;
    def.gravityMulPct = gm > JUGGLE_GRAVITY_MAX_PCT ? JUGGLE_GRAVITY_MAX_PCT : gm;
    def.lastHitFrame = s.g.frame;
    s.g.lastHitBy = o.attacker;
  }

  // Being hit or blocking interrupts whatever the defender was doing.
  def.stateFrame = 0;
  if (ds.action !== MoveId.NONE) def.prevAction = ds.action;
  def.action = MoveId.NONE;
  def.actionFrame = 0;
  def.lastContact = Contact.NONE;
  def.flags = ds.flags & ~(FF.HIT_CONFIRMED | FF.BLOCK_CONFIRMED | FF.COUNTER_STATE);

  if (o.defAssignVel) {
    def.velX = o.defVelX;
    if (!o.blocked && o.defVelY !== 0) {
      def.velY = o.defVelY;
      def.flags |= FF.AIRBORNE;
    }
  }

  pushEvent(
    s,
    o.blocked ? Ev.BLOCK : Ev.HIT,
    o.attacker,
    packB(o.damage, o.sfx),
    o.contactX,
    o.contactY,
    packExtra(o.spark, o.shakeAmp, o.shakeFrames, o.chroma),
  );

  if (!o.blocked && def.hp <= 0) {
    s.g.roundState = RoundState.KO;
    pushEvent(
      s, Ev.KO, o.attacker, packB(o.damage, SfxId.KO), o.contactX, o.contactY,
      packExtra(SparkId.KO_BURST, o.shakeAmp, o.shakeFrames, o.chroma),
    );
  }
};

/**
 * PHASE 10. Decides both strikes against the frozen snapshot, then applies
 * them. Nothing read here comes from a live fighter view.
 */
export const commit = (s: SimState, g: GatherResult, snap: PreCommit): void => {
  const o0 = OUT[0];
  const o1 = OUT[1];
  decide(snap, g.hit[0], o0);
  decide(snap, g.hit[1], o1);

  applyOne(s, snap, o0);
  applyOne(s, snap, o1);

  // Self-pushback LAST, and never for a fighter that was itself struck: its
  // velocity was assigned by the knockback above, and "being hit wins" is a
  // rule rather than a consequence of which slot the loop reached first.
  const struck0 = o1.connected && !o1.denied && o1.defAssignVel;
  const struck1 = o0.connected && !o0.denied && o0.defAssignVel;
  if (o0.connected && !o0.denied && !struck0 && o0.atkPushX !== 0) {
    const f = s.fighter(0);
    f.velX = (f.velX + o0.atkPushX) | 0;
  }
  if (o1.connected && !o1.denied && !struck1 && o1.atkPushX !== 0) {
    const f = s.fighter(1);
    f.velX = (f.velX + o1.atkPushX) | 0;
  }
};

// -----------------------------------------------------------------------------
// Combo bookkeeping and the KO query
// -----------------------------------------------------------------------------

/**
 * Ends `p`'s combo. sim/fighter.ts calls this on the OTHER fighter the frame
 * hitstun runs out, which is the moment a combo is over by definition.
 */
export const endCombo = (s: SimState, p: PlayerIx): void => {
  const f = s.fighter(p);
  if (f.comboCount === 0) return;
  pushEvent(s, Ev.COMBO_END, p, packB(f.comboDamage, SfxId.NONE), f.posX, f.posY, 0);
  f.comboCount = 0;
  f.comboDamage = 0;
};

/** True the moment either fighter is at zero HP. */
export const isKO = (s: SimState): boolean => s.fighter(0).hp <= 0 || s.fighter(1).hp <= 0;

/** The fighter that lost, or -1. Double KO reports slot 0; sim/round.ts owns
 *  what a double KO MEANS, this only reports what happened. */
export const koLoser = (s: SimState): PlayerIx | -1 => {
  if (s.fighter(0).hp <= 0) return 0;
  if (s.fighter(1).hp <= 0) return 1;
  return -1;
};

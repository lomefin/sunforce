// =============================================================================
// SunForce — src/input/cpu.ts
// THE COMPUTER PLAYER. An `InputSource` like the keyboard and like the training
// dummy, so nothing downstream learns that player 2 is not a person.
//
// IT READS THE SIM AND NEVER WRITES TO IT. `DummySource` deliberately cannot
//   see the fight at all (input/dummy.ts says why), which is exactly why this
//   is a separate class and not a seventh DummyMode. `poll` returns a
//   `ButtonMask` and nothing else, so the sim stays what it always was — a pure
//   function of two button masks — and nothing here can desync a replay, which
//   records the masks this file produced and never the reasoning behind them.
//
// DETERMINISM. One `Rng` (core/rng.ts xorshift32) seeded from
//   `MatchConfig.seed`. No `Math.random`, no `Date.now`. The stream advances
//   only inside `poll`, so the same seed against the same human inputs
//   reproduces the same fight frame for frame. `poll` ignores its `frame`
//   argument on purpose: SimState is the clock.
//
// WHAT STOPS IT BEING A TWITCH ROBOT — four devices, all deliberate:
//   1. IT SEES THE PAST. Every decision reads a percept `delay` frames old, so
//      latency is a property of PERCEPTION and not a fudge on the output: what
//      it could only answer frame-perfectly, it cannot see in time.
//   2. IT DECIDES ON A CADENCE of 5 to 40 frames, jittered per character, so it
//      commits to a plan long enough to be baited out of it.
//   3. IT ROLLS ONCE PER THREAT, not per frame: whether it blocks THIS attack
//      is settled as it starts and a lost roll stays lost, so it gets opened up
//      and blockstrings work on it.
//   4. IT RESTS after swinging, a random count, so it can never mash.
//
// THE SIX STRATEGIES ARE THE DIFFERENCE. B–F share A's frame data today
//   (registry.ts says so), so personality cannot come from the moves: it comes
//   from preferred range, how readily it swings, whether it blocks at all, its
//   rhythm, and what it does the instant it is hit.
//
// TODAY'S VOCABULARY is walk, jump, guard, 5P and 5K — no crouch state and no
//   air moves exist yet, so the aerial archetype is expressed the only honest
//   way it can be: it jumps at you and buffers the button on the way DOWN, and
//   the swing fires on the first grounded frame. When j.P lands, that same
//   press starts hitting in the air with no change here.
// =============================================================================
import { B, Contact, G, RoundState, S } from '@/core/contracts';
import type {
  ButtonMask, CharId, CompiledChar, CompiledMove, Facing, FighterView,
  InputSource, PlayerIx, SimState,
} from '@/core/contracts';
import { px } from '@/core/fixed';
import { Rng } from '@/core/rng';
import { backBit, forwardBit } from '@/input/buffer';
import { isAirborne, moveOf } from '@/sim/collision';

export interface CpuOpts {
  readonly charId: CharId;
  /** Which side the CPU is on. The human is the other one. */
  readonly player: PlayerIx;
  /** From `MatchConfig.seed`, so the whole match reproduces from the config. */
  readonly seed: number;
  /** 0..100, one dial: reaction speed, guard rate, drive, punish rate. */
  readonly level?: number;
}

/** Fightable, not perfect: beat it with a mixup, not with a reaction test. */
export const DEFAULT_CPU_LEVEL = 55;
// --- Tuning -----------------------------------------------------------------

/** Percept ring: a power of two, deeper than the slowest reaction. */
const P_CAP = 32, P_MASK = P_CAP - 1, MIN_REACT = 3;
/** Percept flag: the opponent cannot act, so the window is open. */
const FOE_STUN = 1;
/** Where the opponent is inside its current move. */
const PH_NONE = 0, PH_STARTUP = 1, PH_ACTIVE = 2, PH_RECOVER = 3;
/** Plans. */
const IN_HOLD = 0, IN_ADVANCE = 1, IN_RETREAT = 2, IN_GUARD = 3, IN_JUMP = 4;
/** Styles — the structural behaviours, as opposed to the numeric knobs. */
const ST_ROUND = 0, ST_WALL = 1, ST_PRESS = 2, ST_AIR = 3, ST_FEINT = 4, ST_CHARGE = 5;

/** HURT_PAD: half a hurtbox, world units — a strike lands this far past its own
 *  reach because the target has width (measured off A's standing boxes).
 *  GUARD_PAD: slack before a threat counts as "that reaches me". */
const HURT_PAD = 34, GUARD_PAD = 26;
/** Attack held two frames, so the release is unmistakable; UP held four, which
 *  covers the whole jump squat. */
const PRESS_FRAMES = 2, JUMP_FRAMES = 4, JUMP_REST = 36;
/** Height below which a descending jump buffers its landing hit. INPUT_LENIENCY
 *  is 6 and landing lag is 3, so the press has to be late to survive both. */
const LAND_PRESS_Y = 34;
/** Decision-frames F banks before it commits, and how long the run then lasts. */
const CHARGE_FULL = 72, CHARGE_RUN = 54;

// --- The six strategies -----------------------------------------------------

interface Strategy {
  readonly style: number;
  readonly near: number; readonly far: number;   // preferred band, world units
  readonly margin: number;        // added to TRUE reach before it swings; -ve = patient
  readonly kickPct: number;       // 0..100 kick rather than punch
  readonly aggression: number;    // 0..100 a decision comes out offensive
  readonly guardPct: number;      // 0..100 commits to guarding a threat it saw
  readonly guardBack: boolean;    // true: holds back, gives ground. false: holds G
  readonly jumpPct: number;       // 0..100 a neutral decision becomes a jump
  readonly chainPct: number;      // 0..100 gatlings when a swing connects
  readonly thinkLo: number; readonly thinkHi: number;  // cadence: a wide span IS a rhythm
  readonly react: number;         // base reaction latency, before `level` adjusts it
  readonly restLo: number; readonly restHi: number;    // idle frames after a swing
  readonly retaliate: number;     // 0..100 answers a hit by coming forward
}

/** Indexed by CharId, tuned against the shared frame data. Measured headlessly,
 *  standing, centre to centre: a punch connects out to 128 and a kick to 161
 *  (the kick walks itself 7 units forward before it goes active); walking is 4
 *  units a frame and the fighters spawn 360 apart. HURT_PAD's 34 leaves the
 *  CPU's own estimate a couple of units INSIDE both, which is the safe side. */
const STRATEGIES: readonly Strategy[] = [
  // A all-rounder — sits outside punch range, walks in when the range is there,
  // mixes both buttons, blocks more often than not, punishes what it sees whiff.
  { style: ST_ROUND, near: 112, far: 152, margin: 0, kickPct: 45,
    aggression: 55, guardPct: 62, guardBack: true, jumpPct: 8, chainPct: 45,
    thinkLo: 14, thinkHi: 26, react: 12, restLo: 10, restHi: 20, retaliate: 45 },
  // B heavyweight — the only one whose "back off" is still forward. Prefers the
  // kick, thinks slowly, barely blocks, and answers a hit by walking INTO you.
  { style: ST_WALL, near: 132, far: 158, margin: 0, kickPct: 78,
    aggression: 68, guardPct: 26, guardBack: false, jumpPct: 2, chainPct: 30,
    thinkLo: 20, thinkHi: 34, react: 18, restLo: 12, restHi: 22, retaliate: 72 },
  // C rushdown — lives inside punch range on the shortest rest in the table (the
  // jab that FEELS four frames), gatlings whenever it touches you, never retreats.
  { style: ST_PRESS, near: 78, far: 116, margin: -4, kickPct: 15,
    aggression: 88, guardPct: 34, guardBack: false, jumpPct: 5, chainPct: 80,
    thinkLo: 8, thinkHi: 14, react: 9, restLo: 4, restHi: 9, retaliate: 80 },
  // D aerial — wants to be a jump away, not a poke away, and closes over the
  // top. Drifts back out after landing rather than staying to brawl.
  { style: ST_AIR, near: 168, far: 236, margin: 2, kickPct: 60,
    aggression: 50, guardPct: 46, guardBack: true, jumpPct: 58, chainPct: 40,
    thinkLo: 12, thinkHi: 22, react: 13, restLo: 12, restHi: 22, retaliate: 25 },
  // E trickster — the widest think span here, so its rhythm never settles, and
  // the only one that books a retreat BEHIND an approach: it walks in, you
  // respect it, and it is already leaving.
  { style: ST_FEINT, near: 126, far: 196, margin: 4, kickPct: 50,
    aggression: 60, guardPct: 50, guardBack: true, jumpPct: 18, chainPct: 50,
    thinkLo: 5, thinkHi: 40, react: 11, restLo: 6, restHi: 26, retaliate: 35 },
  // F charge — hangs at the far end building up, then spends it all in one
  // straight run that ignores the guard reflex. All in, and all in is punishable.
  { style: ST_CHARGE, near: 180, far: 250, margin: 6, kickPct: 70,
    aggression: 45, guardPct: 40, guardBack: true, jumpPct: 4, chainPct: 35,
    thinkLo: 18, thinkHi: 30, react: 15, restLo: 12, restHi: 22, retaliate: 30 },
];

// --- Reading the defs: read-only, and driven by the compiled data -----------

const clampPct = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v | 0);
const clampInt = (v: number, lo: number, hi: number): number =>
  (v < lo ? lo : v > hi ? hi : v | 0);
const scaled = (b: number, pct: number, cap: number): number =>
  Math.min(cap, ((b * pct) / 100) | 0);

/** How far forward a move's hitbox actually reaches, world units. */
const reachOf = (m: CompiledMove): number => {
  const fr = m.frames[m.activeFirst];
  if (fr === undefined) return 0;
  let far = 0;
  for (let i = 0; i < fr.hit.length; i++) {
    const box = fr.hit[i]!.box;
    const edge = px(box.x + box.w) | 0;
    if (edge > far) far = edge;
  }
  return far;
};

/** The longest reach this character owns in `group`, or 0 if it owns none. */
const groupReach = (c: CompiledChar | undefined, group: number): number => {
  if (c === undefined) return 0;
  let best = 0;
  for (let i = 0; i < c.moveOrder.length; i++) {
    const m = c.moves[c.moveOrder[i]!];
    if (m == null || (m.group & group) === 0) continue;
    const r = reachOf(m);
    if (r > best) best = r;
  }
  return best;
};

const phaseOf = (m: CompiledMove | null, actionFrame: number): number => {
  if (m === null) return PH_NONE;
  if (actionFrame < m.activeFirst) return PH_STARTUP;
  return actionFrame <= m.activeLast ? PH_ACTIVE : PH_RECOVER;
};

/** Free to act on a fresh input THIS frame? */
const isFree = (f: FighterView): boolean =>
  f.hitstun === 0 && f.blockstun === 0 && f.hitstop === 0 && !isAirborne(f)
  && (f.state === S.STAND || f.state === S.WALK_F || f.state === S.WALK_B);

// --- The source -------------------------------------------------------------

class CpuSource implements InputSource {
  private readonly st: Strategy;
  private readonly rng: Rng;
  private readonly me: PlayerIx; private readonly foe: PlayerIx;

  /** Level-derived, computed once. */
  private readonly delay: number; private readonly guardPct: number;
  private readonly punishPct: number; private readonly aggr: number;
  /** Own reaches, straight out of the compiled data, margin folded in. */
  private readonly punchRange: number; private readonly kickRange: number;
  private readonly strikeRange: number;

  /** The percept ring: what it saw, and when it saw it. */
  private readonly pDist = new Int32Array(P_CAP);
  private readonly pPhase = new Int32Array(P_CAP);
  private readonly pReach = new Int32Array(P_CAP);
  private readonly pFlags = new Int32Array(P_CAP);
  private head = 0; private seen = 0;

  /** The plan. */
  private intent = IN_HOLD; private planLeft = 0;
  private feintNext = false; private charge = 0; private commit = 0;

  /** The motor: what the hands are doing, whatever the head decided. */
  private atkBit: ButtonMask = 0; private atkHold = 0; private atkLock = 0;
  private jumpHold = 0; private jumpLock = 0; private airTried = false;

  /** One roll per threat, per stun, per action. Never one per frame. */
  private threatOpen = false; private threatGuard = false;
  private stunned = false; private stunGuard = false;
  private chained = false; private lastAction = -1;

  constructor(private readonly state: SimState, opts: CpuOpts) {
    this.st = STRATEGIES[opts.charId] ?? STRATEGIES[0]!;
    this.me = opts.player;
    this.foe = (1 - opts.player) as PlayerIx;
    // The side is mixed into the seed so a CPU on P1 and a CPU on P2 do not play
    // the identical script out of the identical match seed.
    this.rng = new Rng((opts.seed ^ (0x9e37 * (opts.player + 1))) | 0);

    const lv = clampPct(opts.level ?? DEFAULT_CPU_LEVEL);
    this.delay = clampInt(this.st.react + (((55 - lv) / 5) | 0), MIN_REACT, P_CAP - 2);
    this.guardPct = scaled(this.st.guardPct, 60 + (((lv * 80) / 100) | 0), 92);
    this.aggr = scaled(this.st.aggression, 80 + (((lv * 40) / 100) | 0), 96);
    this.punishPct = 35 + (((lv * 3) / 5) | 0);

    const c = state.defs.chars[opts.charId];
    const p = groupReach(c, G.PUNCH);
    const k = groupReach(c, G.KICK);
    this.punchRange = p === 0 ? 0 : p + HURT_PAD + this.st.margin;
    this.kickRange = k === 0 ? 0 : k + HURT_PAD + this.st.margin;
    this.strikeRange = this.punchRange > this.kickRange ? this.punchRange : this.kickRange;
  }

  poll(_frame: number): ButtonMask {
    const s = this.state;
    const me = s.fighter(this.me);
    this.observe(me, s.fighter(this.foe));

    // Intro, KO, round end, match end: hands off. The scene is about to reset
    // the round or leave, and nothing pressed now can matter.
    if (s.g.roundState !== RoundState.FIGHT) {
      this.idle();
      return 0;
    }
    if (this.atkLock > 0) this.atkLock--;
    if (this.jumpLock > 0) this.jumpLock--;
    if (this.commit > 0) this.commit--;

    const facing = me.facing;
    const d = this.sample();
    if (!isFree(me)) return this.busy(me, d, facing) | this.motor(facing);

    // Coming out of a stun is the one moment worth an unscheduled decision.
    if (this.stunned) {
      this.stunned = false;
      this.threatOpen = false;
      this.intent = this.rng.chance(this.st.retaliate) ? IN_ADVANCE : IN_RETREAT;
      this.planLeft = this.rng.range(this.st.thinkLo, this.st.thinkHi);
    }
    this.airTried = false;
    this.chained = false;
    const reflex = this.reflex(d, facing);
    if (reflex >= 0) return reflex | this.motor(facing);

    if (this.planLeft > 0) this.planLeft--;
    else this.replan(d);
    return this.act(d, facing) | this.motor(facing);
  }

  /** No listeners, no timers, no buffer: an rng and a SimState it only read. */
  dispose(): void { /* nothing to release */ }

  /** Record this frame. Everything below reads the RING, not the fighters. */
  private observe(me: FighterView, foe: FighterView): void {
    const i = this.head & P_MASK;
    const m = moveOf(this.state, this.foe);
    this.pDist[i] = Math.abs(px(foe.posX) - px(me.posX)) | 0;
    this.pPhase[i] = phaseOf(m, foe.actionFrame);
    this.pReach[i] = m === null ? 0 : reachOf(m);
    this.pFlags[i] = foe.hitstun > 0 || foe.blockstun > 0 ? FOE_STUN : 0;
    this.head++;
    if (this.seen < P_CAP) this.seen++;
  }

  /** The newest percept it is ALLOWED to know about — the whole of the
   *  reaction model. The CPU is not slowed down, it is BEHIND. */
  private sample(): number {
    const back = this.delay < this.seen ? this.delay : this.seen - 1;
    return (this.head - 1 - back) & P_MASK;
  }

  /** The only things that outrank a plan. Returns a mask, or -1 for nothing. */
  private reflex(d: number, facing: Facing): number {
    const dist = this.pDist[d]!;
    const phase = this.pPhase[d]!;
    // Stunned, or already whiffing: the free hit. `delay` decides whether the
    // window is still open when the CPU gets there; the roll stops it
    // punishing literally everything.
    const open = (this.pFlags[d]! & FOE_STUN) !== 0 || phase === PH_RECOVER;
    if (open && this.canSwing(dist) && this.rng.chance(this.punishPct)) {
      this.startSwing(dist, 0);
      return dist > this.strikeRange - 12 ? forwardBit(facing) : 0;
    }
    // Something is coming. Decide ONCE, as it starts, whether this one gets
    // blocked, and keep that answer for the whole attack, blockstring included.
    if (phase === PH_STARTUP || phase === PH_ACTIVE) {
      if (!this.threatOpen) {
        this.threatOpen = true;
        this.threatGuard = this.rng.chance(this.guardPct);
      }
      const reaches = dist <= this.pReach[d]! + HURT_PAD + GUARD_PAD;
      if (this.threatGuard && reaches && this.commit === 0) return this.guard(facing);
    } else {
      this.threatOpen = false;
    }
    return -1;
  }

  /** Not free: airborne, stunned, or mid-move. */
  private busy(me: FighterView, d: number, facing: Facing): ButtonMask {
    // AIRBORNE. Drift, and buffer the swing low and descending.
    if (isAirborne(me)) {
      if (!this.airTried && me.velY < 0 && px(me.posY) < LAND_PRESS_Y) {
        this.airTried = true;
        const eager = this.st.style === ST_AIR || this.rng.chance(this.aggr >> 1);
        if (eager && this.ready()) this.startSwing(0, 0);
      }
      return this.intent === IN_RETREAT ? backBit(facing) : forwardBit(facing);
    }
    // STUNNED. One roll decides whether the guard goes up for the NEXT hit of
    // the string. Lose it and the string keeps working, which is the point.
    if (me.hitstun > 0 || me.blockstun > 0) {
      if (!this.stunned) {
        this.stunned = true;
        this.stunGuard = this.rng.chance(this.guardPct);
      }
      return this.stunGuard ? this.guard(facing) : 0;
    }
    // MID-MOVE. The only legal input is a gatling, and only on a connection.
    if (me.state === S.ACTION) {
      if (me.action !== this.lastAction) {
        this.lastAction = me.action;
        this.chained = false;
      }
      const touched = me.lastContact === Contact.HIT || me.lastContact === Contact.BLOCK;
      if (!this.chained && touched && this.ready() && this.rng.chance(this.st.chainPct)) {
        this.chained = true;
        const cur = moveOf(this.state, this.me);
        const punching = cur !== null && (cur.group & G.PUNCH) !== 0;
        this.startSwing(this.pDist[d]!, punching ? B.K : B.P);
      }
    }
    return 0;             // jump squat and landing are committed: nothing to say
  }

  private replan(d: number): void {
    const st = this.st;
    const r = this.rng;
    const dist = this.pDist[d]!;
    this.planLeft = r.range(st.thinkLo, st.thinkHi);
    // A retreat booked behind the last approach. E's whole personality.
    if (this.feintNext) {
      this.feintNext = false;
      this.intent = IN_RETREAT;
      return;
    }
    if (st.style === ST_CHARGE) {
      this.intent = this.chargePlan(dist);
      return;
    }
    if (st.style === ST_AIR && this.jumpLock === 0 && dist > this.strikeRange + 40
      && r.chance(st.jumpPct)) {
      this.intent = IN_JUMP;
      return;
    }
    const keen = r.chance(this.aggr);
    if (dist > st.far) {
      this.intent = keen || st.style === ST_WALL ? IN_ADVANCE : IN_HOLD;
      if (this.intent === IN_ADVANCE && st.style === ST_FEINT) this.feintNext = r.chance(55);
      return;
    }
    if (dist < st.near) {
      // The two that never give ground, and everybody else, who does.
      this.intent = st.style === ST_PRESS || st.style === ST_WALL ? IN_ADVANCE
        : keen ? IN_HOLD : IN_RETREAT;
      return;
    }
    if (!keen && this.jumpLock === 0 && r.chance(st.jumpPct)) {
      this.intent = IN_JUMP;
      return;
    }
    this.intent = keen ? IN_ADVANCE : r.chance(st.guardPct) ? IN_GUARD : IN_HOLD;
  }

  /** F only: bank retreat, then spend it. `commit` makes the run all-in. */
  private chargePlan(dist: number): number {
    if (this.charge >= CHARGE_FULL) {
      this.charge = 0;
      this.planLeft = CHARGE_RUN;
      this.commit = CHARGE_RUN;
      return IN_ADVANCE;
    }
    this.charge += this.planLeft;
    return dist < this.st.far ? IN_RETREAT : IN_HOLD;
  }

  /** The plan, as a stick position. */
  private act(d: number, facing: Facing): ButtonMask {
    const dist = this.pDist[d]!;
    const it = this.intent;
    if (it === IN_RETREAT) return backBit(facing);
    if (it === IN_GUARD) return this.guard(facing);
    if (it === IN_JUMP) {
      if (this.jumpHold === 0 && this.jumpLock === 0) {
        this.jumpHold = JUMP_FRAMES;
        this.jumpLock = JUMP_REST;
      }
      return forwardBit(facing);
    }
    // ADVANCE and HOLD both swing when the range is there. They differ in what
    // they do when it is not: one walks in, the other keeps its band.
    if (this.canSwing(dist)) {
      this.startSwing(dist, 0);
      return 0;                                  // plant the feet for the swing
    }
    if (it === IN_ADVANCE || dist > this.st.far) return forwardBit(facing);
    return dist < this.st.near ? backBit(facing) : 0;
  }

  /** Holding back blocks AND gives ground; G blocks standing still. Which one a
   *  character uses is a real difference in how a round against it feels. */
  private guard(facing: Facing): ButtonMask {
    return this.st.guardBack ? backBit(facing) : B.G;
  }

  private ready(): boolean {
    return this.atkHold === 0 && this.atkLock === 0;
  }

  private canSwing(dist: number): boolean {
    return this.ready() && this.strikeRange > 0 && dist <= this.strikeRange;
  }

  /** Commits the hands. `force` overrides the button choice (the gatling). */
  private startSwing(dist: number, force: ButtonMask): void {
    let bit: ButtonMask;
    if (force !== 0) bit = force;
    else if (dist > this.punchRange) bit = B.K;               // only the kick reaches
    else if (this.kickRange <= this.punchRange) bit = B.P;    // no kick to pick
    else bit = this.rng.chance(this.st.kickPct) ? B.K : B.P;
    this.atkBit = bit;
    this.atkHold = PRESS_FRAMES;
    // Strictly longer than the hold, so there is ALWAYS a released frame and the
    // next press is a genuine edge: sim/fighter.ts matches edges, not holds.
    this.atkLock = PRESS_FRAMES + this.rng.range(this.st.restLo, this.st.restHi);
  }

  /** The buttons the hands are already committed to. */
  private motor(facing: Facing): ButtonMask {
    let mask: ButtonMask = 0;
    if (this.atkHold > 0) {
      this.atkHold--;
      mask |= this.atkBit;
    }
    if (this.jumpHold > 0) {
      this.jumpHold--;
      // The jump direction is latched off the mask held during jump squat, so
      // forward goes WITH up, not after it.
      mask |= B.U | forwardBit(facing);
    }
    return mask;
  }

  /** Between rounds: drop everything, so nothing is half-pressed at the bell. */
  private idle(): void {
    this.atkHold = this.jumpHold = this.atkLock = this.jumpLock = this.planLeft = 0;
    this.commit = 0;
    this.intent = IN_HOLD;
    this.threatOpen = this.stunned = this.airTried = false;
  }
}

/** The CPU for one side of one match. `state` is READ every poll and never
 *  written; `opts.seed` is the only source of randomness in it. */
export const createCpuSource = (state: SimState, opts: CpuOpts): InputSource =>
  new CpuSource(state, opts);

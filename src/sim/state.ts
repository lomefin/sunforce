// =============================================================================
// SunForce — src/sim/state.ts
// THE STATE BUFFER. One Int32Array of STATE_WORDS (576) words = 2304 bytes,
// and the entire simulation lives inside it. Hidden state is impossible by
// construction: if it is not in this buffer it does not roll back, it does not
// hash, and it does not exist.
//
// LAYOUT (frozen in contracts.ts, asserted at load below)
//   [0   .. 31 ]  globals            GLOBAL_WORDS = 32
//   [32  .. 159]  2 x fighter slot   FIGHTER_WORDS = 64 each, padded to 64 so a
//                                    later field never shifts an offset
//   [160 .. 287]  2 x input ring     INPUT_RING_FRAMES = 64 words each
//   [288 .. 575]  event ring         EVENT_CAP 48 x EVENT_WORDS_EACH 6
//
// WHY THE VIEWS ARE HAND-WRITTEN AND NOT CODE-GENERATED
// A committed generated file is the one genuinely shared mutable artefact in a
// parallel build: two agents each add a fighter field, both regenerate, both
// collide. So the accessors live here, in one file, owned by one agent, and the
// fighter slot is padded to 64 words so adding a field is a one-line diff that
// moves nothing.
//
// THE VIEWS ARE WINDOWS, NOT COPIES. `s.fighter(0)` returns the SAME object
// every call (zero allocation in the frame loop), and it keeps pointing at the
// live buffer, so a `restore()` that copies into that buffer is immediately
// visible through every view. Never cache a field value across a phase
// boundary; cache the view.
//
// EVERY VALUE HERE IS AN INT32. Writing a float into an Int32Array truncates
// toward zero silently, which is a determinism bug that will not reproduce on
// the machine that reports it. Convert with core/fixed.ts first.
// =============================================================================

import {
  Contact, EVENT_CAP, EVENT_WORDS_EACH, F, FIGHTER_WORDS, GL, GLOBAL_WORDS,
  INPUT_RING_FRAMES, MoveId, OFF_EVENTS, OFF_FIGHTER, OFF_GLOBAL, OFF_RING,
  ROUND_TIME, RoundState, S, SIM_HZ, STATE_WORDS,
} from '@/core/contracts';
import type {
  CharId, CmdMask, CompiledChar, CreateStateFn, DefRegistry, Facing, FighterFlags,
  FighterView, FX, GlobalView, GroupMask, PlayerIx, SimState, SnapshotFn, StageDef,
  StageId, StateBuf,
} from '@/core/contracts';
import { assert } from '@/core/assert';
import { fx } from '@/core/fixed';
import { seedFrom } from '@/core/rng';

// -----------------------------------------------------------------------------
// Layout invariants. If contracts.ts ever grows a field these fail at load,
// loudly, instead of two subsystems quietly reading each other's words.
// -----------------------------------------------------------------------------
assert(OFF_GLOBAL === 0, 'sim/state: OFF_GLOBAL must be 0');
assert(OFF_FIGHTER === OFF_GLOBAL + GLOBAL_WORDS, 'sim/state: fighter slots must follow the globals');
assert(F._pad48 <= FIGHTER_WORDS, 'sim/state: fighter fields overflow FIGHTER_WORDS');
assert(GL._pad16 <= GLOBAL_WORDS, 'sim/state: global fields overflow GLOBAL_WORDS');
assert(OFF_RING === OFF_FIGHTER + 2 * FIGHTER_WORDS, 'sim/state: input rings must follow the fighters');
assert(OFF_EVENTS === OFF_RING + 2 * INPUT_RING_FRAMES, 'sim/state: event ring must follow the input rings');
assert(
  STATE_WORDS >= OFF_EVENTS + EVENT_CAP * EVENT_WORDS_EACH,
  'sim/state: STATE_WORDS is too small for the event ring',
);

/** Word span of the event ring. */
const EVENT_WORDS_TOTAL = EVENT_CAP * EVENT_WORDS_EACH;

/** Round clock is counted in FRAMES, not seconds: the sim has no wall clock. */
export const ROUND_FRAMES = ROUND_TIME * SIM_HZ;

/** `lastHitFrame` when a fighter has not been hit this round. */
export const NEVER_HIT = -1;

/** The other slot. No branchy slot-index logic anywhere else, please. */
export const otherPlayer = (p: PlayerIx): PlayerIx => (p === 0 ? 1 : 0);

// -----------------------------------------------------------------------------
// FighterView — 47 live words at `base`, padded to 64.
// -----------------------------------------------------------------------------
class FighterViewImpl implements FighterView {
  readonly buf: StateBuf;
  readonly base: number;
  readonly ix: PlayerIx;

  constructor(buf: StateBuf, ix: PlayerIx) {
    this.buf = buf;
    this.ix = ix;
    this.base = OFF_FIGHTER + ix * FIGHTER_WORDS;
  }

  get posX(): FX { return this.buf[this.base + F.posX]!; }
  set posX(v: FX) { this.buf[this.base + F.posX] = v; }
  get posY(): FX { return this.buf[this.base + F.posY]!; }
  set posY(v: FX) { this.buf[this.base + F.posY] = v; }
  get velX(): FX { return this.buf[this.base + F.velX]!; }
  set velX(v: FX) { this.buf[this.base + F.velX] = v; }
  get velY(): FX { return this.buf[this.base + F.velY]!; }
  set velY(v: FX) { this.buf[this.base + F.velY] = v; }
  get facing(): Facing { return this.buf[this.base + F.facing]! as Facing; }
  set facing(v: Facing) { this.buf[this.base + F.facing] = v; }
  get charId(): CharId { return this.buf[this.base + F.charId]! as CharId; }
  set charId(v: CharId) { this.buf[this.base + F.charId] = v; }
  get state(): S { return this.buf[this.base + F.state]! as S; }
  set state(v: S) { this.buf[this.base + F.state] = v; }
  get stateFrame(): number { return this.buf[this.base + F.stateFrame]!; }
  set stateFrame(v: number) { this.buf[this.base + F.stateFrame] = v; }
  get action(): MoveId { return this.buf[this.base + F.action]! as MoveId; }
  set action(v: MoveId) { this.buf[this.base + F.action] = v; }
  get actionFrame(): number { return this.buf[this.base + F.actionFrame]!; }
  set actionFrame(v: number) { this.buf[this.base + F.actionFrame] = v; }
  get prevAction(): MoveId { return this.buf[this.base + F.prevAction]! as MoveId; }
  set prevAction(v: MoveId) { this.buf[this.base + F.prevAction] = v; }
  get hp(): number { return this.buf[this.base + F.hp]!; }
  set hp(v: number) { this.buf[this.base + F.hp] = v; }
  get hitstun(): number { return this.buf[this.base + F.hitstun]!; }
  set hitstun(v: number) { this.buf[this.base + F.hitstun] = v; }
  get blockstun(): number { return this.buf[this.base + F.blockstun]!; }
  set blockstun(v: number) { this.buf[this.base + F.blockstun] = v; }
  get hitstop(): number { return this.buf[this.base + F.hitstop]!; }
  set hitstop(v: number) { this.buf[this.base + F.hitstop] = v; }
  get knockdownTimer(): number { return this.buf[this.base + F.knockdownTimer]!; }
  set knockdownTimer(v: number) { this.buf[this.base + F.knockdownTimer] = v; }
  get wakeupTimer(): number { return this.buf[this.base + F.wakeupTimer]!; }
  set wakeupTimer(v: number) { this.buf[this.base + F.wakeupTimer] = v; }
  get landingLag(): number { return this.buf[this.base + F.landingLag]!; }
  set landingLag(v: number) { this.buf[this.base + F.landingLag] = v; }
  get comboCount(): number { return this.buf[this.base + F.comboCount]!; }
  set comboCount(v: number) { this.buf[this.base + F.comboCount] = v; }
  get comboDamage(): number { return this.buf[this.base + F.comboDamage]!; }
  set comboDamage(v: number) { this.buf[this.base + F.comboDamage] = v; }
  get juggleCount(): number { return this.buf[this.base + F.juggleCount]!; }
  set juggleCount(v: number) { this.buf[this.base + F.juggleCount] = v; }
  get gravityMulPct(): number { return this.buf[this.base + F.gravityMulPct]!; }
  set gravityMulPct(v: number) { this.buf[this.base + F.gravityMulPct] = v; }
  get hitIdsUsed(): number { return this.buf[this.base + F.hitIdsUsed]!; }
  set hitIdsUsed(v: number) { this.buf[this.base + F.hitIdsUsed] = v; }
  get usedCancels(): GroupMask { return this.buf[this.base + F.usedCancels]!; }
  set usedCancels(v: GroupMask) { this.buf[this.base + F.usedCancels] = v; }
  get chainDepth(): number { return this.buf[this.base + F.chainDepth]!; }
  set chainDepth(v: number) { this.buf[this.base + F.chainDepth] = v; }
  get chainMoveId(): MoveId { return this.buf[this.base + F.chainMoveId]! as MoveId; }
  set chainMoveId(v: MoveId) { this.buf[this.base + F.chainMoveId] = v; }
  get flags(): FighterFlags { return this.buf[this.base + F.flags]!; }
  set flags(v: FighterFlags) { this.buf[this.base + F.flags] = v; }
  get lastContact(): Contact { return this.buf[this.base + F.lastContact]! as Contact; }
  set lastContact(v: Contact) { this.buf[this.base + F.lastContact] = v; }
  get commandMask(): CmdMask { return this.buf[this.base + F.commandMask]!; }
  set commandMask(v: CmdMask) { this.buf[this.base + F.commandMask] = v; }
  get chargeBack(): number { return this.buf[this.base + F.chargeBack]!; }
  set chargeBack(v: number) { this.buf[this.base + F.chargeBack] = v; }
  get chargeDown(): number { return this.buf[this.base + F.chargeDown]!; }
  set chargeDown(v: number) { this.buf[this.base + F.chargeDown] = v; }
  get pushX(): FX { return this.buf[this.base + F.pushX]!; }
  set pushX(v: FX) { this.buf[this.base + F.pushX] = v; }
  get pushY(): FX { return this.buf[this.base + F.pushY]!; }
  set pushY(v: FX) { this.buf[this.base + F.pushY] = v; }
  get pushW(): FX { return this.buf[this.base + F.pushW]!; }
  set pushW(v: FX) { this.buf[this.base + F.pushW] = v; }
  get pushH(): FX { return this.buf[this.base + F.pushH]!; }
  set pushH(v: FX) { this.buf[this.base + F.pushH] = v; }
  get lastHitFrame(): number { return this.buf[this.base + F.lastHitFrame]!; }
  set lastHitFrame(v: number) { this.buf[this.base + F.lastHitFrame] = v; }
  get airJumpsUsed(): number { return this.buf[this.base + F.airJumpsUsed]!; }
  set airJumpsUsed(v: number) { this.buf[this.base + F.airJumpsUsed] = v; }
  get dashTimer(): number { return this.buf[this.base + F.dashTimer]!; }
  set dashTimer(v: number) { this.buf[this.base + F.dashTimer] = v; }
  get wallTouch(): number { return this.buf[this.base + F.wallTouch]!; }
  set wallTouch(v: number) { this.buf[this.base + F.wallTouch] = v; }
  get throwTechTimer(): number { return this.buf[this.base + F.throwTechTimer]!; }
  set throwTechTimer(v: number) { this.buf[this.base + F.throwTechTimer] = v; }
  get throwHoldTimer(): number { return this.buf[this.base + F.throwHoldTimer]!; }
  set throwHoldTimer(v: number) { this.buf[this.base + F.throwHoldTimer] = v; }
  get throwPartnerAction(): MoveId { return this.buf[this.base + F.throwPartnerAction]! as MoveId; }
  set throwPartnerAction(v: MoveId) { this.buf[this.base + F.throwPartnerAction] = v; }
  get armorHitsLeft(): number { return this.buf[this.base + F.armorHitsLeft]!; }
  set armorHitsLeft(v: number) { this.buf[this.base + F.armorHitsLeft] = v; }
  get stunScalePct(): number { return this.buf[this.base + F.stunScalePct]!; }
  set stunScalePct(v: number) { this.buf[this.base + F.stunScalePct] = v; }
  get blockHeld(): number { return this.buf[this.base + F.blockHeld]!; }
  set blockHeld(v: number) { this.buf[this.base + F.blockHeld] = v; }
  get jumpDir(): number { return this.buf[this.base + F.jumpDir]!; }
  set jumpDir(v: number) { this.buf[this.base + F.jumpDir] = v; }
  get roundWins(): number { return this.buf[this.base + F.roundWins]!; }
  set roundWins(v: number) { this.buf[this.base + F.roundWins] = v; }
}

// -----------------------------------------------------------------------------
// GlobalView — 16 live words at 0, padded to 32.
// -----------------------------------------------------------------------------
class GlobalViewImpl implements GlobalView {
  readonly buf: StateBuf;

  constructor(buf: StateBuf) {
    this.buf = buf;
  }

  get frame(): number { return this.buf[OFF_GLOBAL + GL.frame]!; }
  set frame(v: number) { this.buf[OFF_GLOBAL + GL.frame] = v; }
  get rngState(): number { return this.buf[OFF_GLOBAL + GL.rngState]!; }
  set rngState(v: number) { this.buf[OFF_GLOBAL + GL.rngState] = v; }
  get roundNo(): number { return this.buf[OFF_GLOBAL + GL.roundNo]!; }
  set roundNo(v: number) { this.buf[OFF_GLOBAL + GL.roundNo] = v; }
  get roundTimer(): number { return this.buf[OFF_GLOBAL + GL.roundTimer]!; }
  set roundTimer(v: number) { this.buf[OFF_GLOBAL + GL.roundTimer] = v; }
  get roundState(): RoundState { return this.buf[OFF_GLOBAL + GL.roundState]! as RoundState; }
  set roundState(v: RoundState) { this.buf[OFF_GLOBAL + GL.roundState] = v; }
  get roundStateFrame(): number { return this.buf[OFF_GLOBAL + GL.roundStateFrame]!; }
  set roundStateFrame(v: number) { this.buf[OFF_GLOBAL + GL.roundStateFrame] = v; }
  get p0Wins(): number { return this.buf[OFF_GLOBAL + GL.p0Wins]!; }
  set p0Wins(v: number) { this.buf[OFF_GLOBAL + GL.p0Wins] = v; }
  get p1Wins(): number { return this.buf[OFF_GLOBAL + GL.p1Wins]!; }
  set p1Wins(v: number) { this.buf[OFF_GLOBAL + GL.p1Wins] = v; }
  get lastHitBy(): PlayerIx { return this.buf[OFF_GLOBAL + GL.lastHitBy]! as PlayerIx; }
  set lastHitBy(v: PlayerIx) { this.buf[OFF_GLOBAL + GL.lastHitBy] = v; }
  get stageId(): StageId { return this.buf[OFF_GLOBAL + GL.stageId]! as StageId; }
  set stageId(v: StageId) { this.buf[OFF_GLOBAL + GL.stageId] = v; }
  get teleportEpoch(): number { return this.buf[OFF_GLOBAL + GL.teleportEpoch]!; }
  set teleportEpoch(v: number) { this.buf[OFF_GLOBAL + GL.teleportEpoch] = v; }
  get eventCount(): number { return this.buf[OFF_GLOBAL + GL.eventCount]!; }
  set eventCount(v: number) { this.buf[OFF_GLOBAL + GL.eventCount] = v; }
  get eventHead(): number { return this.buf[OFF_GLOBAL + GL.eventHead]!; }
  set eventHead(v: number) { this.buf[OFF_GLOBAL + GL.eventHead] = v; }
  get confirmedFrame(): number { return this.buf[OFF_GLOBAL + GL.confirmedFrame]!; }
  set confirmedFrame(v: number) { this.buf[OFF_GLOBAL + GL.confirmedFrame] = v; }
  get matchOver(): number { return this.buf[OFF_GLOBAL + GL.matchOver]!; }
  set matchOver(v: number) { this.buf[OFF_GLOBAL + GL.matchOver] = v; }
  get seed(): number { return this.buf[OFF_GLOBAL + GL.seed]!; }
  set seed(v: number) { this.buf[OFF_GLOBAL + GL.seed] = v; }
}

// -----------------------------------------------------------------------------
// SimState
// -----------------------------------------------------------------------------
class SimStateImpl implements SimState {
  readonly buf: StateBuf;
  readonly g: GlobalView;
  readonly defs: DefRegistry;
  private readonly f0: FighterView;
  private readonly f1: FighterView;

  constructor(buf: StateBuf, defs: DefRegistry) {
    this.buf = buf;
    this.defs = defs;
    this.g = new GlobalViewImpl(buf);
    this.f0 = new FighterViewImpl(buf, 0);
    this.f1 = new FighterViewImpl(buf, 1);
  }

  fighter(p: PlayerIx): FighterView {
    return p === 0 ? this.f0 : this.f1;
  }
}

/** A zeroed state buffer. The snapshot ring allocates these up front. */
export const allocStateBuffer = (): StateBuf => new Int32Array(STATE_WORDS);

/**
 * Wraps an EXISTING buffer in views without touching its contents. For the
 * rollback harness and for tests that load a buffer from a golden replay.
 * `createState` is what you want for a fresh match.
 */
export const attachState = (buf: StateBuf, defs: DefRegistry): SimState => {
  assert(buf.length >= STATE_WORDS, 'sim/state: buffer is smaller than STATE_WORDS');
  return new SimStateImpl(buf, defs);
};

// -----------------------------------------------------------------------------
// Def lookups. Every module that needs the compiled character or the stage goes
// through these, so exactly one place knows how charId indexes the registry.
// -----------------------------------------------------------------------------

export const charOf = (s: SimState, p: PlayerIx): CompiledChar => {
  const c = s.defs.chars[s.fighter(p).charId];
  assert(c !== undefined, `sim/state: no compiled character for slot ${p}`);
  return c;
};

export const stageOf = (s: SimState): StageDef => {
  const st = s.defs.stages[s.g.stageId];
  assert(st !== undefined, `sim/state: no stage def for id ${s.g.stageId}`);
  return st;
};

/**
 * Stage bounds in FX. StageDef is authored in WORLD UNITS (it is not compiled),
 * so these three exist to stop physics and collision each inventing their own
 * conversion and disagreeing by a unit at the wall.
 */
export const stageLeftFx = (st: StageDef): FX => fx(st.wallPad);
export const stageRightFx = (st: StageDef): FX => fx(st.width - st.wallPad);
export const stageCeilingFx = (st: StageDef): FX => fx(st.ceiling);

// -----------------------------------------------------------------------------
// Event ring housekeeping. The ring's CONTENT is owned by sim/events.ts; the
// buffer region is owned here, so the round reset can wipe it without importing
// a module that imports us back.
// -----------------------------------------------------------------------------
export const clearEvents = (s: SimState): void => {
  s.buf.fill(0, OFF_EVENTS, OFF_EVENTS + EVENT_WORDS_TOTAL);
  s.g.eventCount = 0;
  s.g.eventHead = 0;
};

// -----------------------------------------------------------------------------
// Round / match setup
// -----------------------------------------------------------------------------

/**
 * Resets one fighter to neutral at its spawn. Does NOT touch `charId` or
 * `roundWins` — those survive a round.
 */
const resetFighter = (s: SimState, p: PlayerIx, stage: StageDef): void => {
  const f = s.fighter(p);
  const c = charOf(s, p);

  f.posX = fx(stage.startX[p]);
  f.posY = 0;
  f.velX = 0;
  f.velY = 0;

  f.state = S.STAND;
  f.stateFrame = 0;
  f.action = MoveId.NONE;
  f.actionFrame = 0;
  f.prevAction = MoveId.NONE;

  f.hp = c.hp;
  f.hitstun = 0;
  f.blockstun = 0;
  f.hitstop = 0;
  f.knockdownTimer = 0;
  f.wakeupTimer = 0;
  f.landingLag = 0;

  f.comboCount = 0;
  f.comboDamage = 0;
  f.juggleCount = 0;
  // 100, never 0: physics multiplies gravity by this percent.
  f.gravityMulPct = 100;

  f.hitIdsUsed = 0;
  f.usedCancels = 0;
  f.chainDepth = 0;
  f.chainMoveId = MoveId.NONE;

  f.flags = 0;
  f.lastContact = Contact.NONE;
  f.commandMask = 0;
  f.chargeBack = 0;
  f.chargeDown = 0;

  // A valid pushbox from frame 0, so collision never reads a zero-size box.
  f.pushX = c.standPush.x;
  f.pushY = c.standPush.y;
  f.pushW = c.standPush.w;
  f.pushH = c.standPush.h;

  f.lastHitFrame = NEVER_HIT;
  f.airJumpsUsed = 0;
  f.dashTimer = 0;
  f.wallTouch = 0;

  f.throwTechTimer = 0;
  f.throwHoldTimer = 0;
  f.throwPartnerAction = MoveId.NONE;
  f.armorHitsLeft = 0;

  // 100, never 0: hitstun proration multiplies by this percent.
  f.stunScalePct = 100;
  f.blockHeld = 0;
  f.jumpDir = 0;
};

/**
 * Faces the fighters at each other from the STAGE's spawn positions rather than
 * from posX. Reading the data instead of the live slots keeps this free of the
 * "compare the two players and break the tie by slot index" pattern that
 * tests/mirror.test.ts exists to catch.
 */
const faceOff = (s: SimState, stage: StageDef): void => {
  const dir: Facing = stage.startX[0] <= stage.startX[1] ? 1 : -1;
  s.fighter(0).facing = dir;
  s.fighter(1).facing = (dir === 1 ? -1 : 1) as Facing;
};

/**
 * Puts a round back to its opening frame: both fighters neutral at their
 * spawns, full HP, clock reloaded, event ring empty. Keeps the match score,
 * the frame counter, the rng stream and the input rings.
 *
 * INPUT RINGS ARE DELIBERATELY NOT CLEARED. Presses are edges derived from
 * adjacent frames, so a button still held across the reset produces no edge and
 * therefore no move; wiping the ring would instead fabricate a press on the
 * next frame the player happens to be holding something.
 *
 * Bumps `teleportEpoch`, which is the renderer's signal that the root moved
 * discontinuously and this frame must NOT be interpolated.
 */
export const resetRound = (s: SimState): void => {
  const g = s.g;
  const stage = stageOf(s);

  g.roundTimer = ROUND_FRAMES;
  g.roundState = RoundState.FIGHT;
  g.roundStateFrame = 0;
  g.lastHitBy = 0;
  g.teleportEpoch = (g.teleportEpoch + 1) | 0;

  clearEvents(s);
  resetFighter(s, 0, stage);
  resetFighter(s, 1, stage);
  faceOff(s, stage);
};

/**
 * THE constructor for a match. Allocates the buffer, wires the views, seeds the
 * sim rng from `seed` and opens round 1.
 *
 * Starts in `RoundState.FIGHT`, not INTRO: M0 defers the intro sequencer, and a
 * round that opens in a state nothing advances is a black screen. When
 * sim/round.ts grows the intro it sets INTRO here and drives the transition.
 */
export const createState: CreateStateFn = (seed, charA, charB, stage, defs) => {
  const s = new SimStateImpl(allocStateBuffer(), defs);
  const g = s.g;

  g.frame = 0;
  g.confirmedFrame = 0;
  g.seed = seed | 0;
  g.rngState = seedFrom(seed);
  g.stageId = stage;
  g.roundNo = 1;
  g.p0Wins = 0;
  g.p1Wins = 0;
  g.matchOver = 0;
  g.teleportEpoch = 0;

  const f0 = s.fighter(0);
  const f1 = s.fighter(1);
  f0.charId = charA;
  f1.charId = charB;
  f0.roundWins = 0;
  f1.roundWins = 0;

  resetRound(s);
  return s;
};

// -----------------------------------------------------------------------------
// Snapshot / restore — the whole rollback story, in two lines.
// -----------------------------------------------------------------------------

/** dst.set(src). One 2304-byte copy; there is nothing else to save. */
export const snapshot: SnapshotFn = (dst, src) => {
  dst.set(src);
};

/**
 * The same copy in the other direction, named for the caller's intent. Views
 * built over `dst` stay valid because the buffer object is not replaced.
 */
export const restore: SnapshotFn = (dst, src) => {
  dst.set(src);
};

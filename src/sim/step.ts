// =============================================================================
// SunForce — src/sim/step.ts
// THE FRAME. Thirteen phases, one order, one owner.
//
// docs/ENGINE-DECISIONS.md §4 states the canonical frame order once and names
// this file as its owner. The order below IS that list, phase for phase. If a
// new system needs a place in the frame it gets a numbered phase here, never a
// call bolted onto the end of some other module — a second file that decides
// when work happens is how an engine acquires two contradictory orders, which
// is the exact failure §4 exists to prevent.
//
// THE TWO THINGS EVERYTHING ELSE IS DOWNSTREAM OF
//
//  1. THE PER-FIGHTER HITSTOP GATE IS THE ONLY FREEZE, and hitstun, blockstun
//     and knockdownTimer tick INSIDE it (sim/fighter.ts tickTimers). Ticking
//     them outside the gate burns 9 to 14 frames of every hit's advantage and
//     drops every combo in the game — and it does it silently, because each
//     move in isolation still looks correct.
//     What the gate does NOT freeze: the frame counter, the input rings, the
//     command recogniser, the event ring, the camera, sparks and audio. A big
//     kick must read as "the fighters are frozen, the world is exploding", and
//     a player must be able to buffer a confirm THROUGH the freeze.
//
//  2. gather() -> freeze() -> commit(), in that order, with commit reading only
//     the frozen pre-commit snapshot. Gathering simultaneously but committing
//     sequentially still leaks: corner pushback reads the opponent's cornered
//     flag and scaling reads comboCount, so whoever resolves second reads a
//     world the first one already changed. That is the mechanism behind "that
//     trade resolves differently on P2 side". The snapshot removes it by
//     construction rather than by care.
//
// PHASES WITH NO MODULE YET. Commands (phase 2), throws (phase 10b) and the
// round flow (phase 12) have no file of their own in M0. They are present here
// as their own named, typed functions doing the one honest thing their absence
// implies, so that landing sim/commands.ts, sim/throws.ts or sim/round.ts is a
// one-line substitution at a call site that already exists in the right place.
//
// PURITY. Pure over (buf, in0, in1): no DOM, no Date, no Math.random, no float
// and no allocation. The two scratch objects below are allocated once at module
// load and fully overwritten every frame (gather() clears its own cells, and
// freeze() writes every snapshot field), so they carry nothing across frames
// and nothing across a rollback.
// =============================================================================

import {
  Ev, KO_SLOWMO_FRAMES, ROUNDS_TO_WIN, RoundState, SfxId,
} from '@/core/contracts';
import type { PlayerIx, SimState, StepFn } from '@/core/contracts';
import { ringWrite } from '@/core/ring';
import { resetRound } from '@/sim/state';
import { advanceAction, resolveTransitions, tickTimers, updateFacing } from '@/sim/fighter';
import { groundClamp, integrate, separate, wallClamp } from '@/sim/physics';
import { createGatherResult, gather } from '@/sim/collision';
import type { GatherResult } from '@/sim/collision';
import { commit, createPreCommit, freeze, isKO } from '@/sim/hits';
import type { PreCommit } from '@/sim/hits';
import { beginFrame, packB, pushEvent } from '@/sim/events';

// -----------------------------------------------------------------------------
// Frame scratch. Allocated once; the sim is single-threaded and step() is not
// re-entrant, which is the same contract sim/collision.ts holds its snapshot
// arrays under.
// -----------------------------------------------------------------------------

const GATHERED: GatherResult = createGatherResult();
const PRE_COMMIT: PreCommit = createPreCommit();

// -----------------------------------------------------------------------------
// PHASE 2 — commands. Runs ALWAYS, including for a fighter in hitstop.
// -----------------------------------------------------------------------------

/**
 * Recognises motion inputs (QCF / QCB / DP / RDP / charge) into
 * `FighterView.commandMask`, which sim/fighter.ts reads when matching a move
 * that carries a `command` requirement.
 *
 * sim/commands.ts is deferred: M0 has no move with a motion requirement. With
 * no recogniser installed the set of motions recognised THIS frame is empty,
 * and writing that empty set every frame is the honest statement of it — a mask
 * that is only ever written by a recogniser would otherwise be free to hold a
 * motion recognised before a rollback, a round reset or a character swap.
 *
 * This is deliberately OUTSIDE the hitstop gate. Recognition is an input-side
 * concern: the QCF a player completes during a 14-frame freeze is the whole
 * reason the freeze is a confirm window.
 */
const recogniseCommands = (s: SimState): void => {
  s.fighter(0).commandMask = 0;
  s.fighter(1).commandMask = 0;
};

// -----------------------------------------------------------------------------
// PHASE 10b — throws.
// -----------------------------------------------------------------------------

/**
 * Applies the throw candidates gathered in phase 8, against the same frozen
 * snapshot the strike commit used.
 *
 * sim/throws.ts is deferred and M0 authors no throw boxes, so gather() never
 * fills these cells. Retiring them here anyway preserves the invariant the
 * whole phase-8/10 split rests on: a candidate that survives past phase 10 has
 * been APPLIED. When throws.ts lands it replaces this body and nothing above it
 * has to move.
 */
const commitThrows = (g: GatherResult): void => {
  g.grab[0].grab = null;
  g.grab[1].grab = null;
};

// -----------------------------------------------------------------------------
// PHASE 12 — the round.
//
// This is sim/round.ts's job and it moves there unchanged when that file lands;
// it lives here in M0 because acceptance test 7 is "ten kicks KO, the round
// resets" and a no-op leaves the slice wedged on a corpse. It owns pacing only:
// hits.commit owns the KO itself and sim/state.ts owns what a reset means.
// -----------------------------------------------------------------------------

/** How long the KO pose holds before the round is declared over. Deliberately
 *  KO_SLOWMO_FRAMES, so the hold and the loop's slow-motion end together. */
const KO_HOLD_FRAMES = KO_SLOWMO_FRAMES;
/** Round banner hold, then the next round opens. §16 has no name for these two
 *  yet; they move there with sim/round.ts. */
const ROUND_END_FRAMES = 90;
/** The match is over and the winner is dancing: this is how long the sim holds
 *  the finished state before `startNextMatch` resets it. Long enough that
 *  game/match.ts can sit on the celebration for a few seconds and still leave
 *  with room to spare — see MATCH_END_HOLD_FRAMES, which must stay under it. */
const MATCH_END_FRAMES = 420;

/**
 * The winner of the round, or -1 for a draw.
 *
 * Equal HP at time over and a double KO both return -1. Picking a winner there
 * would be a slot-index tiebreak wearing a different hat, and tests/mirror
 * exists to catch exactly that.
 */
const roundWinner = (s: SimState): PlayerIx | -1 => {
  const hp0 = s.fighter(0).hp;
  const hp1 = s.fighter(1).hp;
  if (hp0 <= 0 && hp1 <= 0) return -1;
  if (hp0 <= 0) return 1;
  if (hp1 <= 0) return 0;
  if (hp0 > hp1) return 0;
  if (hp1 > hp0) return 1;
  return -1;
};

/**
 * Credits the round, on the FIRST frame of the KO and never at the end of the
 * hold: a hitbox still live during those 45 frames could otherwise drop the
 * winner to zero HP too and turn a clean win into a draw.
 *
 * `Ev.ROUND_END` carries the outcome in the damage half of `b` as winner + 1,
 * so 0 = draw, 1 = P1, 2 = P2. The actor word stays a real player index.
 */
const awardRound = (s: SimState): void => {
  const g = s.g;
  const w = roundWinner(s);
  if (w === 0) {
    g.p0Wins = (g.p0Wins + 1) | 0;
    s.fighter(0).roundWins = g.p0Wins;
  } else if (w === 1) {
    g.p1Wins = (g.p1Wins + 1) | 0;
    s.fighter(1).roundWins = g.p1Wins;
  }
  pushEvent(s, Ev.ROUND_END, w === -1 ? 0 : w, packB(w + 1, SfxId.BELL), 0, 0, 0);
};

/** Opens the next round. resetRound clears the event ring, so the ROUND_START
 *  event is pushed after it, not before. */
const startNextRound = (s: SimState): void => {
  const g = s.g;
  g.roundNo = (g.roundNo + 1) | 0;
  resetRound(s);
  pushEvent(s, Ev.ROUND_START, 0, packB(g.roundNo, SfxId.ROUND_START), 0, 0, 0);
};

/** Opens a fresh match. M0 has no rematch screen; starting over is what keeps
 *  the slice playable forever instead of ending on a frozen final frame. */
const startNextMatch = (s: SimState): void => {
  const g = s.g;
  g.matchOver = 0;
  g.roundNo = 1;
  g.p0Wins = 0;
  g.p1Wins = 0;
  s.fighter(0).roundWins = 0;
  s.fighter(1).roundWins = 0;
  resetRound(s);
  pushEvent(s, Ev.ROUND_START, 0, packB(1, SfxId.ROUND_START), 0, 0, 0);
};

/**
 * PHASE 12. The round clock and the KO -> ROUND_END -> next round sequence.
 *
 * `roundStateFrame` is pinned to zero for the whole of FIGHT and counted only
 * inside the post-fight states. FIGHT's elapsed time is already the round clock
 * (ROUND_FRAMES - roundTimer), so nothing is lost — and it buys every branch
 * below a trustworthy frame 0 even though hits.commit is the thing that flips
 * FIGHT -> KO, two phases earlier, without touching this counter.
 */
const roundCheck = (s: SimState): void => {
  const g = s.g;

  switch (g.roundState) {
    case RoundState.FIGHT: {
      g.roundStateFrame = 0;
      if (g.roundTimer > 0) g.roundTimer = (g.roundTimer - 1) | 0;
      // hits.commit already flips to KO on a fatal blow. The isKO() arm is the
      // safety net for a fighter reaching zero HP any other way (a test, a
      // future chip or dot source) — the round must end either way.
      if (g.roundTimer === 0 || isKO(s)) g.roundState = RoundState.KO;
      return;
    }

    case RoundState.KO: {
      if (g.roundStateFrame === 0) awardRound(s);
      if (g.roundStateFrame >= KO_HOLD_FRAMES) {
        g.roundState = RoundState.ROUND_END;
        g.roundStateFrame = 0;
        return;
      }
      g.roundStateFrame = (g.roundStateFrame + 1) | 0;
      return;
    }

    case RoundState.ROUND_END: {
      if (g.roundStateFrame >= ROUND_END_FRAMES) {
        if (g.p0Wins >= ROUNDS_TO_WIN || g.p1Wins >= ROUNDS_TO_WIN) {
          g.matchOver = 1;
          g.roundState = RoundState.MATCH_END;
          g.roundStateFrame = 0;
          pushEvent(
            s, Ev.MATCH_END, g.p0Wins >= ROUNDS_TO_WIN ? 0 : 1,
            packB(0, SfxId.NONE), 0, 0, 0,
          );
        } else {
          startNextRound(s);
        }
        return;
      }
      g.roundStateFrame = (g.roundStateFrame + 1) | 0;
      return;
    }

    case RoundState.MATCH_END: {
      // g.matchOver latches for this whole hold, which is the window the scene
      // that owns a rematch UI will read. Until that scene exists, a fresh
      // match keeps the slice from wedging.
      if (g.roundStateFrame >= MATCH_END_FRAMES) {
        startNextMatch(s);
        return;
      }
      g.roundStateFrame = (g.roundStateFrame + 1) | 0;
      return;
    }

    case RoundState.INTRO: {
      // M0 defers the intro sequencer, and sim/state.ts opens round 1 in FIGHT
      // for exactly that reason. Falling straight through means a state set by
      // anything else can never leave the round in a phase nothing advances.
      g.roundState = RoundState.FIGHT;
      g.roundStateFrame = 0;
      return;
    }
  }
};

// -----------------------------------------------------------------------------
// THE FRAME
// -----------------------------------------------------------------------------

/**
 * THE ONLY MUTATOR. `in0` / `in1` are raw held masks with ABSOLUTE directions,
 * already sticky-latched by the input source; everything facing-relative is
 * derived downstream at read time so a replay survives a side swap.
 *
 * Not set here: `g.confirmedFrame`. The watermark belongs to the Runner, which
 * is the only thing that knows whether a frame can still be rolled back. A
 * local, no-rollback Runner confirms every frame immediately after this call.
 */
export const step: StepFn = (s, in0, in1) => {
  const g = s.g;

  // --- PHASE 0. The frame exists. -------------------------------------------
  // beginFrame drops any event stamped at or after this frame, which only
  // happens when a harness re-enters a frame the ring already holds.
  g.frame = (g.frame + 1) | 0;
  beginFrame(s);

  // --- PHASE 1. Input rings advance. ALWAYS, even in hitstop. ---------------
  // ringWrite clears the slot's consumed bits as it publishes, so a press is
  // retired per frame slot and a stale consume cannot eat a genuinely new press
  // six frames later.
  ringWrite(s.buf, 0, g.frame, in0);
  ringWrite(s.buf, 1, g.frame, in1);

  // --- PHASE 2. Commands -> commandMask. ALWAYS. ----------------------------
  recogniseCommands(s);

  // --- PHASE 3. The state machine, per fighter, behind THE ONLY FREEZE. -----
  for (let p = 0; p < 2; p++) {
    const ix = p as PlayerIx;
    const f = s.fighter(ix);

    // THE GATE. Symmetric by construction: hits.commit assigns attacker and
    // defender the SAME count (the max of the two on a trade), which is what
    // makes frame advantage computable — the hitstop cancels out of
    // adv = stun - attackerFramesRemaining.
    if (f.hitstop > 0) {
      f.hitstop = (f.hitstop - 1) | 0;
      continue;
    }

    // INSIDE the gate: hitstun--, blockstun--, knockdownTimer--, wakeupTimer--,
    // landingLag--, dashTimer--, throw timers. Every one of them.
    tickTimers(s, ix);
    // The one and only assignment of f.state, then the move timeline advances
    // and this frame's boxes and velocities are applied.
    resolveTransitions(s, ix);
    advanceAction(s, ix);
  }

  // --- PHASES 4-7. The world moves. Each pass skips a frozen fighter itself. -
  integrate(s);
  groundClamp(s);
  wallClamp(s);
  separate(s);

  // --- PHASE 8. Gather. One position snapshot, BOTH fighters, hits AND
  //     throws. Nothing is applied here, and nothing may be. ----------------
  gather(s, GATHERED);

  // --- PHASE 9. Freeze. Every field commit is allowed to read, copied out of
  //     the live views before a single one of them is written. --------------
  freeze(s, PRE_COMMIT);

  // --- PHASE 10. Commit. Reads ONLY the frozen snapshot, so two strikes
  //     landing on the same frame resolve order-independently. --------------
  commit(s, GATHERED, PRE_COMMIT);
  commitThrows(GATHERED);

  // --- PHASE 11. Facing. After the commit, so a fighter that was just hit
  //     keeps the facing it was hit with. ------------------------------------
  updateFacing(s);

  // --- PHASE 12. The round. Last, so it sees this frame's damage. -----------
  roundCheck(s);
};

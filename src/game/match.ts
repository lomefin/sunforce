// =============================================================================
// SunForce — src/game/match.ts
// THE MATCH LIFECYCLE. One MatchConfig in, one running fight out.
//
// A "match" is the sim state, the interpolation snapshot, player 2's dummy when
// the config asks for one, and the two skins the renderer wears. Nothing here
// knows about scenes, the loop or the select screen — game/scenes.ts owns that
// order of events — so a test, a replay tool or a headless harness can create a
// match, step it and never touch a Scene.
//
// THE ASYNC SKIN PROBLEM, AND HOW IT IS RESOLVED
//   `Scene.enter()` is synchronous; `loadSpriteSkin` is not. Blocking the scene
//   on a fetch means a black frame — or, with a 404 behind a slow proxy, a black
//   match. So `prime()` does BOTH, in this order:
//
//     1. SYNCHRONOUSLY install the procedural stick skin for both players. That
//        is a real, drawable skin with no I/O behind it, so the very first frame
//        after `enter()` already renders a fighter.
//     2. START the sprite load and return immediately. When (if) the sheet
//        arrives, the promise hands it to `renderer.setSkin`, which swaps it in
//        and disposes the stick skin it replaced.
//
//   `loadSpriteSkin` resolves to null for a character with no baked sheet and
//   never rejects, and the `.catch` below covers the case where it learns to.
//   Either way the fallback is already on screen: a missing, slow or broken
//   sheet costs you the sprite, never the match.
//
//   `dispose()` raises a flag that every in-flight load checks before touching
//   the renderer, because a sheet requested by the match you just left must not
//   overwrite the skin of the match you just started. It disposes the late
//   arrival instead, so the texture is released rather than leaked.
//
// WHO PLAYS PLAYER 2 — AND WHY THE LOOP NEVER FINDS OUT
//   `core/loop.ts` owns ONE pair of input sources for the whole session and
//   hands the same pair to every `Scene.tick`. It is not ours to edit, and
//   swapping the pair under a running loop is not something it offers:
//   `setLoopSources` only arms the NEXT `startLoop`, and `startLoopWith` tears
//   the clock down and re-enters the scene from scratch.
//
//   It does not have to. The substitution happens ONE LEVEL DOWN, here, and it
//   always did — `p2IsDummy` is the field that decides it. `advance` polls
//   `sources[0]` for player 1 and, when the config asks for one, this match's
//   own stand-in for player 2. In 1P that stand-in is `createCpuSource` from
//   input/cpu.ts, which READS this match's SimState and never writes to it, so
//   the sim stays exactly what it was: a pure function of two button masks.
//
// EVERYTHING RANDOM IN A 1P MATCH IS A FUNCTION OF `MatchConfig.seed`
//   The opponent's character is drawn by `rollOpponent(seed)` and written back
//   into the config, so the config alone reproduces the fight — the pick is
//   recorded, not re-rolled, the moment it has been made. The CPU's own stream
//   is seeded from the same word. `Math.random` and `Date.now` appear nowhere
//   in this repo and must not start here.
// =============================================================================

import { DummyMode, ROUND_TIME, ROUNDS_TO_WIN } from '@/core/contracts';
import type {
  CharId, DefRegistry, InputSource, MatchConfig, PlayerIx, Renderer, SimState, StateBuf,
} from '@/core/contracts';
import type { SceneMusic } from '@/audio/scene-music';
import { Rng } from '@/core/rng';
import { allocStateBuffer, createState, snapshot } from '@/sim/state';
import { step } from '@/sim/step';
import {
  DEFAULT_CHAR, DEFAULT_STAGE, SELECTABLE_CHARS, charById, coerceChar, coerceStage,
} from '@/data/registry';
import { createStickSkin } from '@/gfx/skin/stick';
import { loadSpriteSkin } from '@/gfx/skin/sprite';
import { DUMMY_STAND, DummySource } from '@/input/dummy';
import { createCpuSource } from '@/input/cpu';

/** Everything a scene or a match needs from the outside world. */
export interface GameDeps {
  readonly gl: WebGL2RenderingContext;
  readonly renderer: Renderer;
  readonly registry: DefRegistry;
  /** Optional: absent in a headless or muted build, and every call site is
   *  then a no-op. The scenes decide WHAT plays; the facade decides HOW. */
  readonly music?: SceneMusic;
}

/** The stick look M0 shipped with. Kept here so every match looks the same. */
const STICK_LOOK = { shade: 0.85, rim: 0.7, shadow: true, backDepth: 0.3 } as const;

/** The seed the default fight boots with. A select screen picks its own. */
export const DEFAULT_SEED = 0x5f00c3;

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

/** P2's default: the second roster slot, so the boot fight is A vs B, not A vs A. */
const secondChar = (): typeof DEFAULT_CHAR => SELECTABLE_CHARS[1] ?? DEFAULT_CHAR;

/**
 * The fight the game boots into. Every field comes from the registry or from a
 * named constant in contracts, so adding a character or retuning the round
 * length changes this without an edit.
 */
export const makeMatchConfig = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  chars: [DEFAULT_CHAR, secondChar()],
  stage: DEFAULT_STAGE,
  seed: DEFAULT_SEED,
  roundsToWin: ROUNDS_TO_WIN,
  timerSeconds: ROUND_TIME,
  // The shipping path is the baked sheet; match.ts falls back to the stick skin
  // by itself when a character has none, so 'sprite' is the right INTENT to
  // record even for a slot whose art has not been drawn yet.
  skins: ['sprite', 'sprite'],
  p2IsDummy: false,
  dummy: DUMMY_STAND,
  ...over,
});

/** The config `createBootScene` uses when main.ts does not supply one. */
export const DEFAULT_MATCH: MatchConfig = makeMatchConfig();

/**
 * Force a config onto ids that exist. A replay, a URL parameter or a saved
 * choice can name a character the roster no longer has; `createState` would
 * then index a hole in the registry. Pure, and applied ONCE at match creation,
 * so what `Match.cfg` reports is what the sim is actually running.
 */
export const normalizeMatchConfig = (cfg: MatchConfig): MatchConfig => ({
  ...cfg,
  chars: [coerceChar(cfg.chars[0]), coerceChar(cfg.chars[1])],
  stage: coerceStage(cfg.stage),
});

// -----------------------------------------------------------------------------
// PLAY MODE
//
// How many HUMANS are playing, and nothing else. It is a number rather than an
// enum because that is what it means and because ui/mode.ts hands one back
// across a module boundary: `1` and `2` cannot drift the way two enums can.
//
// THE MODE IS NOT A SECOND SOURCE OF TRUTH. `p2IsDummy` already is the field
// the match reads to decide who polls for player 2, so the mode IS that field
// and `modeOf` is the whole of the mapping. It therefore survives every hop
// through the scenes inside the MatchConfig they were already carrying, with
// nothing to keep in sync and nothing to forget on the way back from a KO.
// -----------------------------------------------------------------------------

/** 1 = the CPU takes player 2. 2 = both pads are human. */
export type PlayMode = 1 | 2;
export const ONE_PLAYER: PlayMode = 1;
export const TWO_PLAYER: PlayMode = 2;

/** The mode a config is already in. */
export const modeOf = (cfg: MatchConfig): PlayMode => (cfg.p2IsDummy ? ONE_PLAYER : TWO_PLAYER);

/** Mixed into the opponent draw so it cannot echo the first value the sim's own
 *  stream produces from the same seed. Any odd constant would do. */
const OPPONENT_SALT = 0x4f50_5021 | 0;

/** How hard the 1P opponent plays. The only dial a MatchConfig carries; WHICH
 *  strategy a character uses is input/cpu.ts's business, not this file's. */
const CPU_AGGRESSION = 55;

/**
 * The seed the NEXT match runs on. A chain, not a clock: consecutive matches
 * differ — so a 1P player does not fight the same opponent forever — while the
 * whole session still replays from the seed it booted with.
 */
export const nextMatchSeed = (seed: number): number => new Rng(seed).next() | 0;

/**
 * Player 2's character in a 1P match: a PURE function of the seed that match
 * will run on. Pure is the point. The draw is recorded into the config it was
 * made for, so replaying that config reproduces the fight, and re-deriving it
 * from the seed gives the same answer — the recording and the roll can never
 * disagree about who the opponent was.
 */
export const rollOpponent = (seed: number): CharId => {
  const n = SELECTABLE_CHARS.length;
  if (n === 0) return DEFAULT_CHAR;
  return SELECTABLE_CHARS[new Rng((seed ^ OPPONENT_SALT) | 0).below(n)] ?? DEFAULT_CHAR;
};

/**
 * The config to open the CHARACTER SELECT on for `mode`.
 *
 * 1P draws a fresh opponent and hands player 2 to the CPU; 2P hands player 2
 * back to the pad. Player 1's character is left alone in both: it is the human's
 * and the select screen is about to ask them for it anyway.
 *
 * It ROLLS, so call it once per visit to the select screen — which is exactly
 * what `createSelectScene` does — and never per frame.
 */
export const configForMode = (cfg: MatchConfig, mode: PlayMode): MatchConfig => {
  if (mode === TWO_PLAYER) return { ...cfg, p2IsDummy: false };
  const seed = nextMatchSeed(cfg.seed);
  return {
    ...cfg,
    seed,
    chars: [cfg.chars[0], rollOpponent(seed)],
    p2IsDummy: true,
    // CPU_BASIC is the mode that means "a real opponent": MatchRun routes it to
    // input/cpu.ts. Every other DummyMode stays the scripted training dummy.
    dummy: { mode: DummyMode.CPU_BASIC, seed, aggression: CPU_AGGRESSION },
  };
};

// -----------------------------------------------------------------------------
// THE END OF A MATCH
// -----------------------------------------------------------------------------

/**
 * How long a finished match stays on screen before a scene may cut away.
 *
 * It MUST stay under the sim's own MATCH_END hold (`MATCH_END_FRAMES` = 420,
 * private to sim/step.ts): at that point `startNextMatch` clears the score and
 * drops `matchOver` back to 0, so a scene that waits longer than the sim does
 * watches the result it was waiting for vanish and then waits forever.
 *
 * SIX SECONDS, because this is the only time the winner's full celebration
 * plays — a round win holds a single pose, the match win dances — and cutting
 * to the select screen two seconds in meant nobody ever saw it. We leave with
 * a full second of the sim's hold still to spare.
 */
export const MATCH_END_HOLD_FRAMES = 360;

/**
 * Who won the MATCH, or -1 while one is still running.
 *
 * Read straight off the round wins: `step` only raises `matchOver` once a player
 * has reached `roundsToWin`, so the higher count is the winner and there is no
 * tie to break. `Ev.MATCH_END` carries the same index as its actor, for a caller
 * that would rather read the event ring than the score.
 */
export const matchWinner = (s: SimState): PlayerIx | -1 => {
  if (s.g.matchOver === 0) return -1;
  return s.g.p0Wins > s.g.p1Wins ? 0 : 1;
};

let lastWinner: PlayerIx | -1 = -1;

/** Who won the last match to FINISH, or -1 before one has. Presentation only —
 *  the score itself lives in `g.p0Wins` / `g.p1Wins`, inside the state buffer. */
export const lastMatchWinner = (): PlayerIx | -1 => lastWinner;

/**
 * THE MATCH-OVER LATCH, and the only thing that knows about the race.
 *
 * `g.matchOver` is a flag with a LIFETIME, not a terminal state: step raises it,
 * holds it, and then `startNextMatch` clears it and opens a fresh match. So this
 * reads it EXACTLY ONCE — on the rising edge — and from then on counts its own
 * frames. A caller that kept polling the flag instead would watch the thing it
 * was waiting for disappear at frame 150 and never fire at all.
 *
 * `over` is called once per STEPPED frame and goes true once, when the result
 * has been on screen long enough to read and before the sim wraps around.
 */
export class MatchEndWatch {
  /** Frames since the match was declared over; -1 while one is still fought. */
  private held = -1;
  /** Latched with the flag, so it survives the sim resetting the score. */
  winner: PlayerIx | -1 = -1;

  over(s: SimState): boolean {
    if (this.held < 0) {
      if (s.g.matchOver === 0) return false;
      this.held = 0;
      this.winner = matchWinner(s);
      lastWinner = this.winner;
      return false;
    }
    this.held = (this.held + 1) | 0;
    return this.held >= MATCH_END_HOLD_FRAMES;
  }

  /** Re-arm. A scene calls this from `enter`, so one watch serves every match
   *  that scene runs. */
  reset(): void {
    this.held = -1;
    this.winner = -1;
  }
}

// -----------------------------------------------------------------------------
// The match
// -----------------------------------------------------------------------------

export interface Match {
  /** The NORMALIZED config. Always the one the sim is running. */
  readonly cfg: MatchConfig;
  readonly state: SimState;
  /** The frame the renderer last drew. `advance` refreshes it before stepping. */
  readonly prev: StateBuf;
  /** Prime the snapshot and install skins. Synchronous; never throws. */
  prime(): void;
  /** One sim frame: snapshot, poll, step. Named `advance`, not `tick`, so it
   *  is never confused with `Scene.tick`, which returns a transition. */
  advance(sources: readonly [InputSource, InputSource], frame: number): void;
  /** Stops in-flight skin loads from touching a renderer that has moved on. */
  dispose(): void;
}

class MatchRun implements Match {
  readonly cfg: MatchConfig;
  readonly state: SimState;
  readonly prev: StateBuf = allocStateBuffer();

  private readonly deps: GameDeps;
  /** Player 2's stand-in when the config says so. Null = a human on sources[1]. */
  private readonly p2: InputSource | null;
  /**
   * The same object as `p2` when the stand-in is the SCRIPTED dummy, null when
   * it is the CPU. Only the scripted one reasons in relative directions and has
   * to be told which way it is pointing; the CPU reads facing out of the state
   * it was handed, which is why it needs no such back-channel.
   */
  private readonly scripted: DummySource | null;
  private dead = false;

  constructor(deps: GameDeps, cfg: MatchConfig) {
    this.deps = deps;
    this.cfg = normalizeMatchConfig(cfg);
    this.state = createState(
      this.cfg.seed, this.cfg.chars[0], this.cfg.chars[1], this.cfg.stage, deps.registry,
    );

    if (!this.cfg.p2IsDummy) {
      this.p2 = null;
      this.scripted = null;
    } else if (this.cfg.dummy.mode === DummyMode.CPU_BASIC) {
      // THE 1P OPPONENT. An InputSource like any other: it is handed the live
      // state to READ and returns a mask, so nothing about the sim changes —
      // and it is seeded off the config, so the same seed against the same
      // player-1 inputs replays the same fight, frame for frame.
      this.p2 = createCpuSource(this.state, {
        charId: this.cfg.chars[1], player: 1, seed: this.cfg.seed,
        // The config's one dial, spent here: `aggression` is what a MatchConfig
        // has to say about difficulty, `level` is what cpu.ts calls it.
        level: this.cfg.dummy.aggression,
      });
      this.scripted = null;
    } else {
      const d = new DummySource(this.cfg.dummy, -1);
      this.p2 = d;
      this.scripted = d;
    }
  }

  prime(): void {
    // The renderer interpolates from `prev`; without this the first frame
    // interpolates from a zeroed buffer, which reads as a one-frame warp.
    snapshot(this.prev, this.state.buf);
    for (let p = 0 as PlayerIx; p <= 1; p = (p + 1) as PlayerIx) this.installSkin(p);
  }

  advance(sources: readonly [InputSource, InputSource], frame: number): void {
    // Snapshot BEFORE stepping: the renderer interpolates between the frame it
    // last drew and the one about to run.
    snapshot(this.prev, this.state.buf);
    const in0 = sources[0].poll(frame);
    // Player 2's pad is polled EVEN WHEN THE CPU IS PLAYING, and its mask
    // dropped. `StickyLatch` banks a tap that began and ended between two ticks,
    // so a pad nobody drains hands that stale press to whatever screen reads it
    // next — a phantom input on the frame a 1P match hands the pad back.
    let in1 = sources[1].poll(frame);
    if (this.p2 !== null) {
      // Relative directions only: see the field comment on `scripted`.
      this.scripted?.setFacing(this.state.fighter(1).facing);
      in1 = this.p2.poll(frame);
    }
    step(this.state, in0, in1);
  }

  dispose(): void {
    this.dead = true;
    // The stand-in belongs to THIS match. The loop's two real sources do not,
    // and are never touched here.
    this.p2?.dispose();
  }

  /** Step 1 synchronously, step 2 in the background. See the header. */
  private installSkin(p: PlayerIx): void {
    const { gl, renderer, registry } = this.deps;
    const charId = this.cfg.chars[p];

    // 1. A drawable skin, right now, with no I/O behind it.
    renderer.setSkin(p, createStickSkin(charById(registry, charId), STICK_LOOK));

    // 2. The real art, if this config wants it and the sheet exists.
    if (this.cfg.skins[p] !== 'sprite') return;
    void loadSpriteSkin(gl, charId)
      .then((sprite) => {
        if (sprite === null) return;      // no sheet: the stick skin stays. Fine.
        if (this.dead) {
          sprite.dispose();               // we are not this match's renderer any more
          return;
        }
        renderer.setSkin(p, sprite);      // setSkin disposes the skin it replaces
      })
      .catch(() => {
        /* A broken sheet is not a broken game: the stick skin is already up. */
      });
  }
}

export const createMatch = (deps: GameDeps, cfg: MatchConfig): Match => new MatchRun(deps, cfg);

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
// =============================================================================

import { ROUND_TIME, ROUNDS_TO_WIN } from '@/core/contracts';
import type {
  DefRegistry, InputSource, MatchConfig, PlayerIx, Renderer, SimState, StateBuf,
} from '@/core/contracts';
import { allocStateBuffer, createState, snapshot } from '@/sim/state';
import { step } from '@/sim/step';
import {
  DEFAULT_CHAR, DEFAULT_STAGE, SELECTABLE_CHARS, charById, coerceChar, coerceStage,
} from '@/data/registry';
import { createStickSkin } from '@/gfx/skin/stick';
import { loadSpriteSkin } from '@/gfx/skin/sprite';
import { DUMMY_STAND, DummySource } from '@/input/dummy';

/** Everything a scene or a match needs from the outside world. */
export interface GameDeps {
  readonly gl: WebGL2RenderingContext;
  readonly renderer: Renderer;
  readonly registry: DefRegistry;
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
  private readonly dummy: DummySource | null;
  private dead = false;

  constructor(deps: GameDeps, cfg: MatchConfig) {
    this.deps = deps;
    this.cfg = normalizeMatchConfig(cfg);
    this.state = createState(
      this.cfg.seed, this.cfg.chars[0], this.cfg.chars[1], this.cfg.stage, deps.registry,
    );
    this.dummy = this.cfg.p2IsDummy ? new DummySource(this.cfg.dummy, -1) : null;
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
    let in1: number;
    if (this.dummy !== null) {
      // The dummy reasons in RELATIVE directions, so it has to be told which
      // way it is pointing before it converts them to absolute ones.
      this.dummy.setFacing(this.state.fighter(1).facing);
      in1 = this.dummy.poll(frame);
    } else {
      in1 = sources[1].poll(frame);
    }
    step(this.state, in0, in1);
  }

  dispose(): void {
    this.dead = true;
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

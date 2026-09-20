// =============================================================================
// SunForce — src/game/scenes.ts
// THE THREE SCENES AND THE '[' KEY. Fight, Mode and Select live in one module
// on purpose: each creates the others, and a module cannot import itself in a
// cycle.
//
// THE FLOW
//
//   boot ─────────────────────────────────▶ FightScene   (default match, 2P)
//   '[' ──▶ ModeScene (1P / 2P) ──▶ SelectScene ──▶ FightScene
//   match over ───────────────────────────▶ SelectScene  (mode retained)
//
//   GUARD with nothing locked, or '[' again, backs out of either menu to the
//   fight it came from, unchanged. There is no menu on startup and no title
//   screen: `createBootScene` is a fight, and nothing but '[' reaches a menu.
//
// THE MODE IS REMEMBERED, AND IT IS NOT A VARIABLE
//   Every scene carries the `MatchConfig` it is about, and `p2IsDummy` inside
//   that config IS the mode (match.ts, `modeOf`). Finishing a 1P match and
//   landing back on the character select is therefore still 1P for free, with
//   no module-level "current mode" for two scenes to disagree about.
//
// '[' IS A SYSTEM KEY, NOT A GAMEPLAY BUTTON
//   It is deliberately NOT a bit in `B` and not in the keymap: the sim hashes
//   input masks, so adding a bit for a menu key would change every replay and
//   every determinism test. It is handled exactly the way gfx/debugdraw.ts
//   handles F1 — one module-level keydown listener setting a latch, which a
//   scene consumes on its next tick. Consuming CLEARS it, so one press can
//   only ever cause one transition even if two scenes read it in the same
//   frame.
//
// WHO OWNS THE TRANSITION: core/loop.ts. A scene returns the next scene from
// `tick`; the loop calls exit(), swaps, then enter(). Nothing here calls any of
// those on anything but itself.
//
// TWO PRESENTATION HOLDS LIVE HERE AND NEITHER IS IN THE SIM: the "3, 2, 1, GO"
// countdown (FightScene — sim/state.ts opens a round in `RoundState.FIGHT` on
// purpose, so the headless tests still land hits on frame one) and the wait on a
// finished match, which is a RACE against a latch with a lifetime — see
// `MatchEndWatch` in match.ts, where that one is explained and won.
//
// 1P: THE HUMAN IS PLAYER 1 AND PICKS ONE SIDE. `createSelectScene` runs the
// config through `configForMode`, which draws player 2's character from the
// seed; SelectScene then drives ui/select.ts with a SYNTHETIC player-2 mask —
// one PUNCH edge, then neutral forever — locking the second cursor onto that
// draw. No new method on `SelectController`, and the real second pad is drained
// and ignored.
// =============================================================================

import { B, LOGICAL_H, LOGICAL_W } from '@/core/contracts';
import type {
  ButtonMask, InputSource, InstanceWriter, MatchConfig, Renderer, Scene,
} from '@/core/contracts';
import { QuadBatch, orthoMat3 } from '@/gfx/batch';
import { createSelect } from '@/ui/select';
import type { SelectController } from '@/ui/select';
import { createModeSelect } from '@/ui/mode';
import type { ModeController } from '@/ui/mode';
import {
  DEFAULT_INTRO_TIMING, INTRO_SYNC_WAIT_FRAMES, drawIntro, introTimingFor,
} from '@/ui/intro';
import type { IntroTiming } from '@/ui/intro';
import { themeForOpponent } from '@/data/troupes';
import {
  DEFAULT_MATCH, MatchEndWatch, ONE_PLAYER, TWO_PLAYER,
  configForMode, createMatch, modeOf,
} from '@/game/match';
import type { GameDeps, Match, PlayMode } from '@/game/match';

export type { GameDeps, Match, PlayMode } from '@/game/match';

// -----------------------------------------------------------------------------
// The '[' latch
// -----------------------------------------------------------------------------

let requested = false;
let detachFn: (() => void) | null = null;

/** Open the select screen without a keyboard — a menu button, the console. */
export const requestSelect = (): void => {
  requested = true;
};

/** True at most ONCE per press: reading it clears the latch. */
export const consumeSelectRequest = (): boolean => {
  if (!requested) return false;
  requested = false;
  return true;
};

/** Is a press pending? For a test or an overlay. Does NOT clear the latch. */
export const selectRequested = (): boolean => requested;

/** Listen for '['. Returns the detach function; calling it twice is safe, and a
 *  second attach while one is live returns the existing detach rather than
 *  stacking a second listener. `code` is the physical key the user pressed;
 *  `key` also catches layouts where that character sits elsewhere. */
export const attachSelectHotkey = (
  target: EventTarget | null = typeof window === 'undefined' ? null : window,
): (() => void) => {
  if (target === null) return () => undefined;
  if (detachFn !== null) return detachFn;

  const handler = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.repeat) return;
    if (e.code !== 'BracketLeft' && e.key !== '[') return;
    e.preventDefault();
    requested = true;
  };

  target.addEventListener('keydown', handler);
  const off = (): void => {
    target.removeEventListener('keydown', handler);
    if (detachFn === off) detachFn = null;
    requested = false;
  };
  detachFn = off;
  return off;
};

/** Symmetric form, for a caller that did not keep the returned function. */
export const detachSelectHotkey = (): void => {
  detachFn?.();
};

// -----------------------------------------------------------------------------
// THE OVERLAY HOOK. The intro paints over the FINISHED frame, HUD included, and
// `Renderer` (core/contracts.ts, frozen) knows nothing of batches or orthos. So
// `FightRenderer` grew ONE additive method, `drawOverlay`; this is the narrow
// structural bridge to it, the trick gfx/renderer.ts uses for skin materials.
// -----------------------------------------------------------------------------

interface OverlayHost {
  drawOverlay(emit: (out: InstanceWriter) => void): void;
}

/** The renderer's overlay hook, or null for one that has none. */
const overlayHostOf = (r: Renderer): OverlayHost | null => {
  const maybe = r as unknown as Partial<OverlayHost>;
  return typeof maybe.drawOverlay === 'function' ? (maybe as OverlayHost) : null;
};

// -----------------------------------------------------------------------------
// FightScene. THE INTRO IS A HOLD, NOT A GATE: for `INTRO_TOTAL_FRAMES` ticks
// `tick` does all it normally does EXCEPT `match.advance(...)`, so the fighters
// stand still and the round clock — which only moves inside `step` — has not
// started. No flag reaches SimState and no hash moves, so the 45 headless tests
// cannot see any of it. The counter is a FIELD OF THE SCENE and every way back
// into a fight builds a new one, so the countdown replays for free on the way
// out of either menu.
// -----------------------------------------------------------------------------

let live: Match | null = null;

/** The match on screen, or null in a menu. Debug/HUD handle only. */
export const activeMatch = (): Match | null => live;

class FightScene implements Scene {
  private match: Match | null = null;

  /** Sim ticks the intro has been on screen. `enter()` puts it back to 0. */
  private introFrame = 0;
  /** The tick the fight begins on: the timing's own length, or 0 for a renderer
   *  that cannot draw the overlay — a countdown nobody can see is not a
   *  countdown, it is three and a half seconds of a dead stage. */
  private introEnd = 0;
  /** This match's timeline, from the troupe track's downbeat. */
  private introTiming: IntroTiming = DEFAULT_INTRO_TIMING;
  /** Frames spent on frame 0 waiting for the track to start. See `atDownbeat`. */
  private syncWait = 0;
  private overlay: OverlayHost | null = null;

  /** The match-over latch. It, and not `g.matchOver`, is what the transition
   *  below reads once the flag has been seen: see the header. */
  private readonly endWatch = new MatchEndWatch();

  constructor(
    private readonly deps: GameDeps,
    private readonly cfg: MatchConfig,
    private readonly mode: PlayMode,
  ) {}

  /** Bound once per scene rather than per drawn frame: `draw` runs 60 times a
   *  second and the loop is deliberately allocation-free. */
  private readonly emitIntro = (out: InstanceWriter): void => {
    drawIntro(out, this.introFrame, this.introTiming);
  };

  /**
   * Hold frame 0 until the track is actually sounding, so that a countdown
   * timed to land six seconds in agrees with the recording about where zero is.
   *
   * It waits ONLY when there is a downbeat coming. `settled` is false while the
   * AudioContext is still suspended — the browser keeps it that way until a
   * real keypress, and the game boots straight into a fight — so on the very
   * first match this returns false immediately rather than holding a black
   * screen for music that cannot start yet. The cap covers the rest: a missing
   * file, a muted build, an unlock that never comes.
   */
  private atDownbeat(): boolean {
    const music = this.deps.music;
    if (music === undefined) return true;
    if (this.syncWait >= INTRO_SYNC_WAIT_FRAMES) return true;
    if (!music.settled || music.rolling) return true;
    this.syncWait++;
    return false;
  }

  enter(): void {
    // The press that brought us here must not immediately bounce us out.
    consumeSelectRequest();
    const m = createMatch(this.deps, this.cfg);
    m.prime();
    this.match = m;
    live = m;

    // WHICH TRACK, AND WHEN GO LANDS ON IT. Both come from the troupe player
    // two belongs to (data/troupes.ts), not from the backdrop — three troupes
    // share one stage today. A troupe with no track of its own falls back to
    // whatever the StageDef declares, and to the default 3.5 s countdown.
    const theme = themeForOpponent(this.deps.registry, m.cfg.chars[1]);
    // The theme comes up UNDER the 750 ms fade, so the music is already running
    // by the time the first numeral lands.
    this.deps.music?.stageTheme(this.deps.registry.stages[m.cfg.stage]!, theme?.musicId);

    this.overlay = overlayHostOf(this.deps.renderer);
    this.introFrame = 0;
    this.syncWait = 0;
    this.introTiming =
      theme === null ? DEFAULT_INTRO_TIMING : introTimingFor(theme.goAtMs);
    this.introEnd = this.overlay === null ? 0 : this.introTiming.totalFrames;
    this.endWatch.reset();
  }

  tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null {
    const m = this.match;
    if (m === null) return null;
    // Checked BEFORE stepping, so the frame '[' is pressed is not also
    // simulated — and checked before the intro hold, so '[' works during it.
    // It opens the MODE screen now: how many people are playing is the question
    // that has to be answered before "as who".
    if (consumeSelectRequest()) return createModeScene(this.deps, m.cfg, this.mode);

    if (this.introFrame < this.introEnd) {
      // Frame 0 is held until the track is sounding; every frame after it is
      // counted off the track's own clock.
      if (this.introFrame > 0 || this.atDownbeat()) this.introFrame++;
      // Polled and thrown away. `StickyLatch` (input/buffer.ts) banks a tap that
      // began and ended between two ticks, so NOT polling would spend every
      // mashed button of the countdown on the first frame of the fight. Only
      // stale taps are discarded: held keys still report live out of "GO".
      sources[0].poll(frame);
      sources[1].poll(frame);
      return null;
    }

    // The best-of-3 is already won or lost inside the sim: `step` credits the
    // round on the first frame of the KO and `g.p0Wins` / `g.p1Wins` ARE the
    // marked points. All that was missing is somebody to notice and go back to
    // the select — with `m.cfg` and not a fresh config, because `p2IsDummy`
    // carries the mode with it and 1P draws its next opponent on arrival.
    // Stepping CONTINUES through the hold, so the KO slow-motion, the winning
    // pose and the HUD all play out; we just leave before the sim's own
    // MATCH_END expires into a rematch nobody asked for.
    m.advance(sources, frame);
    if (!this.endWatch.over(m.state)) return null;
    return createSelectScene(this.deps, m.cfg, this.mode);
  }

  draw(alpha: number, dtMs: number): void {
    const m = this.match;
    if (m === null) return;
    this.deps.renderer.draw(m.state, m.prev, alpha, dtMs);
    // On top of the whole frame, the HUD included — which is why it goes after
    // `renderer.draw` and not inside it.
    if (this.introFrame < this.introEnd) this.overlay?.drawOverlay(this.emitIntro);
  }

  exit(): void {
    if (live === this.match) live = null;
    this.match?.dispose();
    this.match = null;
    this.overlay = null;
  }
}

// -----------------------------------------------------------------------------
// MenuScene — what the two menus have in common, which is everything but
// meaning: a batch, the HUD's screen-space ortho, one screen object out of
// src/ui/, last frame's masks so that screen can find its own edges, and two
// ways out — '[' again, and GUARD as BACK. Only what the buttons MEAN differs,
// so `tick` is all a subclass has to write.
//
// THE FIRST TICK IS ALWAYS A PRIME: it adopts the held masks as history and does
// nothing else. Without it a button still down from the fight reads as a fresh
// press — walking into a menu holding GUARD would cancel it on arrival.
// -----------------------------------------------------------------------------

abstract class MenuScene implements Scene {
  private batch: QuadBatch | null = null;
  private readonly view = new Float32Array(9);

  /** Last frame's held masks. The ui/ screens detect edges from these. */
  protected prev0: ButtonMask = 0;
  protected prev1: ButtonMask = 0;
  private primed = false;
  protected frame = 0;

  constructor(
    protected readonly deps: GameDeps,
    protected readonly cfg: MatchConfig,
    protected readonly mode: PlayMode,
  ) {}

  /** Build the screen this menu drives, and drop it again. */
  protected abstract open(): void;
  protected abstract shut(): void;
  /** Paint it. The ortho and the material are bound; the flush comes after. */
  protected abstract paintInto(out: QuadBatch): void;

  abstract tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null;

  enter(): void {
    consumeSelectRequest();
    // Both menus ask for the same track and `SceneMusic` is idempotent by id,
    // so walking Mode -> Select does not restart the theme.
    this.deps.music?.selectTheme();
    this.batch = new QuadBatch(this.deps.gl);
    this.primed = false;
    this.prev0 = 0;
    this.prev1 = 0;
    this.open();
  }

  draw(_alpha: number, _dtMs: number): void {
    const batch = this.batch;
    if (batch === null) return;
    const gl = this.deps.gl;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // The HUD's convention: a fixed 1920x1080 virtual screen, y UP, whatever
    // the window is. Set it, draw, and leave the batch empty behind us.
    batch.beginFrame();
    orthoMat3(this.view, 0, LOGICAL_W, 0, LOGICAL_H);
    batch.setViewProj(this.view);
    batch.use(batch.solidMaterial);
    this.paintInto(batch);
    batch.flush();
  }

  exit(): void {
    this.batch?.dispose();
    this.batch = null;
    this.shut();
  }

  /** True on the tick that adopts the opening masks. See the header. */
  protected prime(in0: ButtonMask, in1: ButtonMask): boolean {
    if (this.primed) return false;
    this.primed = true;
    this.prev0 = in0;
    this.prev1 = in1;
    return true;
  }

  /** Back to the fight we came from, unchanged and in the same mode. */
  protected cancel(): Scene {
    return createFightScene(this.deps, this.cfg, this.mode);
  }
}

// -----------------------------------------------------------------------------
// SelectScene. Drives ui/select.ts, which owns the model, the cursors and every
// pixel. In 1P it owns one thing that file does not: player 2's answer. See
// `soloMask` — the second cursor locks onto the opponent the config was opened
// with and never moves again, which is "the human picks one side only" said in
// the interface `SelectController` already has, not a new flag inside it.
// -----------------------------------------------------------------------------

class SelectScene extends MenuScene {
  private screen: SelectController | null = null;
  /** 1P: has the synthetic PUNCH that locks player 2 been spent yet? */
  private soloLocked = false;

  protected override open(): void {
    // `cfg` arrived through `configForMode`, so in 1P player 2's slot already
    // holds the drawn opponent and this puts the second cursor straight on it.
    this.screen = createSelect(this.deps.registry, this.cfg);
    this.soloLocked = false;
  }

  protected override shut(): void {
    this.screen = null;
  }

  protected override paintInto(out: QuadBatch): void {
    this.screen?.draw(out, this.frame);
  }

  override tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null {
    const s = this.screen;
    if (s === null) return this.cancel();
    this.frame = frame;
    const solo = this.mode === ONE_PLAYER;

    const in0 = sources[0].poll(frame);
    // Polled in 1P as well, and dropped: an undrained pad banks its stale taps.
    const pad1 = sources[1].poll(frame);
    // Player 2's history starts EMPTY in 1P, so the synthetic press lands as a
    // genuine edge next tick.
    if (this.prime(in0, solo ? 0 : pad1)) return null;

    if (consumeSelectRequest()) return this.cancel();   // '[' again = back out.

    const in1 = solo ? this.soloMask() : pad1;

    // GUARD un-locks inside the screen, so it is a CANCEL only when there is
    // nothing to unlock — judged BEFORE update(), or the press that unlocked a
    // player would read as "nothing locked" and drop the match. In 1P only
    // player 1 counts: their opponent is locked for good, and counting that
    // lock would stop GUARD backing out at all.
    const before = s.model;
    const guard = ((in0 & ~this.prev0) | (solo ? 0 : in1 & ~this.prev1)) & B.G;
    const held = solo ? before.locked[0] : before.locked[0] || before.locked[1];
    if (guard !== 0 && !held) return this.cancel();

    s.update(in0, in1, this.prev0, this.prev1);
    this.prev0 = in0;
    this.prev1 = in1;

    // Both locked in: the new characters take effect immediately. `result`
    // spreads the config it is handed, so the mode, the seed and the CPU's
    // options all survive into the fight.
    const picked = s.result(this.cfg);
    return picked === null ? null : createFightScene(this.deps, picked, this.mode);
  }

  /** Player 2's mask in a 1P match: ONE punch, on the first live tick, neutral
   *  for the rest of the screen's life. That edge locks the second cursor where
   *  `createSelect` put it — the character `configForMode` drew — and neutral
   *  after it means the cursor can never move off it and never unlock, because
   *  ui/select.ts only ever acts on edges. */
  private soloMask(): ButtonMask {
    if (this.soloLocked) return 0;
    this.soloLocked = true;
    return B.P;
  }
}

// -----------------------------------------------------------------------------
// ModeScene. "How many of you are there?" — the first question, and the only
// one '[' now answers directly. BOTH PADS ANSWER IT: someone about to play alone
// may well be sitting at the player-2 keys, and a second person deciding to join
// in is the whole reason this screen exists, so the mode comes from the screen
// and never from which pad pressed the button.
// -----------------------------------------------------------------------------

class ModeScene extends MenuScene {
  private screen: ModeController | null = null;

  protected override open(): void {
    // Opens on the mode we are in, so '[' out of a 1P fight highlights 1P.
    this.screen = createModeSelect(this.mode);
  }

  protected override shut(): void {
    this.screen = null;
  }

  protected override paintInto(out: QuadBatch): void {
    this.screen?.draw(out, this.frame);
  }

  override tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null {
    const s = this.screen;
    if (s === null) return this.cancel();
    this.frame = frame;

    const in0 = sources[0].poll(frame);
    const in1 = sources[1].poll(frame);
    if (this.prime(in0, in1)) return null;

    if (consumeSelectRequest()) return this.cancel();   // '[' again = back out.

    // GUARD is BACK here and nothing else: a mode screen has nothing locked, so
    // the select screen's "only when nothing is locked" test has no counterpart.
    // Checked before update(), so ui/mode.ts never has to know what it means.
    if ((((in0 & ~this.prev0) | (in1 & ~this.prev1)) & B.G) !== 0) return this.cancel();

    s.update(in0, in1, this.prev0, this.prev1);
    this.prev0 = in0;
    this.prev1 = in1;

    // `chosen` LATCHES over in ui/mode.ts — non-null and staying there, not a
    // poll-and-clear — so reading it a tick late still gets the answer. A fresh
    // controller per `enter()` means a second trip never opens pre-chosen.
    const chosen = s.chosen;
    if (chosen === null) return null;
    return createSelectScene(this.deps, this.cfg, chosen === 1 ? ONE_PLAYER : TWO_PLAYER);
  }
}

// -----------------------------------------------------------------------------
// Factories. `mode` defaults to the one the config is already in (`modeOf`), so
// every existing two-argument call site keeps working and a config handed round
// the scenes never loses track of who is playing.
// -----------------------------------------------------------------------------

export const createFightScene = (
  deps: GameDeps, cfg: MatchConfig, mode: PlayMode = modeOf(cfg),
): Scene => new FightScene(deps, cfg, mode);

/** THE CHARACTER SELECT. `configForMode` runs first, and it is the only place
 *  the 1P opponent is drawn: opening this screen picks player 2 afresh from the
 *  seed, which is why a finished match comes back to a new opponent and why
 *  cancelling out to the fight does not change one. */
export const createSelectScene = (
  deps: GameDeps, cfg: MatchConfig, mode: PlayMode = modeOf(cfg),
): Scene => new SelectScene(deps, configForMode(cfg, mode), mode);

/** 1 player or 2. Where '[' goes, and the only way into the select screen. */
export const createModeScene = (
  deps: GameDeps, cfg: MatchConfig, mode: PlayMode = modeOf(cfg),
): Scene => new ModeScene(deps, cfg, mode);

/** What main.ts boots: a fight, straight away, no menu. */
export const createBootScene = (deps: GameDeps, cfg: MatchConfig = DEFAULT_MATCH): Scene =>
  createFightScene(deps, cfg);

export { ONE_PLAYER, TWO_PLAYER, modeOf } from '@/game/match';

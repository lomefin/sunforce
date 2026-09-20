// =============================================================================
// SunForce — src/game/scenes.ts
// THE TWO SCENES AND THE '[' KEY. Fight and Select live in one module on
// purpose: each creates the other, and a module cannot import itself in a
// cycle.
//
// THE GAME BOOTS INTO A FIGHT. There is no menu on startup and no title
// screen; `createBootScene` is a fight and nothing else reaches Select except
// the '[' key.
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
// THE ROUND INTRO LIVES HERE, NOT IN THE SIM
//   "3, 2, 1, GO" is presentation. src/sim/state.ts opens a round in
//   `RoundState.FIGHT` on purpose, and the headless tests call `createState`
//   then `step` and expect hits to land immediately — an INTRO state in the sim
//   would silently break every one of them. So the FIGHT SCENE holds instead:
//   for the first `INTRO_TOTAL_FRAMES` ticks it does not call `match.advance`,
//   and src/ui/intro.ts draws the countdown over the frame. The fighters stand
//   still because the sim is not advancing. No gating, no new sim state, no
//   hash change.
// =============================================================================

import { B, LOGICAL_H, LOGICAL_W } from '@/core/contracts';
import type {
  ButtonMask, InputSource, InstanceWriter, MatchConfig, Renderer, Scene,
} from '@/core/contracts';
import { QuadBatch, orthoMat3 } from '@/gfx/batch';
import { createSelect } from '@/ui/select';
import type { SelectController } from '@/ui/select';
import { INTRO_TOTAL_FRAMES, drawIntro } from '@/ui/intro';
import { DEFAULT_MATCH, createMatch } from '@/game/match';
import type { GameDeps, Match } from '@/game/match';

export type { GameDeps, Match } from '@/game/match';

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

/**
 * Listen for '['. Returns the detach function; calling it twice is safe, and a
 * second attach while one is live returns the existing detach rather than
 * stacking a second listener.
 *
 * `code === 'BracketLeft'` is the physical key, which is what the user pressed;
 * `key === '['` also catches layouts where that character sits elsewhere.
 */
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
// THE OVERLAY HOOK
//
// The round intro paints over the FINISHED frame, HUD included, which needs the
// renderer's batch and its screen-space ortho. `Renderer` in core/contracts.ts
// knows about neither and must not learn: that file is frozen and the headless
// harness imports it. So `FightRenderer` grew ONE additive method, `drawOverlay`,
// and this is the narrow structural bridge to it — exactly the trick
// gfx/renderer.ts uses to reach a skin's `material` without widening
// `CharacterSkin`.
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
// FightScene
//
// THE INTRO IS A HOLD, NOT A GATE. For `INTRO_TOTAL_FRAMES` sim ticks after
// `enter()`, `tick` does everything it normally does EXCEPT call
// `match.advance(...)`. The fighters stand still because nothing is stepping
// them; the round clock has not started because `roundTimer` only moves inside
// `step`. No flag reaches SimState, no hash moves, and the 45 headless tests —
// which call `createState` and `step` directly and never touch a Scene — cannot
// see any of it.
//
// Because the counter is a FIELD OF THE SCENE and every route back into a fight
// builds a new scene (see `SelectScene.cancel` and `createFightScene`), coming
// back from the select screen replays the countdown for free: new match, new
// intro.
// -----------------------------------------------------------------------------

let live: Match | null = null;

/** The match on screen, or null in the select screen. Debug/HUD handle only. */
export const activeMatch = (): Match | null => live;

class FightScene implements Scene {
  private match: Match | null = null;

  /** Sim ticks the intro has been on screen. `enter()` puts it back to 0. */
  private introFrame = 0;
  /**
   * The tick the fight begins on: `INTRO_TOTAL_FRAMES`, or 0 for a renderer
   * that cannot draw the overlay. A countdown nobody can see is not a countdown,
   * it is three and a half seconds of a dead stage — so a renderer without the
   * hook gets no intro at all rather than a silent freeze.
   */
  private introEnd = 0;
  private overlay: OverlayHost | null = null;

  constructor(private readonly deps: GameDeps, private readonly cfg: MatchConfig) {}

  /** Bound once per scene rather than per drawn frame: `draw` runs 60 times a
   *  second and the loop is deliberately allocation-free. */
  private readonly emitIntro = (out: InstanceWriter): void => {
    drawIntro(out, this.introFrame);
  };

  enter(): void {
    // The press that brought us here must not immediately bounce us out.
    consumeSelectRequest();
    const m = createMatch(this.deps, this.cfg);
    m.prime();
    this.match = m;
    live = m;

    // The stage theme comes up UNDER the 750 ms fade, so the music is already
    // running by the time the first numeral lands.
    this.deps.music?.stageTheme(this.deps.registry.stages[m.cfg.stage]!);

    this.overlay = overlayHostOf(this.deps.renderer);
    this.introFrame = 0;
    this.introEnd = this.overlay === null ? 0 : INTRO_TOTAL_FRAMES;
  }

  tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null {
    const m = this.match;
    if (m === null) return null;
    // Checked BEFORE stepping, so the frame '[' is pressed is not also
    // simulated — and checked before the intro hold, so '[' works during it.
    if (consumeSelectRequest()) return createSelectScene(this.deps, m.cfg);

    if (this.introFrame < this.introEnd) {
      this.introFrame++;
      // Polled and thrown away. `StickyLatch` (input/buffer.ts) remembers a tap
      // that began and ended between two ticks, so NOT polling would bank every
      // mashed button of the countdown and spend it all on the first frame of
      // the fight. Draining discards only those stale taps: a latch reports
      // HELD keys live, so walking forward out of "GO" still works.
      sources[0].poll(frame);
      sources[1].poll(frame);
      return null;
    }

    m.advance(sources, frame);
    return null;
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
// SelectScene
//
// Drives ui/select.ts, which owns the model, the cursors and every pixel. This
// scene owns three things that file deliberately does not: the GL batch, the
// screen-space ortho, and the two ways out.
// -----------------------------------------------------------------------------

class SelectScene implements Scene {
  private batch: QuadBatch | null = null;
  private screen: SelectController | null = null;
  private readonly view = new Float32Array(9);

  /** Last frame's held masks. ui/select.ts detects edges from these. */
  private prev0: ButtonMask = 0;
  private prev1: ButtonMask = 0;
  /** Skips edge handling on the first tick — see `tick`. */
  private primed = false;
  private frame = 0;

  constructor(private readonly deps: GameDeps, private readonly cfg: MatchConfig) {}

  enter(): void {
    consumeSelectRequest();
    this.deps.music?.selectTheme();
    this.screen = createSelect(this.deps.registry, this.cfg);
    this.batch = new QuadBatch(this.deps.gl);
    this.primed = false;
    this.prev0 = 0;
    this.prev1 = 0;
  }

  tick(sources: readonly [InputSource, InputSource], frame: number): Scene | null {
    const s = this.screen;
    if (s === null) return this.cancel();
    this.frame = frame;

    const in0 = sources[0].poll(frame);
    const in1 = sources[1].poll(frame);

    // FIRST TICK: adopt the held mask as history and do nothing else. Without
    // this, a button already down when the screen opened reads as a fresh
    // press — walking into the select holding GUARD would cancel it instantly.
    if (!this.primed) {
      this.primed = true;
      this.prev0 = in0;
      this.prev1 = in1;
      return null;
    }

    if (consumeSelectRequest()) return this.cancel();   // '[' again = back out.

    // GUARD is un-lock inside the screen, so it is only a CANCEL when there is
    // nothing to unlock. Judged on the state BEFORE update(), or the very press
    // that unlocked a player would read as "nothing locked" and drop the match.
    const before = s.model;
    const guard = ((in0 & ~this.prev0) | (in1 & ~this.prev1)) & B.G;
    if (guard !== 0 && !before.locked[0] && !before.locked[1]) return this.cancel();

    s.update(in0, in1, this.prev0, this.prev1);
    this.prev0 = in0;
    this.prev1 = in1;

    // Both locked in: the new characters take effect immediately.
    const picked = s.result(this.cfg);
    return picked === null ? null : createFightScene(this.deps, picked);
  }

  draw(_alpha: number, _dtMs: number): void {
    const gl = this.deps.gl;
    const batch = this.batch;
    const s = this.screen;
    if (batch === null || s === null) return;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // The HUD's convention: a fixed 1920x1080 virtual screen, y UP, whatever
    // the window is. Set it, draw, and leave the batch empty behind us.
    batch.beginFrame();
    orthoMat3(this.view, 0, LOGICAL_W, 0, LOGICAL_H);
    batch.setViewProj(this.view);
    batch.use(batch.solidMaterial);
    s.draw(batch, this.frame);
    batch.flush();
  }

  exit(): void {
    this.batch?.dispose();
    this.batch = null;
    this.screen = null;
  }

  /** Back to the fight we came from, unchanged. */
  private cancel(): Scene {
    return createFightScene(this.deps, this.cfg);
  }
}

// -----------------------------------------------------------------------------
// Factories
// -----------------------------------------------------------------------------

export const createFightScene = (deps: GameDeps, cfg: MatchConfig): Scene =>
  new FightScene(deps, cfg);

export const createSelectScene = (deps: GameDeps, cfg: MatchConfig): Scene =>
  new SelectScene(deps, cfg);

/** What main.ts boots: a fight, straight away, no menu. */
export const createBootScene = (deps: GameDeps, cfg: MatchConfig = DEFAULT_MATCH): Scene =>
  createFightScene(deps, cfg);

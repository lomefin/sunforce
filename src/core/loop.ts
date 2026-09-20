// =============================================================================
// SunForce — src/core/loop.ts
// THE CLOCK. A fixed 60 Hz accumulator with BOTH guards, and the only place in
// the codebase that is allowed to ask what time it is.
//
// THE TWO GUARDS, AND WHY THE SECOND ONE THROWS THE DEBT AWAY
//   MAX_DELTA_MS = 250 clamps the frame delta. An alt-tab, a breakpoint or a
//   laptop lid produces a multi-second delta; without the clamp the accumulator
//   would ask for hundreds of sim steps at once.
//   MAX_STEPS_PER_FRAME = 5 caps the steps actually run in one rAF, and then the
//   accumulator is DISCARDED, not banked. Banking is the classic spiral: the
//   machine is already too slow to run 5 steps, so carrying the remainder
//   guarantees 5 more next frame, forever. The game runs slow for one hitch and
//   recovers. This is the single most important line in the file.
//
// TIME SCALING MULTIPLIES THE ACCUMULATOR, NEVER THE STEP THRESHOLD
//   `acc += dt * timeScalePct / 100`. Scaling SIM_DT_MS instead inverts the
//   sense of the number — the KO slow-motion at 30% would run the match at 3.3x
//   speed — and it also changes what one sim frame means, which the sim is
//   entitled to assume never happens.
//
// M0 RENDERS WITH alpha = 0
//   Interpolation is deferred (M0 doc, "deliberately deferred"). `ALPHA_SNAP`
//   is passed to `draw` unconditionally and `accMs` is published in LoopStats,
//   so turning interpolation on later is `alpha = acc / SIM_DT_MS` gated on the
//   refresh rate, hitstop and `teleportEpoch` (ENGINE-DECISIONS §2) — no
//   restructuring.
//
// THE SIM ITSELF IS NOT HERE. This file drives `Scene.tick`; what a scene does
// with the two `InputSource`s and the frame number is the scene's business.
// =============================================================================

import { MAX_DELTA_MS, MAX_STEPS_PER_FRAME, SIM_DT_MS } from '@/core/contracts';
import type { InputSource, LoopStats, Scene, StartLoopFn } from '@/core/contracts';
import { keyboardPair } from '@/input/sources';
import type { KeyboardDevice } from '@/input/sources';

/** M0: the renderer snaps. See the header. */
export const ALPHA_SNAP = 0;

/** Window over which `LoopStats.fps` is averaged. */
const FPS_WINDOW_MS = 500;

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

type Cancel = () => void;

/**
 * One frame callback. Falls back to a timer where there is no rAF (Node, a
 * headless harness), so importing this module can never throw.
 */
const schedule = (cb: (t: number) => void): Cancel => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id: ReturnType<typeof setTimeout> = setTimeout(() => cb(nowMs()), 16);
  return () => clearTimeout(id);
};

export interface LoopOpts {
  readonly sources: readonly [InputSource, InputSource];
  readonly onStats?: (s: LoopStats) => void;
  /** 100 = real time. KO slow-motion is 30. 0 pauses without stopping. */
  readonly timeScalePct?: number;
}

/**
 * A running clock over one scene stack root.
 *
 * `stats` is ONE object, reused every frame: the loop hands it to `onStats` and
 * keeps mutating it, so a consumer that wants to keep a frame's numbers must
 * copy them. Allocating a stats object per frame is 60 garbage objects a second
 * for a debug overlay nobody has open.
 */
export class Loop {
  /** simSteps: steps THIS rAF. hitches: cumulative. accMs/droppedMs: this rAF. */
  readonly stats: LoopStats = { simSteps: 0, hitches: 0, accMs: 0, fps: 0, droppedMs: 0 };

  private scene: Scene;
  private readonly sources: readonly [InputSource, InputSource];
  private readonly onStats: ((s: LoopStats) => void) | null;
  private scale: number;

  private acc = 0;
  private last = 0;
  private frameNo = 0;
  private active = false;
  private cancel: Cancel | null = null;

  private fpsMs = 0;
  private fpsFrames = 0;

  constructor(root: Scene, opts: LoopOpts) {
    this.scene = root;
    this.sources = opts.sources;
    this.onStats = opts.onStats ?? null;
    this.scale = clampScale(opts.timeScalePct ?? 100);
  }

  isRunning(): boolean {
    return this.active;
  }

  /** The scene currently on top. Changes when `tick` returns a transition. */
  currentScene(): Scene {
    return this.scene;
  }

  /** Sim frames stepped since `start()`. This is the number scenes are given. */
  frame(): number {
    return this.frameNo;
  }

  timeScalePct(): number {
    return this.scale;
  }

  /** KO slow-motion, pause, and the frame-step debug key all come through here. */
  setTimeScalePct(pct: number): void {
    this.scale = clampScale(pct);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.acc = 0;
    this.last = nowMs();
    this.fpsMs = 0;
    this.fpsFrames = 0;
    this.scene.enter();
    this.cancel = schedule(this.onFrame);
  }

  /** Stops the clock. Scenes are NOT exited and sources are NOT disposed: the
   *  caller owns both, and a paused menu must survive a stop/start pair. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.cancel !== null) {
      this.cancel();
      this.cancel = null;
    }
  }

  /**
   * ONE clock update: consume the elapsed time, run up to MAX_STEPS_PER_FRAME
   * sim steps, draw once. Public and clock-agnostic so a headless harness or a
   * test can drive the whole loop with a synthetic timeline. Returns the number
   * of sim steps it ran.
   */
  advance(now: number): number {
    let dt = now - this.last;
    this.last = now;
    // NaN-safe and monotonic-safe: a backwards clock contributes nothing.
    if (!(dt > 0)) dt = 0;

    let dropped = 0;
    if (dt > MAX_DELTA_MS) {
      dropped = dt - MAX_DELTA_MS;
      dt = MAX_DELTA_MS;
    }

    // GUARD 1 applied. Time scaling goes on the ACCUMULATOR.
    this.acc += (dt * this.scale) / 100;

    let steps = 0;
    let transitioned = false;
    while (this.acc >= SIM_DT_MS && steps < MAX_STEPS_PER_FRAME) {
      this.acc -= SIM_DT_MS;
      steps++;
      if (this.stepOnce()) {
        transitioned = true;
        break;
      }
    }

    let hitch = 0;
    if (transitioned) {
      // A fresh scene starts on a clean clock rather than inheriting a backlog
      // it never asked for. Not a hitch: nothing was dropped on the floor.
      this.acc = 0;
    } else if (this.acc >= SIM_DT_MS) {
      // GUARD 2: we hit the step cap with work outstanding. THROW IT AWAY.
      this.acc = 0;
      hitch = 1;
    }

    this.scene.draw(ALPHA_SNAP, dt);

    this.fpsMs += dt;
    this.fpsFrames++;
    if (this.fpsMs >= FPS_WINDOW_MS) {
      this.stats.fps = (this.fpsFrames * 1000) / this.fpsMs;
      this.fpsMs = 0;
      this.fpsFrames = 0;
    }

    this.stats.simSteps = steps;
    this.stats.hitches += hitch;
    this.stats.accMs = this.acc;
    this.stats.droppedMs = dropped;
    if (this.onStats !== null) this.onStats(this.stats);

    return steps;
  }

  /** Exactly one sim frame. Returns true if the scene was replaced. */
  private stepOnce(): boolean {
    const next = this.scene.tick(this.sources, this.frameNo);
    this.frameNo++;
    if (next === null || next === this.scene) return false;
    this.scene.exit();
    this.scene = next;
    next.enter();
    return true;
  }

  // Re-arms FIRST, so a throw inside a scene kills that frame, not the clock.
  private readonly onFrame = (t: number): void => {
    if (!this.active) return;
    this.cancel = schedule(this.onFrame);
    this.advance(typeof t === 'number' && t > 0 ? t : nowMs());
  };
}

const clampScale = (pct: number): number => {
  if (!(pct > 0)) return 0;
  return pct > 1000 ? 1000 : pct;
};

// -----------------------------------------------------------------------------
// THE MODULE-LEVEL LOOP
//
// `StartLoopFn` is `(root, onStats?) => void` — it carries no input sources, so
// something has to decide where they come from. `setLoopSources` before
// `startLoop` wins; otherwise the loop wires up the default two-player keyboard
// itself, which is exactly what M0's `src/main.ts` wants and is the reason
// booting the vertical slice is a single call.
// -----------------------------------------------------------------------------

let moduleLoop: Loop | null = null;
let moduleSources: readonly [InputSource, InputSource] | null = null;
let moduleKeyboard: KeyboardDevice | null = null;

/** Wire player 1 and player 2 before `startLoop`. Overrides the keyboard default. */
export const setLoopSources = (a: InputSource, b: InputSource): void => {
  moduleSources = [a, b];
};

/** The loop `startLoop` created, for the HUD, the debug keys and KO slow-motion. */
export const currentLoop = (): Loop | null => moduleLoop;

/** Explicit form: you own the sources. Returns the loop, already running. */
export const startLoopWith = (
  root: Scene,
  sources: readonly [InputSource, InputSource],
  onStats?: (s: LoopStats) => void,
): Loop => {
  stopLoop();
  const loop = new Loop(root, { sources, onStats });
  moduleLoop = loop;
  loop.start();
  return loop;
};

/** The contract's entry point. Boots the default keyboard pair if needed. */
export const startLoop: StartLoopFn = (root, onStats) => {
  if (moduleSources === null) {
    const pair = keyboardPair();
    moduleKeyboard = pair.device;
    moduleSources = pair.sources;
  }
  startLoopWith(root, moduleSources, onStats);
};

/** Stops the module loop and releases the keyboard IF this module opened it. */
export const stopLoop = (): void => {
  if (moduleLoop !== null) {
    moduleLoop.stop();
    moduleLoop = null;
  }
  if (moduleKeyboard !== null) {
    moduleKeyboard.dispose();
    moduleKeyboard = null;
    moduleSources = null;
  }
};

/** KO slow-motion (`KO_TIMESCALE_PCT`), frame-step, pause. No-op if not running. */
export const setTimeScalePct = (pct: number): void => {
  if (moduleLoop !== null) moduleLoop.setTimeScalePct(pct);
};

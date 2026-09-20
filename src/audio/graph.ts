// =============================================================================
// SunForce — src/audio/graph.ts
//
// The bus graph, and the one browser rule that makes or breaks audio:
// AN AUDIOCONTEXT STARTS SUSPENDED UNTIL A USER GESTURE.
//
// Chrome, Safari and Firefox all refuse to start an AudioContext that was not
// created or resumed inside a real input event. A suspended context does not
// error — `start()` succeeds, `currentTime` simply never advances — so the
// failure mode is total silence with a clean console, which reads as "the music
// code is broken" for as long as it takes to remember the policy. So the graph
// owns the unlock: `resumeOnGesture()` hooks the first keydown / pointerdown /
// touchend, resumes, logs the output latency once, and unhooks. If the context
// is later interrupted (iOS phone call, tab suspend) the hook re-arms itself.
//
// PRESENTATION ONLY. Nothing here reads or writes SimState, nothing here is
// hashed, and every entry point is non-throwing: a browser with no Web Audio
// gets `createAudioGraph() === null` and the game runs in silence.
//
// TOPOLOGY (contracts §14 AudioBuses)
//
//     music -> musicDuck -\
//     sfx   ---------------\
//     hit   ----------------+-> master -> limiter -> destination
//     voice ----------------/
//     foley ---------------/
//     ambience -----------/
//
// Why music gets two gains: `music` is the VOLUME (a setting, moved by the
// player) and `musicDuck` is the ENVELOPE (moved dozens of times a round by
// `setTargetAtTime` when a hit lands). Sharing one node means every duck fights
// the volume setting and a mid-duck volume change steps on the ramp.
//
// Why a DynamicsCompressor at the end and not on the music bus: it is a safety
// limiter against a KO plus six overlapping hits clipping the master, not a
// mixing tool. Sidechain ducking is done manually in music.ts, because a
// compressor keyed off another bus is imprecise and untunable (ENGINE-DECISIONS
// §16).
// =============================================================================

import type { AudioBuses } from '@/core/contracts';

/** Bus start levels. Music sits well under the hits on purpose. */
export const DEFAULT_GAINS = {
  master: 0.9,
  music: 0.55,
  sfx: 0.9,
  hit: 1.0,
  voice: 1.0,
  foley: 0.75,
  ambience: 0.45,
} as const;

/** Gestures that are allowed to unlock audio. Keyboard first: this is a game. */
const GESTURES: readonly string[] = ['keydown', 'pointerdown', 'touchend'];

export interface AudioGraph {
  readonly buses: AudioBuses;
  /** True only when the context is actually running (i.e. sound comes out). */
  readonly running: boolean;
  /** Hooks the first user gesture and resumes the context. Idempotent. */
  resumeOnGesture(target?: EventTarget): void;
  /** Resumes now. Only works inside a gesture handler; never throws. */
  resume(): Promise<boolean>;
  /** Runs `cb` once the context is running — immediately if it already is. */
  whenRunning(cb: () => void): void;
  setMasterGain(v: number): void;
  /** `ctx.currentTime`, the clock every schedule in this folder is stamped in. */
  now(): number;
  dispose(): void;
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

// -----------------------------------------------------------------------------
// One warning per subject, shared by every file in src/audio. The whole point of
// the missing-file contract is ONE line in the console, not one per frame.
// -----------------------------------------------------------------------------

const WARNED = new Set<string>();

export const warnOnce = (key: string, ...msg: readonly unknown[]): void => {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn('[sunforce/audio]', ...msg);
};

/** Test/reload escape hatch: lets a fresh graph warn again. */
export const resetAudioWarnings = (): void => WARNED.clear();

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const ctorOf = (): AudioContextCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

/** Reported, never compensated for — hitstop gives the ear a 150-230 ms window. */
const latencyMs = (ctx: AudioContext): number => {
  const c = ctx as { outputLatency?: number; baseLatency?: number };
  const s = c.outputLatency ?? c.baseLatency ?? 0;
  return Number.isFinite(s) ? Math.round(s * 1000) : 0;
};

// -----------------------------------------------------------------------------

export const createAudioGraph = (): AudioGraph | null => {
  const Ctor = ctorOf();
  if (Ctor === null) {
    warnOnce('no-webaudio', 'this browser has no Web Audio — the game runs in silence.');
    return null;
  }

  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch (err) {
    warnOnce('ctx-failed', 'could not create an AudioContext — running in silence.', err);
    return null;
  }

  const gain = (v: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  const master = gain(DEFAULT_GAINS.master);
  master.connect(limiter);

  const musicDuck = gain(1);
  musicDuck.connect(master);
  const music = gain(DEFAULT_GAINS.music);
  music.connect(musicDuck);

  const sfx = gain(DEFAULT_GAINS.sfx);
  const hit = gain(DEFAULT_GAINS.hit);
  const voice = gain(DEFAULT_GAINS.voice);
  const foley = gain(DEFAULT_GAINS.foley);
  const ambience = gain(DEFAULT_GAINS.ambience);
  for (const bus of [sfx, hit, voice, foley, ambience]) bus.connect(master);

  const buses: AudioBuses = { ctx, master, limiter, music, musicDuck, sfx, hit, voice, foley, ambience };

  // ---------------------------------------------------------------------------
  // Unlock
  // ---------------------------------------------------------------------------

  let waiters: (() => void)[] = [];
  let loggedLatency = false;
  let hookTarget: EventTarget | null = null;
  let hooked = false;
  let disposed = false;

  const isRunning = (): boolean => !disposed && ctx.state === 'running';

  const flush = (): void => {
    if (waiters.length === 0) return;
    const pending = waiters;
    waiters = [];
    for (const cb of pending) {
      try {
        cb();
      } catch (err) {
        console.warn('[sunforce/audio] a whenRunning callback threw', err);
      }
    }
  };

  const onGesture = (): void => {
    void resume();
  };

  const unhook = (): void => {
    if (!hooked || hookTarget === null) return;
    for (const type of GESTURES) hookTarget.removeEventListener(type, onGesture, true);
    hooked = false;
  };

  const hook = (target: EventTarget): void => {
    hookTarget = target;
    if (hooked || disposed) return;
    hooked = true;
    for (const type of GESTURES) {
      target.addEventListener(type, onGesture, { capture: true, passive: true });
    }
  };

  const resume = async (): Promise<boolean> => {
    if (disposed || ctx.state === 'closed') return false;
    if (ctx.state === 'running') {
      flush();
      return true;
    }
    try {
      await ctx.resume();
    } catch {
      // Not inside a gesture yet, or the OS said no. The hook stays armed.
      return false;
    }
    if (!isRunning()) return false;
    if (!loggedLatency) {
      loggedLatency = true;
      // Informational, not a warning: everything is fine at this point.
      console.info(`[sunforce/audio] running — output latency ~${latencyMs(ctx)} ms (not compensated).`);
    }
    unhook();
    flush();
    return true;
  };

  // iOS interrupts a context on a phone call and Chrome suspends a backgrounded
  // one. Re-arming the gesture hook means the next tap brings the music back
  // instead of the game going permanently quiet.
  ctx.onstatechange = (): void => {
    if (disposed) return;
    if (ctx.state === 'running') {
      unhook();
      flush();
    } else if (ctx.state !== 'closed' && hookTarget !== null) {
      hook(hookTarget);
    }
  };

  return {
    buses,
    get running(): boolean {
      return isRunning();
    },

    resumeOnGesture(target?: EventTarget): void {
      const t = target ?? (typeof window !== 'undefined' ? window : null);
      if (t === null) return;
      hook(t);
      // Already unlocked (a warm reload, or we were called from a click):
      // resume immediately rather than waiting for one more keypress.
      void resume();
    },

    resume,

    whenRunning(cb: () => void): void {
      if (isRunning()) {
        cb();
        return;
      }
      waiters.push(cb);
    },

    setMasterGain(v: number): void {
      if (disposed) return;
      // A ramp, not a jump: stepping a gain mid-sample is an audible click.
      master.gain.setTargetAtTime(clamp(v, 0, 2), ctx.currentTime, 0.02);
    },

    now(): number {
      return ctx.currentTime;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unhook();
      waiters = [];
      ctx.onstatechange = null;
      try {
        void ctx.close();
      } catch {
        /* closing a context that is already gone is not an error worth showing */
      }
    },
  };
};

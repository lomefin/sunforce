// =============================================================================
// SunForce — src/audio/sfx.ts
//
// One-shots, driven by the sim's event ring — and the small facade that wires
// the whole audio folder together (`createAudioSystem`, at the bottom).
//
// WHY A CURSOR AND A WATERMARK
// The sim never calls presentation: it appends to a 48-slot ring inside the
// state buffer, and we drain it afterwards (src/sim/events.ts). Two rules come
// out of that design and both are load-bearing here:
//
//   1. Drain with an `EventDrain`, not the stateless `drainEvents`. The cursor
//      is what makes "each event exactly once" true; a stateless pass would
//      re-fire every resident event on every single frame — 48 sounds a frame.
//      (`drainEvents` is the right call for a one-shot reader such as a debug
//      overlay, which is what it exists for.)
//   2. Stop at the confirmed-frame watermark, so a mispredicted frame's sounds
//      are discarded rather than played and then un-played, which is impossible.
//
// `g.confirmedFrame` is the Runner's to advance, and in local play with no
// netcode nothing does — it sits at 0 (see the note in src/sim/step.ts). A
// cursor honouring it strictly would therefore be permanently silent, so
// `localConfirmLag` gives the presentation side its own watermark: frames older
// than `g.frame - lag` count as confirmed. 0 is right for local play, where
// there is no prediction and nothing is ever rolled back. Set it to `null` when
// rollback netcode lands and the Runner starts maintaining `confirmedFrame`.
// Either way this file only ever READS SimState.
//
// MISSING FILES ARE SILENT, same rule as the music: the loader logs one line
// per id and hands back null forever after. A sound that has not been decoded
// yet starts loading in the background and is silent this once, because a
// one-shot may not await inside a frame.
// =============================================================================

import type { EventRing, SimState, StageDef } from '@/core/contracts';
import { SfxId, STAGE_WIDTH } from '@/core/contracts';
import { px } from '@/core/fixed';
import { EventDrain, eventSfx } from '@/sim/events';
import type { AudioGraph } from '@/audio/graph';
import { createAudioGraph } from '@/audio/graph';
import type { AudioLoader } from '@/audio/load';
import { createAudioLoader } from '@/audio/load';
import type { MusicPlayer } from '@/audio/music';
import { createMusicPlayer } from '@/audio/music';

// -----------------------------------------------------------------------------
// Id -> filename. Explicit, because an enum's reverse map is not a filename and
// a kebab-case transform makes the set of legal filenames a guess.
//   public/audio/sfx/<name>.{webm,ogg,m4a,mp3}
// -----------------------------------------------------------------------------

export const SFX_FILES: Readonly<Record<SfxId, string>> = {
  [SfxId.NONE]: '',
  [SfxId.HIT_LIGHT]: 'hit-light',
  [SfxId.HIT_HEAVY]: 'hit-heavy',
  [SfxId.HIT_COUNTER]: 'hit-counter',
  [SfxId.GUARD_LIGHT]: 'guard-light',
  [SfxId.GUARD_HEAVY]: 'guard-heavy',
  [SfxId.WHIFF_LIGHT]: 'whiff-light',
  [SfxId.WHIFF_HEAVY]: 'whiff-heavy',
  [SfxId.LAND]: 'land',
  [SfxId.DASH]: 'dash',
  [SfxId.JUMP]: 'jump',
  [SfxId.BELL]: 'bell',
  [SfxId.THROW_GRAB]: 'throw-grab',
  [SfxId.THROW_TECH]: 'throw-tech',
  [SfxId.KO]: 'ko',
  [SfxId.ROUND_START]: 'round-start',
  [SfxId.WALL_HIT]: 'wall-hit',
  [SfxId.ARMOR]: 'armor',
  [SfxId.JUGGLE_DENY]: 'juggle-deny',
  [SfxId.SFX_COUNT]: '',
};

/** Impacts go to the `hit` bus so they can be mixed against everything else. */
const HIT_BUS_IDS: ReadonlySet<SfxId> = new Set<SfxId>([
  SfxId.HIT_LIGHT, SfxId.HIT_HEAVY, SfxId.HIT_COUNTER,
  SfxId.GUARD_LIGHT, SfxId.GUARD_HEAVY,
  SfxId.WALL_HIT, SfxId.ARMOR, SfxId.THROW_GRAB, SfxId.KO,
]);

/** Footsteps and cloth: quieter bus, so they never compete with an impact. */
const FOLEY_IDS: ReadonlySet<SfxId> = new Set<SfxId>([SfxId.LAND, SfxId.DASH, SfxId.JUMP]);

/** How hard each one punches a hole in the music: [amount, hold, release]. */
const DUCKS: ReadonlyMap<SfxId, readonly [number, number, number]> = new Map([
  [SfxId.HIT_HEAVY, [0.35, 0.08, 0.35] as const],
  [SfxId.HIT_COUNTER, [0.45, 0.12, 0.45] as const],
  [SfxId.GUARD_HEAVY, [0.22, 0.05, 0.3] as const],
  [SfxId.WALL_HIT, [0.25, 0.06, 0.3] as const],
  [SfxId.KO, [0.7, 0.9, 1.6] as const],
]);

/** Impacts get a touch of random detune so a combo is not a machine gun. */
const PITCH_JITTER = 0.06;
/** Hard cap on simultaneous one-shots. A 48-event frame must not wall of noise. */
const MAX_VOICES = 24;
/** Stereo width. Full-width panning on a 3600-unit stage is seasickness. */
const PAN_WIDTH = 0.55;

export interface SfxOpts {
  /**
   * Frames behind `g.frame` that presentation treats as confirmed when the
   * Runner does not maintain `g.confirmedFrame`. `null` trusts the watermark
   * strictly (the correct setting once rollback exists).
   */
  readonly localConfirmLag: number | null;
  /** World width used to map worldX to stereo position. */
  readonly stageWidth: number;
}

const DEFAULTS: SfxOpts = { localConfirmLag: 0, stageWidth: STAGE_WIDTH };

export interface SfxPlayer {
  /** Drains the ring and fires. Call once per sim step, after `step()`. */
  update(s: SimState): void;
  /** Fires one sound now. `worldX` is world units, not FX. */
  play(id: SfxId, worldX: number, gain?: number, pitch?: number): void;
  /** Decodes every sfx file up front. Absent ones stay absent, quietly. */
  prewarm(): Promise<void>;
  /** Forget the cursor — round reset, scene change, rewind. */
  reset(): void;
  dispose(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const createSfxPlayer = (
  graph: AudioGraph,
  loader: AudioLoader,
  music: MusicPlayer,
  opts: Partial<SfxOpts> = {},
): SfxPlayer => {
  const cfg: SfxOpts = { ...DEFAULTS, ...opts };
  const { ctx, sfx: sfxBus, hit: hitBus, foley: foleyBus } = graph.buses;
  const canPan = typeof ctx.createStereoPanner === 'function';
  const halfStage = Math.max(1, cfg.stageWidth * 0.5);

  const drain = new EventDrain();
  let voices = 0;
  let disposed = false;

  const busFor = (id: SfxId): GainNode =>
    HIT_BUS_IDS.has(id) ? hitBus : FOLEY_IDS.has(id) ? foleyBus : sfxBus;

  const play = (id: SfxId, worldX: number, gain = 1, pitch = 1): void => {
    if (disposed || id === SfxId.NONE || id === SfxId.SFX_COUNT) return;
    // Scheduling on a suspended context would queue every one-shot to fire at
    // once the instant it resumes. Drop them instead.
    if (!graph.running) return;
    if (voices >= MAX_VOICES) return;

    const name = SFX_FILES[id] ?? '';
    if (name === '') return;
    // Cache-only: a fetch here would arrive frames late. The first firing of a
    // sound is silent and every one after it is not.
    const buf = loader.request('sfx', name);
    if (buf === null) return;

    const node = ctx.createBufferSource();
    node.buffer = buf;
    const jitter = HIT_BUS_IDS.has(id) ? 1 + (Math.random() * 2 - 1) * PITCH_JITTER : 1;
    node.playbackRate.value = clamp(pitch * jitter, 0.25, 4);

    const g = ctx.createGain();
    g.gain.value = clamp(gain, 0, 4);
    node.connect(g);

    let tail: AudioNode = g;
    if (canPan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp((worldX - halfStage) / halfStage, -1, 1) * PAN_WIDTH;
      g.connect(pan);
      tail = pan;
    }
    tail.connect(busFor(id));

    voices++;
    node.onended = (): void => {
      voices--;
      try {
        node.disconnect();
        g.disconnect();
        if (tail !== g) tail.disconnect();
      } catch {
        /* already gone */
      }
    };

    try {
      // ctx.currentTime, deliberately uncompensated: hitstop freezes the frame
      // for 9-14 frames, which is a 150-230 ms window for the ear.
      node.start(ctx.currentTime);
    } catch {
      voices--;
    }
  };

  /** Allocated once: the drain callback runs on every event of every frame. */
  const onEvent = (r: EventRing, i: number): void => {
    const id = eventSfx(r.b(i));
    if (id === SfxId.NONE) return;
    play(id, px(r.worldX(i)));
    const d = DUCKS.get(id);
    if (d !== undefined) music.duck(d[0], d[1], d[2]);
  };

  const watermark = (s: SimState): number => {
    const confirmed = s.g.confirmedFrame;
    const lag = cfg.localConfirmLag;
    if (lag === null) return confirmed;
    const local = s.g.frame - lag;
    return confirmed > local ? confirmed : local;
  };

  return {
    update(s: SimState): void {
      if (disposed) return;
      drain.drain(s, watermark(s), onEvent);
    },

    play,

    async prewarm(): Promise<void> {
      const names = Object.values(SFX_FILES).filter((n) => n !== '');
      await loader.prefetch('sfx', names);
    },

    reset(): void {
      drain.reset();
    },

    dispose(): void {
      disposed = true;
      drain.reset();
    },
  };
};

// =============================================================================
// The facade. Four modules, one object, and it is never null: on a browser
// without Web Audio every method is a no-op, so main.ts has no branch and boot
// cannot fail because of audio.
// =============================================================================

export interface AudioSystem {
  /** False when the browser gave us no AudioContext. Everything still works. */
  readonly available: boolean;
  /** True once the context is actually running. */
  readonly running: boolean;
  /** Call at boot. Arms the first-gesture unlock the autoplay policy demands. */
  resumeOnGesture(target?: EventTarget): void;
  playStageMusic(stage: StageDef): Promise<void>;
  stopMusic(fadeSeconds?: number): void;
  /** Once per sim step, after `step()`. Reads SimState, never writes it. */
  update(s: SimState): void;
  playSfx(id: SfxId, worldX: number, gain?: number, pitch?: number): void;
  /**
   * Optional: decodes every sfx file up front so the first hit of the match is
   * not the silent one. Worth calling only once sfx files actually exist —
   * until then it is 18 ids x 4 extensions of 404s for nothing.
   */
  prewarmSfx(): Promise<void>;
  duck(amount: number, holdSeconds: number, releaseSeconds: number): void;
  setMasterGain(v: number): void;
  setMusicVolume(v: number): void;
  /** Round reset / scene change: drop the event cursor. */
  reset(): void;
  dispose(): void;
}

const SILENT: AudioSystem = {
  available: false,
  running: false,
  resumeOnGesture: () => undefined,
  playStageMusic: () => Promise.resolve(),
  stopMusic: () => undefined,
  update: () => undefined,
  playSfx: () => undefined,
  prewarmSfx: () => Promise.resolve(),
  duck: () => undefined,
  setMasterGain: () => undefined,
  setMusicVolume: () => undefined,
  reset: () => undefined,
  dispose: () => undefined,
};

export const createAudioSystem = (opts: Partial<SfxOpts> = {}): AudioSystem => {
  const graph = createAudioGraph();
  if (graph === null) return SILENT;

  const loader = createAudioLoader(graph.buses.ctx);
  const music = createMusicPlayer(graph, loader);
  const sfx = createSfxPlayer(graph, loader, music, opts);

  return {
    available: true,
    get running(): boolean {
      return graph.running;
    },
    resumeOnGesture: (target?: EventTarget): void => graph.resumeOnGesture(target),
    playStageMusic: (stage: StageDef): Promise<void> => music.play(stage),
    stopMusic: (fadeSeconds?: number): void => music.stop(fadeSeconds),
    update: (s: SimState): void => sfx.update(s),
    playSfx: (id: SfxId, worldX: number, gain?: number, pitch?: number): void =>
      sfx.play(id, worldX, gain, pitch),
    prewarmSfx: (): Promise<void> => sfx.prewarm(),
    duck: (amount: number, hold: number, release: number): void => music.duck(amount, hold, release),
    setMasterGain: (v: number): void => graph.setMasterGain(v),
    setMusicVolume: (v: number): void => music.setVolume(v),
    reset: (): void => sfx.reset(),
    dispose: (): void => {
      sfx.dispose();
      music.dispose();
      loader.clear();
      graph.dispose();
    },
  };
};

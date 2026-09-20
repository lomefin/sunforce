// =============================================================================
// SunForce — src/audio/music.ts
//
// Stage music. One track at a time, on an AudioBufferSourceNode.
//
// NEVER AN HTMLAudioElement. `<audio loop>` re-seeks on the main thread at the
// end of every pass, so the loop seam clicks or drops 20-80 ms of silence —
// once a minute for the whole fight. An AudioBufferSourceNode loops on the
// audio thread, sample-exact, forever. That is the whole reason this file
// decodes the file up front instead of streaming it.
//
// LOOP POINTS ARE DATA. `StageDef.loopStart` / `loopEnd` are SECONDS, and the
// node takes seconds, so they pass straight through. Neither set (the common
// case, and the case for every stage today) loops the entire buffer: node
// defaults of 0 mean "start of buffer" and "end of buffer" respectively. An mp3
// carries encoder padding at both ends, so a track that must loop musically
// wants those two numbers rather than a re-encode.
//
// THE CHAIN, and why each gain exists:
//
//     source -> trackGain -> buses.music -> buses.musicDuck -> master
//               ^ fades        ^ volume      ^ the sidechain envelope
//
// Three jobs that all move the same decibels and would otherwise overwrite each
// other: a crossfade at stage change, the player's volume setting, and the duck
// that fires on every heavy hit.
//
// DUCKING IS A MANUAL ENVELOPE (ENGINE-DECISIONS §16). `setTargetAtTime` gives
// an exponential fall to a known depth with a known recovery, keyed off the
// exact frame the hit landed. A DynamicsCompressor keyed off the hit bus would
// have to hear the hit first, ducks by an amount that depends on how loud the
// sample happened to be, and pumps.
//
// ONE CODE PATH, TWO DOORS. `playId(musicId)` is the real entry point: a music
// id is all the audio layer has ever needed, and screens that are not stages
// (the character select) have one too. `play(stage)` is a four-line wrapper
// that reads `musicId` / `loopStart` / `loopEnd` off the StageDef and calls
// `playId`. There is no second start path to keep in sync, and no fake StageDef
// invented so that a menu can have a theme.
//
// PRESENTATION ONLY: nothing here reads SimState, and every call is safe before
// the context has been unlocked — a source started on a suspended context plays
// from its first sample the moment the user's first keypress resumes it.
// =============================================================================

import type { StageDef } from '@/core/contracts';
import type { AudioGraph } from '@/audio/graph';
import { warnOnce } from '@/audio/graph';
import type { AudioLoader } from '@/audio/load';

/** Fade in on play and out on stop, seconds. Short: this is not a slideshow. */
const FADE_IN = 0.8;
const FADE_OUT = 0.6;

/** How fast a duck falls. ~3 time constants to arrive, so this is ~36 ms. */
const DUCK_ATTACK_TAU = 0.012;

/** Loop points in SECONDS, exactly as the node wants them. Both optional. */
export interface LoopPoints {
  readonly loopStart?: number;
  readonly loopEnd?: number;
}

export interface MusicPlayer {
  /** musicId of the track currently playing, or null for silence. */
  readonly nowPlaying: string | null;
  /**
   * Plays the track at `public/audio/music/<musicId>.<ext>`. Missing file =>
   * silence + one warning from the loader, never a rejection. Calling it again
   * with the id that is already playing — or already being decoded — is a
   * no-op, so a scene re-enter does not restart the track.
   */
  playId(musicId: string, opts?: LoopPoints): Promise<void>;
  /** `playId` with the ids and loop points read off a stage. */
  play(stage: StageDef): Promise<void>;
  stop(fadeSeconds?: number): void;
  /** 0..1 (above 1 is allowed but the limiter will take it back). */
  setVolume(v: number): void;
  getVolume(): number;
  /**
   * Sidechain. `amount` 0..1 is how far down (0.35 = -3.7 dB), `holdSeconds`
   * is the floor before recovery starts, `releaseSeconds` the recovery.
   */
  duck(amount: number, holdSeconds: number, releaseSeconds: number): void;
  dispose(): void;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const createMusicPlayer = (graph: AudioGraph, loader: AudioLoader): MusicPlayer => {
  const { ctx, music, musicDuck } = graph.buses;

  let source: AudioBufferSourceNode | null = null;
  let trackGain: GainNode | null = null;
  let currentId: string | null = null;
  /**
   * The id that has been asked for but is still decoding. `currentId` only
   * becomes true once the node is started, and a decode is tens of
   * milliseconds, so without this a scene that asks twice in that window (a
   * transition plus a re-enter) starts two sources and the track doubles.
   */
  let pendingId: string | null = null;
  let volume = music.gain.value;
  let disposed = false;
  /** Guards against an await landing after a newer play()/stop() overtook it. */
  let epoch = 0;

  const teardown = (node: AudioBufferSourceNode, g: GainNode, at: number): void => {
    node.onended = (): void => {
      try {
        node.disconnect();
        g.disconnect();
      } catch {
        /* already torn down */
      }
    };
    try {
      node.stop(at);
    } catch {
      /* never started, or already stopped */
    }
  };

  const stop = (fadeSeconds = FADE_OUT): void => {
    epoch++;
    const node = source;
    const g = trackGain;
    source = null;
    trackGain = null;
    currentId = null;
    pendingId = null;
    if (node === null || g === null) return;

    const t = ctx.currentTime;
    const f = Math.max(0.01, fadeSeconds);
    const p = g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(0, t + f);
    teardown(node, g, t + f + 0.02);
  };

  /**
   * Loop window in seconds, validated against the decoded buffer. Anything
   * nonsensical (end before start, past the end of the file, NaN from a hand-
   * edited stage def) falls back to looping the whole thing rather than
   * producing a 3 ms stutter that is very hard to diagnose by ear.
   */
  const loopWindow = (id: string, opts: LoopPoints | undefined, dur: number): readonly [number, number] => {
    const rawStart = opts?.loopStart ?? 0;
    const rawEnd = opts?.loopEnd ?? 0;
    const start = Number.isFinite(rawStart) && rawStart > 0 && rawStart < dur ? rawStart : 0;
    const end = Number.isFinite(rawEnd) && rawEnd > start && rawEnd <= dur ? rawEnd : 0;
    if ((rawStart > 0 || rawEnd > 0) && start === 0 && end === 0) {
      warnOnce(
        `loop:${id}`,
        `music "${id}" was given loopStart/loopEnd outside its ${dur.toFixed(2)}s ` +
          `file — looping the whole buffer instead.`,
      );
    }
    return [start, end]; // 0 / 0 means "whole buffer" to the node, by spec.
  };

  const playId = async (musicId: string, opts?: LoopPoints): Promise<void> => {
    if (disposed) return;
    const id = musicId;
    if (id === '') return;
    if (currentId === id && source !== null) return; // already playing this track
    if (pendingId === id) return; // already on its way in

    stop(FADE_OUT);
    const mine = ++epoch;
    pendingId = id; // set AFTER stop(), which clears it.

    const buf = await loader.load('music', id);
    // Overtaken while decoding, torn down, or there is simply no file: the
    // loader has already logged the one warning it owes and we play silence.
    if (disposed || mine !== epoch) return;
    if (buf === null) {
      pendingId = null;
      return;
    }

    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.loop = true;
    const [loopStart, loopEnd] = loopWindow(id, opts, buf.duration);
    node.loopStart = loopStart;
    node.loopEnd = loopEnd;

    const g = ctx.createGain();
    node.connect(g);
    g.connect(music);

    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + FADE_IN);

    try {
      // Offset 0, not loopStart: the intro before the loop point is meant to be
      // heard once. The node only jumps back to loopStart after it first
      // reaches loopEnd.
      node.start(t);
    } catch (err) {
      warnOnce(`start:${id}`, `could not start music "${id}" — playing silence.`, err);
      pendingId = null;
      try {
        node.disconnect();
        g.disconnect();
      } catch {
        /* nothing to unhook */
      }
      return;
    }

    source = node;
    trackGain = g;
    currentId = id;
    pendingId = null;

    // The node is live on the audio thread either way, but on a context that
    // has not been unlocked yet nothing comes out until the first keypress.
    // "Playing, but silent" is the single most confusing state in browser
    // audio, so it gets one line.
    if (!graph.running) {
      warnOnce(
        'autoplay',
        `music "${id}" is queued — the browser will not start audio until you press a key or click.`,
      );
    }
  };

  /**
   * The stage door. Four lines and no logic of its own: every guarantee above —
   * the same-id no-op, the crossfade out of the previous track, silence on a
   * missing file — is `playId`'s, so a stage and a menu screen behave
   * identically.
   */
  const play = (stage: StageDef): Promise<void> =>
    playId(stage.musicId, { loopStart: stage.loopStart, loopEnd: stage.loopEnd });

  return {
    get nowPlaying(): string | null {
      return currentId;
    },

    playId,
    play,
    stop,

    setVolume(v: number): void {
      if (disposed) return;
      volume = clamp(v, 0, 2);
      const t = ctx.currentTime;
      music.gain.cancelScheduledValues(t);
      music.gain.setValueAtTime(music.gain.value, t);
      music.gain.linearRampToValueAtTime(volume, t + 0.05);
    },

    getVolume(): number {
      return volume;
    },

    duck(amount: number, holdSeconds: number, releaseSeconds: number): void {
      if (disposed) return;
      const depth = clamp(1 - clamp(amount, 0, 1), 0.05, 1);
      const t = ctx.currentTime;
      const hold = Math.max(0, holdSeconds);
      const release = Math.max(0.02, releaseSeconds);
      const p = musicDuck.gain;

      // Re-arming mid-duck must not step: hold the CURRENT value, then fall.
      // Without the explicit setValueAtTime, cancelScheduledValues leaves the
      // param at the value its last ramp was aiming for, which is a click.
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.setTargetAtTime(depth, t, DUCK_ATTACK_TAU);
      p.setTargetAtTime(1, t + hold, release / 3);
    },

    dispose(): void {
      if (disposed) return;
      stop(0.05);
      disposed = true;
    },
  };
};

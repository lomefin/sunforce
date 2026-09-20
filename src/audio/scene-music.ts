// =============================================================================
// SunForce — src/audio/scene-music.ts
//
// WHO PLAYS WHAT. One tiny façade over MusicPlayer that the SCENES drive:
// the select screen asks for `selectTheme()`, the fight asks for
// `stageTheme(stage)`, and anything that wants quiet asks for `silence()`.
// Nothing above this file knows a music id, a fade length, or the state of the
// AudioContext.
//
// WHY A FAÇADE AND NOT `music.play(...)` AT THE CALL SITE
//
//   1. THE CONTEXT IS PROBABLY NOT RUNNING YET. A browser keeps an
//      AudioContext suspended until a real user gesture, and the game boots
//      straight into a fight — so the very first `stageTheme()` happens before
//      anyone has touched a key. `graph.whenRunning(cb)` exists for exactly
//      this, but a scene should not have to remember it on every transition.
//      Here it is remembered once.
//
//   2. THOSE DEFERRED CALLBACKS MUST NOT STACK. '[' in and out of the select
//      screen five times before the first keypress would queue five callbacks,
//      and on resume they would fire in order — five `play` calls, each one
//      cancelling the last, which is audible as a stutter at the exact moment
//      audio comes alive. So this file keeps ONE arming flag and ONE piece of
//      state: `wanted`, the id the game would like to hear. Repeated
//      transitions overwrite that string and nothing else.
//
//   3. THE HANDOVER SHOULD SOUND LIKE A HANDOVER. Going to the select screen
//      and coming back is a crossfade, not a hard stop followed by a hard
//      start: the outgoing track is faded with `stop(CROSSFADE)` while the
//      incoming one runs its own fade-in through the same music bus. No second
//      mixer, no extra GainNode — MusicPlayer already owns both ends and this
//      file only chooses the length.
//
// WHAT IS NOT HERE: volume (a setting — `music.setVolume`), ducking (a
// per-hit envelope — `music.duck`), and stage ambience. This is only the
// question of WHICH TRACK, and every entry point is a fire-and-forget `void`
// so a scene's `enter()` never has a promise to handle.
//
// PRESENTATION ONLY. Nothing here reads SimState, nothing here is hashed, and
// every call is safe on a suspended, never-unlocked or silent-by-fallback
// audio stack.
// =============================================================================

import type { StageDef } from '@/core/contracts';
import type { AudioGraph } from '@/audio/graph';
import type { MusicPlayer } from '@/audio/music';

/**
 * The select screen's track: `public/audio/music/select.<ext>`, by the same
 * convention every stage uses (load.ts). It is an ID, not configuration —
 * dropping a different file at that path is the entire workflow.
 */
export const SELECT_MUSIC_ID = 'select';

/**
 * Crossfade length, seconds. Long enough that the seam reads as a transition
 * rather than a cut, short enough that the select screen is not still playing
 * the stage theme once the player has started moving the cursor. Sits just
 * above the FADE_IN the incoming track uses, so the pair overlaps.
 */
const CROSSFADE = 0.9;

/** Going to silence deliberately, e.g. before a pause or a teardown. */
const FADE_OUT = 0.6;

export interface SceneMusic {
  /**
   * The id this façade wants to hear, which is NOT always what is audible:
   * before the first user gesture it is what will start the moment the context
   * unlocks. `null` means silence was asked for. Debug/HUD handle.
   */
  readonly wanted: string | null;
  /** True once the intent has actually been handed to the player. */
  readonly settled: boolean;
  /** The character select screen. Idempotent: re-entering does not restart. */
  selectTheme(): void;
  /** The fight. Plays `stage.musicId` with the stage's own loop points. */
  stageTheme(stage: StageDef): void;
  /** Fade to nothing. Idempotent. */
  silence(fadeSeconds?: number): void;
  /** Stops and forgets. Safe to call twice. */
  dispose(): void;
}

/**
 * A single request. The id is what makes it idempotent — comparing ids is how
 * "the select screen asked again" is told apart from "the stage changed" — and
 * `start` is the closure that actually hands it to the player, which is what
 * keeps the stage's loop points attached to the stage that owns them.
 */
interface Wish {
  readonly id: string;
  readonly start: (player: MusicPlayer) => void;
}

export const createSceneMusic = (graph: AudioGraph, player: MusicPlayer): SceneMusic => {
  /** What the game would like to hear. `null` is a deliberate silence. */
  let wish: Wish | null = null;
  /** Fade length for a pending silence, seconds. */
  let silenceFade = FADE_OUT;
  /** The id last actually handed to the player: what is (or will be) audible. */
  let applied: string | null = null;
  /** One `whenRunning` callback in flight at a time — see note 2 up top. */
  let armed = false;
  let disposed = false;

  /**
   * Hand the current wish to the player. Called either immediately (context
   * running) or once from the armed callback (context just unlocked), never
   * from both, and always with the LATEST wish rather than the one that was
   * current when the callback was queued.
   */
  const apply = (): void => {
    if (disposed) return;
    const want = wish;

    if (want === null) {
      if (applied === null) return; // already silent, or never started anything
      applied = null;
      player.stop(silenceFade);
      return;
    }

    if (applied === want.id) return; // already playing it: a re-enter is a no-op

    // THE CROSSFADE. Fading the outgoing track ourselves, before asking for the
    // new one, is the whole difference between a handover and a cut: the
    // player's own internal stop is a shorter, blunter one meant for a hard
    // switch, and by the time `playId` runs there is nothing left for it to
    // stop. The incoming track then fades in over the top through the same
    // music bus while this ramp finishes.
    if (applied !== null) player.stop(CROSSFADE);
    applied = want.id;
    want.start(player);
  };

  /**
   * Arm the one deferred apply. Everything is safe to call on a suspended
   * context, but the track that starts on a frozen clock spends its fade-in
   * frozen too — so the first note of the boot fight would arrive already
   * half-faded. Waiting for `running` costs nothing and starts the track
   * cleanly on the keypress that unlocked audio.
   */
  const arm = (): void => {
    if (armed) return;
    armed = true;
    graph.whenRunning(() => {
      armed = false;
      apply();
    });
  };

  /** The single funnel. Every public method is two lines and ends here. */
  const request = (next: Wish | null): void => {
    if (disposed) return;
    // Idempotent at the door: the id the game already wants needs no work at
    // all, whether it is playing, decoding, or queued behind the unlock.
    if (next === null ? wish === null : wish !== null && wish.id === next.id) return;
    wish = next;
    if (graph.running) {
      apply();
      return;
    }
    arm();
  };

  return {
    get wanted(): string | null {
      return wish?.id ?? null;
    },

    get settled(): boolean {
      return applied === (wish?.id ?? null);
    },

    selectTheme(): void {
      // No loop points: the select theme is a loop from end to end. If it ever
      // gains an intro, it gains them here and nowhere else.
      request({
        id: SELECT_MUSIC_ID,
        start: (p) => void p.playId(SELECT_MUSIC_ID),
      });
    },

    stageTheme(stage: StageDef): void {
      // An empty musicId is a stage that declares no music — silence, not a
      // 404 hunt for `public/audio/music/.mp3`.
      if (stage.musicId === '') {
        silenceFade = FADE_OUT;
        request(null);
        return;
      }
      // `play(stage)` rather than `playId(stage.musicId)`: the StageDef is the
      // only place the loop points live, and this keeps them travelling with
      // the stage instead of being re-derived here.
      request({ id: stage.musicId, start: (p) => void p.play(stage) });
    },

    silence(fadeSeconds = FADE_OUT): void {
      silenceFade = Math.max(0.01, fadeSeconds);
      request(null);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      wish = null;
      applied = null;
      // The armed callback, if any, checks `disposed` and does nothing. The
      // player is NOT disposed here: this façade borrows it, main.ts owns it.
      player.stop(0.2);
    },
  };
};

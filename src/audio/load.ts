// =============================================================================
// SunForce — src/audio/load.ts
//
// Convention over configuration (CLAUDE.md, ENGINE-DECISIONS §16). There is no
// manifest, no registry and no build step: an id maps to a path, the loader
// tries four extensions, and the first one that exists wins.
//
//     public/audio/music/<id>.webm    <- preferred: Opus, small, gapless
//     public/audio/music/<id>.ogg
//     public/audio/music/<id>.m4a
//     public/audio/music/<id>.mp3     <- fine; encoder padding makes the seam
//                                        audible, which is what loopStart /
//                                        loopEnd on the StageDef are for
//
// THE RULE THAT MATTERS: A MISSING FILE IS NOT AN ERROR.
// Every failure — 404 on all four, a dev-server HTML fallback, a corrupt file,
// a codec the browser will not decode, the network dropping — resolves to
// `null` and logs ONE console warning for that id, ever. The caller plays
// silence. Dropping a file in and reloading is the entire workflow; until then
// the game boots, runs and sounds like nothing, which is the point.
//
// Results are cached as PROMISES, so ten fighters asking for hit-light on the
// same frame issue one fetch, and a known-missing id costs a Map lookup rather
// than four more 404s per hit.
// =============================================================================

import { warnOnce } from '@/audio/graph';

export type AudioKind = 'music' | 'sfx';

/** Tried in this order; first hit wins. */
export const AUDIO_EXTS: readonly string[] = ['webm', 'ogg', 'm4a', 'mp3'];

export interface AudioLoader {
  /** Fetch + decode, cached. Resolves to `null` when nothing is there. */
  load(kind: AudioKind, id: string): Promise<AudioBuffer | null>;
  /** Cache only — never starts a fetch. For the hot path. */
  peek(kind: AudioKind, id: string): AudioBuffer | null;
  /**
   * The one-shot call: returns the buffer if it is already decoded, otherwise
   * starts the load in the background and returns `null`. A sound effect must
   * never await inside a frame — the first firing is silent, the rest are not.
   */
  request(kind: AudioKind, id: string): AudioBuffer | null;
  /** True once every extension has been tried and none existed. */
  missing(kind: AudioKind, id: string): boolean;
  /** Warms the cache. Failures are absorbed, exactly as during play. */
  prefetch(kind: AudioKind, ids: readonly string[]): Promise<void>;
  clear(): void;
}

/** Where the files live, relative to the document base (Vite serves public/). */
const ROOT = 'audio/';

const baseUrl = (): string =>
  typeof document !== 'undefined' && document.baseURI !== '' ? document.baseURI : 'http://localhost/';

const urlFor = (kind: AudioKind, id: string, ext: string): string =>
  new URL(`${ROOT}${kind}/${encodeURIComponent(id)}.${ext}`, baseUrl()).href;

/**
 * Promise + callback form together. Safari shipped `decodeAudioData` callback-
 * only for years and still honours both; modern engines resolve the promise.
 * Whichever settles first wins and the other is ignored.
 */
const decode = (ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> =>
  new Promise<AudioBuffer>((resolve, reject) => {
    let p: unknown;
    try {
      p = ctx.decodeAudioData(data, resolve, reject);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (p instanceof Promise) void p.then(resolve, reject);
  });

/**
 * A dev server that answers an unknown path with index.html would otherwise
 * hand us an HTML page to decode as audio. Treat it as a miss.
 */
const isHtml = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('text/html');

export const createAudioLoader = (ctx: AudioContext): AudioLoader => {
  const pending = new Map<string, Promise<AudioBuffer | null>>();
  const ready = new Map<string, AudioBuffer>();
  const absent = new Set<string>();

  const keyOf = (kind: AudioKind, id: string): string => `${kind}/${id}`;

  /** One extension. Resolves to null for "not here", which is not a failure. */
  const tryOne = async (url: string, key: string): Promise<AudioBuffer | null> => {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return null; // offline, blocked, CORS — indistinguishable from absent, and
    } //             treated the same on purpose.
    if (!res.ok || isHtml(res)) return null;

    let bytes: ArrayBuffer;
    try {
      bytes = await res.arrayBuffer();
    } catch {
      return null;
    }
    if (bytes.byteLength === 0) return null;

    try {
      return await decode(ctx, bytes);
    } catch (err) {
      // The file EXISTS but will not decode. That is worth saying out loud once,
      // because "silence" and "your export is broken" are different problems.
      warnOnce(`decode:${key}:${url}`, `could not decode ${url} — trying the next extension.`, err);
      return null;
    }
  };

  const fetchAll = async (kind: AudioKind, id: string, key: string): Promise<AudioBuffer | null> => {
    for (const ext of AUDIO_EXTS) {
      const buf = await tryOne(urlFor(kind, id, ext), key);
      if (buf !== null) {
        ready.set(key, buf);
        return buf;
      }
    }
    absent.add(key);
    warnOnce(
      `missing:${key}`,
      `no ${kind} for "${id}" — tried ${AUDIO_EXTS.map((e) => `.${e}`).join(' ')} in ` +
        `public/audio/${kind}/. Playing silence. Drop public/audio/${kind}/${id}.mp3 in and reload.`,
    );
    return null;
  };

  const load = (kind: AudioKind, id: string): Promise<AudioBuffer | null> => {
    const key = keyOf(kind, id);
    const done = ready.get(key);
    if (done !== undefined) return Promise.resolve(done);
    if (absent.has(key)) return Promise.resolve(null);

    const inFlight = pending.get(key);
    if (inFlight !== undefined) return inFlight;

    // Even a bug in here must not reject: every caller is presentation.
    const p = fetchAll(kind, id, key)
      .catch((err: unknown) => {
        warnOnce(`load:${key}`, `loading ${kind}/${id} failed — playing silence.`, err);
        absent.add(key);
        return null;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, p);
    return p;
  };

  return {
    load,

    peek(kind: AudioKind, id: string): AudioBuffer | null {
      return ready.get(keyOf(kind, id)) ?? null;
    },

    request(kind: AudioKind, id: string): AudioBuffer | null {
      const key = keyOf(kind, id);
      const done = ready.get(key);
      if (done !== undefined) return done;
      if (!absent.has(key)) void load(kind, id);
      return null;
    },

    missing(kind: AudioKind, id: string): boolean {
      return absent.has(keyOf(kind, id));
    },

    async prefetch(kind: AudioKind, ids: readonly string[]): Promise<void> {
      await Promise.all(ids.map((id) => load(kind, id)));
    },

    clear(): void {
      pending.clear();
      ready.clear();
      absent.clear();
    },
  };
};

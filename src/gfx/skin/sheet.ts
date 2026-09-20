// =============================================================================
// SunForce — src/gfx/skin/sheet.ts
// Sprite sheets: fetch, validate, upload, and resolve (AnimId, frame) -> image.
//
// This file plus sprite.ts is the whole runtime of the SHIPPING render path.
// SunForce renders like Guilty Gear XX: one image per animation frame, blitted
// as one quad. There are no bones here, and nothing in this file may ever
// import gfx/skin/pose.ts. A sheet is a PNG atlas plus
// public/art/<char>.sheet.json in the tool-agnostic `SpriteSheet` format frozen
// in contracts.ts §11b — so the offline rig baker, an artist exporting from
// Aseprite, and hand-drawn art later all produce the same two files.
//
// A MISSING OR BROKEN SHEET IS NOT AN ERROR. `acquireSheet` resolves to NULL —
// never throws, never rejects — when the JSON is absent, unparseable,
// structurally wrong or its PNG will not decode, and says so in exactly one
// console line. The caller falls back to the stick skin, so `npm run dev` boots
// and plays before a single frame of art has been baked.
//
// STRAIGHT ALPHA, DELIBERATELY — read before changing the upload. batch.ts's
// QUAD_FRAG does `texture * tint`, `mix(rgb, white, flash)`, `a *= alpha`: it
// scales ALPHA without scaling RGB and mixes toward full white, both of which
// are straight-alpha operations. On a PREMULTIPLIED texture they break the
// rgb <= a invariant and the hit flash paints a white box over the sprite's
// transparent margin. So the atlas is uploaded with UNPACK_PREMULTIPLY_ALPHA off
// and drawn with the batcher's 'alpha' blend (SRC_ALPHA, ONE_MINUS_SRC_ALPHA),
// the matching pair; changing one without the other is what puts a dark halo
// around every sprite. The baker must also bleed frame colour into its
// transparent texels and pad each frame with >= 1px of gutter, because
// filtering is LINEAR (this art is rich and detailed, never pixel art).
// =============================================================================

import { AnimId, CharId } from '@/core/contracts';
import type { SpriteFrame, SpriteSheet } from '@/core/contracts';
import { devWarn } from '@/core/assert';

/** One clip with its playback table baked flat: `byFrame[simFrame]` indexes
 *  `frames`, so honouring `dur` is one array read per draw — an image with
 *  `dur: 3` simply occupies three entries. */
export interface SheetClip {
  readonly frames: readonly SpriteFrame[];
  readonly byFrame: Int32Array;
  /** Sim frame the loop returns to, or -1 for a one-shot that holds its end. */
  readonly loopFrom: number;
}

/** Sim frames -> image index. `dur` flattened, `loopAt` converted to a frame. */
const buildClip = (frames: readonly SpriteFrame[], loopAt: number): SheetClip | null => {
  if (frames.length === 0) return null;
  let total = 0;
  for (let i = 0; i < frames.length; i++) total += frames[i]!.dur;
  const byFrame = new Int32Array(total);
  let w = 0;
  let loopFrom = -1;
  for (let i = 0; i < frames.length; i++) {
    if (i === loopAt) loopFrom = w;
    const dur = frames[i]!.dur;
    for (let k = 0; k < dur; k++) byFrame[w++] = i;
  }
  return { frames, byFrame, loopFrom };
};

/** The image to show on sim frame `frame`. Out of range NEVER throws: past the
 *  end a looping clip wraps into its loop region and a one-shot holds its last
 *  image — a move whose art is shorter than its frame data still renders.
 *  Negative frames clamp to the first image. */
export const clipFrameAt = (clip: SheetClip, frame: number): SpriteFrame => {
  const n = clip.byFrame.length;
  let f = frame | 0;
  if (f < 0) f = 0;
  else if (f >= n) {
    const from = clip.loopFrom;
    f = from >= 0 && from < n ? from + ((f - from) % (n - from)) : n - 1;
  }
  return clip.frames[clip.byFrame[f]!]!;
};

export class SpriteSheetAsset {
  readonly gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly sheet: SpriteSheet;
  /** Where the JSON came from — also the cache key `releaseSheet` wants. */
  readonly url: string;
  /** Atlas pixels -> world units. */
  readonly unitsPerPx: number;
  /** The DECODED image's size — what the UV divisor must be. */
  readonly texW: number;
  readonly texH: number;

  private readonly byAnim: readonly (SheetClip | null)[];
  private readonly clips: readonly SheetClip[];
  private disposed = false;

  constructor(
    gl: WebGL2RenderingContext, texture: WebGLTexture, sheet: SpriteSheet,
    url: string, texW: number, texH: number,
  ) {
    this.gl = gl;
    this.texture = texture;
    this.sheet = sheet;
    this.url = url;
    this.unitsPerPx = sheet.unitsPerPx;
    this.texW = texW;
    this.texH = texH;

    const built = new Map<string, SheetClip>();
    const all: SheetClip[] = [];
    for (const key of Object.keys(sheet.clips)) {
      const raw = sheet.clips[key];
      if (raw === undefined) continue;
      const clip = buildClip(raw.frames, raw.loopAt);
      if (clip === null) continue;
      built.set(key, clip);
      all.push(clip);
    }
    this.clips = all;

    // Fall back IDLE-ward rather than vanishing: a character whose ATK_2K is not
    // drawn yet must still show a body while the move plays out.
    const idle = built.get(animName(AnimId.IDLE)) ?? all[0] ?? null;
    const byAnim: (SheetClip | null)[] = new Array<SheetClip | null>(AnimId.ANIM_COUNT);
    const missing: string[] = [];
    for (let a = 0; a < AnimId.ANIM_COUNT; a++) {
      const name = animName(a);
      const clip = built.get(name);
      byAnim[a] = clip ?? idle;
      if (clip === undefined && a !== AnimId.NONE) missing.push(name);
    }
    this.byAnim = byAnim;
    if (missing.length > 0) devWarn(`gfx/skin/sheet: ${url} has no clip for ${missing.join(', ')} — drawing IDLE`);
  }

  /** Fallbacks are baked into the table, so this is one index — an undrawn or
   *  out-of-range anim yields IDLE, never an invisible fighter. */
  clipOf(anim: AnimId): SheetClip | null {
    return this.byAnim[anim] ?? this.byAnim[AnimId.IDLE] ?? null;
  }

  /** The image for (anim, frame), or null when the sheet holds no clip at all. */
  frameAt(anim: AnimId, frame: number): SpriteFrame | null {
    const clip = this.clipOf(anim);
    return clip === null ? null : clipFrameAt(clip, frame);
  }

  /** Every distinct image in the sheet. For bounds; not a per-frame call. */
  forEachFrame(visit: (f: SpriteFrame) => void): void {
    for (let c = 0; c < this.clips.length; c++) {
      const frames = this.clips[c]!.frames;
      for (let i = 0; i < frames.length; i++) visit(frames[i]!);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
  }
}

/** AnimId -> the NAME string clips are keyed by ("IDLE", "ATK_5P"). */
const animName = (a: AnimId): string => {
  const n: string | undefined = AnimId[a];
  return n ?? '';
};

// --- validation: every field of a file an artist or a tool wrote -------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isRect = (v: unknown): v is readonly [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]) && isNum(v[3]);

const isPair = (v: unknown): v is readonly [number, number] =>
  Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

/** A frame is dropped, not fatal: one bad rect must not cost the whole sheet. */
const asFrame = (v: unknown, aw: number, ah: number): SpriteFrame | null => {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { readonly uv?: unknown; readonly origin?: unknown; readonly dur?: unknown };
  if (!isRect(o.uv) || !isPair(o.origin)) return null;
  const [x, y, w, h] = o.uv;
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > aw || y + h > ah) return null;
  const dur = isNum(o.dur) ? Math.max(1, Math.round(o.dur)) : 1;
  return { uv: [x, y, w, h], origin: [o.origin[0], o.origin[1]], dur };
};

const asSheet = (raw: unknown, url: string): SpriteSheet | null => {
  const bad = (why: string): null => {
    console.warn(`[sunforce] gfx/skin/sheet: ignoring ${url} — ${why}`);
    return null;
  };
  if (typeof raw !== 'object' || raw === null) return bad('not a JSON object');
  const o = raw as {
    readonly image?: unknown; readonly atlasW?: unknown; readonly atlasH?: unknown;
    readonly unitsPerPx?: unknown; readonly clips?: unknown;
  };
  if (typeof o.image !== 'string' || o.image === '') return bad('no "image"');
  if (!isNum(o.atlasW) || o.atlasW <= 0 || !isNum(o.atlasH) || o.atlasH <= 0) return bad('bad atlas size');
  if (!isNum(o.unitsPerPx) || o.unitsPerPx <= 0) return bad('bad "unitsPerPx"');
  if (typeof o.clips !== 'object' || o.clips === null) return bad('no "clips"');

  const atlasW = o.atlasW;
  const atlasH = o.atlasH;
  const src = o.clips as Readonly<Record<string, unknown>>;
  const clips: Record<string, { frames: SpriteFrame[]; loopAt: number }> = {};
  let kept = 0;
  for (const key of Object.keys(src)) {
    const c = src[key];
    if (typeof c !== 'object' || c === null) continue;
    const cc = c as { readonly frames?: unknown; readonly loopAt?: unknown };
    if (!Array.isArray(cc.frames)) continue;
    const frames: SpriteFrame[] = [];
    for (const fr of cc.frames as readonly unknown[]) {
      const f = asFrame(fr, atlasW, atlasH);
      if (f !== null) frames.push(f);
    }
    if (frames.length === 0) continue;
    const loopAt = isNum(cc.loopAt) && cc.loopAt >= 0 && cc.loopAt < frames.length ? Math.round(cc.loopAt) : -1;
    clips[key] = { frames, loopAt };
    kept++;
  }
  if (kept === 0) return bad('no usable clips');
  return { image: o.image, atlasW, atlasH, unitsPerPx: o.unitsPerPx, clips };
};

// --- fetch + upload ----------------------------------------------------------

/** `public/art/a.sheet.json` as the browser should ask for it. */
export const sheetUrlFor = (char: CharId, dir = 'art'): string => {
  const name = (CharId[char] ?? 'A').toLowerCase();
  return absUrl(`${dir}/${name}.sheet.json`);
};

const absUrl = (rel: string, base?: string): string => {
  const root = base ?? (typeof document === 'undefined' ? 'http://local/' : document.baseURI);
  try {
    return new URL(rel, root).href;
  } catch {
    return rel;
  }
};

/** HTMLImageElement and not createImageBitmap, on purpose: an ImageBitmap's
 *  premultiply state is baked at construction and browsers disagree about
 *  whether UNPACK_PREMULTIPLY_ALPHA_WEBGL still applies to one. An <img> is
 *  decoded straight, so the unpack flags below mean what they say everywhere. */
const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no DOM image decoder')); return; }
    const img = new Image();
    img.onload = (): void => { resolve(img); };
    img.onerror = (): void => { reject(new Error(`could not decode ${url}`)); };
    img.src = url;
  });

const uploadAtlas = (gl: WebGL2RenderingContext, img: HTMLImageElement): WebGLTexture => {
  const tex = gl.createTexture();
  if (tex === null) throw new Error('could not allocate the atlas texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  // LINEAR, and NO mipmaps: a fighter is on screen at roughly its authored size
  // and a mip chain only softens the ink line.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
};

/** One fetch + decode + upload. Resolves null for anything that goes wrong. */
const loadSheet = async (gl: WebGL2RenderingContext, url: string): Promise<SpriteSheetAsset | null> => {
  let raw: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[sunforce] gfx/skin/sheet: no sprite sheet at ${url} (${res.status}) — using the stick skin`);
      return null;
    }
    raw = await res.json();
  } catch (e) {
    console.warn(`[sunforce] gfx/skin/sheet: no sprite sheet at ${url} (${String(e)}) — using the stick skin`);
    return null;
  }

  const sheet = asSheet(raw, url);
  if (sheet === null) return null;

  try {
    const img = await loadImage(absUrl(sheet.image, url));
    if (img.naturalWidth !== sheet.atlasW || img.naturalHeight !== sheet.atlasH) {
      devWarn(
        `gfx/skin/sheet: ${sheet.image} is ${img.naturalWidth}x${img.naturalHeight}, ` +
        `sheet says ${sheet.atlasW}x${sheet.atlasH} — using the image`,
      );
    }
    const tex = uploadAtlas(gl, img);
    return new SpriteSheetAsset(gl, tex, sheet, url, img.naturalWidth, img.naturalHeight);
  } catch (e) {
    console.warn(`[sunforce] gfx/skin/sheet: ${sheet.image} would not load (${String(e)}) — using the stick skin`);
    return null;
  }
};

// --- refcounted cache: a mirror match is ONE atlas, not two ------------------

interface Entry { readonly asset: Promise<SpriteSheetAsset | null>; refs: number }

const CACHE = new WeakMap<WebGL2RenderingContext, Map<string, Entry>>();

/** The sheet at `url` for `gl`, loaded at most once: A vs A shares one texture,
 *  two overlapping loads share one fetch, and a missing sheet stays missing, so
 *  the warning prints once and not per fighter. Balance with `releaseSheet`. */
export const acquireSheet = (gl: WebGL2RenderingContext, url: string): Promise<SpriteSheetAsset | null> => {
  let m = CACHE.get(gl);
  if (m === undefined) {
    m = new Map<string, Entry>();
    CACHE.set(gl, m);
  }
  let e = m.get(url);
  if (e === undefined) {
    e = { asset: loadSheet(gl, url), refs: 0 };
    m.set(url, e);
  }
  e.refs += 1;
  return e.asset;
};

/** Balances one `acquireSheet`. The texture dies with the last holder. */
export const releaseSheet = (gl: WebGL2RenderingContext, url: string): void => {
  const m = CACHE.get(gl);
  const e = m?.get(url);
  if (m === undefined || e === undefined) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  m.delete(url);
  void e.asset.then((a) => { a?.dispose(); });
};

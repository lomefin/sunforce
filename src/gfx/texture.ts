// =============================================================================
// SunForce — src/gfx/texture.ts
// One image URL -> one WebGL2 texture, refcounted. That is the whole file.
//
// gfx/skin/sheet.ts already loads the sprite ATLAS; it owns that path and this
// module deliberately does not touch it. What it does do is copy its
// conventions exactly, because a second loader that disagreed with the first
// about alpha would put a halo around half the game:
//
//   * HTMLImageElement, never createImageBitmap — an ImageBitmap bakes its
//     premultiply state at construction and browsers disagree about whether
//     UNPACK_PREMULTIPLY_ALPHA_WEBGL still applies to one. An <img> is decoded
//     straight, so the unpack flags below mean what they say everywhere.
//   * STRAIGHT ALPHA by default (UNPACK_PREMULTIPLY_ALPHA off), the half of the
//     pair batch.ts's QUAD_FRAG needs: `texture * tint`, `mix(rgb, white,
//     flash)` and `a *= alpha` are all straight-alpha operations, and it is
//     drawn with the batcher's matching 'alpha' blend.
//   * UNPACK_FLIP_Y off (world +y is UP, callers pass v0 > v1 instead), LINEAR,
//     no mipmaps, CLAMP_TO_EDGE. This art is painted, never pixel art.
//   * A MISSING OR BROKEN IMAGE IS NOT AN ERROR. `acquireTexture` resolves to
//     NULL — never throws, never rejects — in exactly one console line per URL,
//     so the caller falls back and the game still runs. Refcounted per
//     (gl, url), so one panorama is one upload and one warning, not one a frame.
// =============================================================================

import { devWarn } from '@/core/assert';

export type TextureFilter = 'linear' | 'nearest';
export type TextureWrap = 'clamp' | 'repeat';

export interface TextureOptions {
  /** Default 'linear'. */
  readonly filter?: TextureFilter;
  /** Default 'clamp'. WebGL2 allows 'repeat' on NPOT images. */
  readonly wrap?: TextureWrap;
  /** Default false = straight alpha. Read the header before turning it on. */
  readonly premultiply?: boolean;
}

const filterOf = (o: TextureOptions): TextureFilter => o.filter ?? 'linear';
const wrapOf = (o: TextureOptions): TextureWrap => o.wrap ?? 'clamp';
const premultiplyOf = (o: TextureOptions): boolean => o.premultiply ?? false;

/** Cache identity for a set of options. */
const signature = (o: TextureOptions): string =>
  `${filterOf(o)}/${wrapOf(o)}/${premultiplyOf(o) ? 'premul' : 'straight'}`;

/** An uploaded image. `width`/`height` are the DECODED pixel size — what a UV
 *  divisor or an aspect ratio must be derived from. */
export class Texture2D {
  readonly gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly url: string;
  readonly width: number;
  readonly height: number;

  private disposed = false;

  constructor(gl: WebGL2RenderingContext, texture: WebGLTexture, url: string, width: number, height: number) {
    this.gl = gl;
    this.texture = texture;
    this.url = url;
    this.width = width;
    this.height = height;
  }

  /** Pixel aspect, or 1 for a degenerate image. Never divides by zero. */
  get aspect(): number {
    return this.height > 0 ? this.width / this.height : 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.texture);
  }
}

/** A path under public/ as the browser should ask for it ("art/stages/x.png"). */
export const assetUrl = (rel: string, base?: string): string => {
  const root = base ?? (typeof document === 'undefined' ? 'http://local/' : document.baseURI);
  try {
    return new URL(rel, root).href;
  } catch {
    return rel;
  }
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no DOM image decoder')); return; }
    const img = new Image();
    img.onload = (): void => { resolve(img); };
    img.onerror = (): void => { reject(new Error(`could not decode ${url}`)); };
    img.src = url;
  });

const upload = (gl: WebGL2RenderingContext, img: HTMLImageElement, o: TextureOptions): WebGLTexture => {
  const tex = gl.createTexture();
  if (tex === null) throw new Error('could not allocate the texture');
  const filter = filterOf(o) === 'nearest' ? gl.NEAREST : gl.LINEAR;
  const wrap = wrapOf(o) === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplyOf(o) ? 1 : 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  // Leave the unpack flags as the rest of the engine expects to find them.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
};

/** One decode + upload. Resolves null for anything that goes wrong. */
const loadTexture = async (
  gl: WebGL2RenderingContext, url: string, o: TextureOptions,
): Promise<Texture2D | null> => {
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w <= 0 || h <= 0) {
      console.warn(`[sunforce] gfx/texture: ${url} decoded to ${w}x${h} — ignoring it`);
      return null;
    }
    return new Texture2D(gl, upload(gl, img, o), url, w, h);
  } catch (e) {
    console.warn(`[sunforce] gfx/texture: no image at ${url} (${String(e)}) — the caller falls back`);
    return null;
  }
};

interface Entry { readonly asset: Promise<Texture2D | null>; readonly sig: string; refs: number }

const CACHE = new WeakMap<WebGL2RenderingContext, Map<string, Entry>>();

/**
 * The texture at `url` for `gl`, loaded at most once: two overlapping loads
 * share one decode, and a missing file stays missing so the warning prints
 * once. `opts` are honoured on the FIRST acquire of a URL; a later, differing
 * one gets what is already uploaded and says so. Balance with `releaseTexture`.
 */
export const acquireTexture = (
  gl: WebGL2RenderingContext, url: string, opts: TextureOptions = {},
): Promise<Texture2D | null> => {
  let m = CACHE.get(gl);
  if (m === undefined) {
    m = new Map<string, Entry>();
    CACHE.set(gl, m);
  }
  const sig = signature(opts);
  let e = m.get(url);
  if (e === undefined) {
    e = { asset: loadTexture(gl, url, opts), sig, refs: 0 };
    m.set(url, e);
  } else if (e.sig !== sig) {
    devWarn(`gfx/texture: ${url} is already uploaded as ${e.sig}, not ${sig} — reusing it`);
  }
  e.refs += 1;
  return e.asset;
};

/** Balances one `acquireTexture`. The texture dies with the last holder, even
 *  if that happens while the load is still in flight. */
export const releaseTexture = (gl: WebGL2RenderingContext, url: string): void => {
  const m = CACHE.get(gl);
  const e = m?.get(url);
  if (m === undefined || e === undefined) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  m.delete(url);
  void e.asset.then((t) => { t?.dispose(); });
};

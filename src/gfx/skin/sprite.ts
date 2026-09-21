// =============================================================================
// SunForce — src/gfx/skin/sprite.ts
// `SkinSprite implements CharacterSkin` with kind 'sprite': the sprite blitter.
//
// ONE INSTANCE PER FIGHTER PER FRAME. `emit` looks up (anim, frame) in the
// sheet, works out where that image's `origin` has to land, and pushes a single
// textured quad. It IGNORES the PoseBuffer it is handed — there is no skeleton
// on this path, no capsules, no per-limb sorting, and this file must never
// import gfx/skin/pose.ts. When hand-drawn art replaces the baked PNG, nothing
// below changes.
//
// WHY THERE IS NO NEW SHADER. batch.ts's built-in quad program already does
// exactly what a sprite needs — sample the albedo through the instance's UV
// rect, multiply by the tint, mix to white by `flash`, scale by `alpha` — so
// this file links that same QUAD_VERT/QUAD_FRAG source against its own atlas
// texture instead of inventing a second program.
//
// FACING IS ONE NEGATED COLUMN. The quad's width is negated ABOUT THE ORIGIN, so
// a fighter mirrors around its own feet and never slides sideways on turn. The
// UV rect is NOT swapped as well: negating the geometry and swapping u0/u1 are
// two ways to spell the same mirror, so doing both cancels out and yields an
// unflipped sprite in a shifted box. The texture is never flipped at load time
// and there is never a second atlas.
// =============================================================================

import { fx } from '@/core/fixed';
import type {
  CharId, CharacterSkin, FxBox, InstanceWriter, PoseBuffer, SkinDrawOpts,
} from '@/core/contracts';
import { I, QUAD_FRAG, QUAD_VERT, makeMaterial, writeSprite } from '@/gfx/batch';
import type { Material } from '@/gfx/batch';
import { createProgram } from '@/gfx/programs';
import type { ShaderProgram } from '@/gfx/programs';
import { acquireSheet, releaseSheet, sheetUrlFor } from '@/gfx/skin/sheet';
import type { SpriteSheetAsset } from '@/gfx/skin/sheet';

/** Batching keys for sprite atlases: SPRITE_MATERIAL_BASE + CharId. Declared
 *  here rather than in batch.ts's MATERIAL_KEY, clear of every key reserved
 *  there (the highest is PARTS_BASE + CharId.F = 21). */
export const SPRITE_MATERIAL_BASE = 64;

// --- the shared program: one per GL context, refcounted. Every character's ---
// --- sheet is drawn with it; only the bound texture differs. -----------------

interface Shared { readonly program: ShaderProgram; refs: number }
const SHARED = new WeakMap<WebGL2RenderingContext, Shared>();

const acquireSpriteProgram = (gl: WebGL2RenderingContext): ShaderProgram => {
  let e = SHARED.get(gl);
  if (e === undefined) {
    e = {
      program: createProgram(gl, { name: 'sprite', vert: QUAD_VERT, frag: QUAD_FRAG, samplers: { uAlbedo: 0 } }),
      refs: 0,
    };
    SHARED.set(gl, e);
  }
  e.refs += 1;
  return e.program;
};

const releaseSpriteProgram = (gl: WebGL2RenderingContext): void => {
  const e = SHARED.get(gl);
  if (e === undefined) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  SHARED.delete(gl);
  e.program.dispose();
};

/** The P2 colourway, as a multiply: a tint cannot swap channels the way the
 *  stick palette does, so the mirror-match fighter is cooled toward cobalt,
 *  enough to tell two identical silhouettes apart. Real per-costume art
 *  replaces this with a second atlas, not with a different number here. */
const COSTUME: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [0.70, 0.84, 1.34],
];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface SpriteSkinOptions {
  /** Overrides `public/art/<char>.sheet.json`. Mostly for tests. */
  readonly url?: string;
}

export class SkinSprite implements CharacterSkin {
  readonly kind = 'sprite' as const;
  readonly charId: CharId;
  readonly materialKey: number;
  readonly sheet: SpriteSheetAsset;

  private readonly bounds: FxBox;
  private gl: WebGL2RenderingContext | null = null;
  private mat: Material | null = null;
  private disposed = false;

  constructor(charId: CharId, sheet: SpriteSheetAsset) {
    this.charId = charId;
    this.sheet = sheet;
    this.materialKey = SPRITE_MATERIAL_BASE + charId;

    // Local bounds: the union of every image, placed by its own origin. +x is
    // FORWARD and +y UP, origin = feet centre on the ground line, which is the
    // frame's origin pixel by definition.
    const u = sheet.unitsPerPx;
    let minX = 0; let maxX = 0; let minY = 0; let maxY = 0;
    let any = false;
    sheet.forEachFrame((f) => {
      const x0 = -f.origin[0] * u;
      const x1 = (f.uv[2] - f.origin[0]) * u;
      const y1 = f.origin[1] * u;
      const y0 = y1 - f.uv[3] * u;
      if (!any) { minX = x0; maxX = x1; minY = y0; maxY = y1; any = true; return; }
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
    });
    this.bounds = { x: fx(minX), y: fx(minY), w: fx(maxX - minX), h: fx(maxY - minY) };
  }

  load(gl: WebGL2RenderingContext): Promise<void> {
    if (!this.disposed && this.mat === null) {
      this.gl = gl;
      this.mat = makeMaterial(this.materialKey, acquireSpriteProgram(gl), {
        albedo: this.sheet.texture,
        blend: 'alpha',
      });
    }
    return Promise.resolve();
  }

  /** The material to bind before `emit`. Null until `load` has run. */
  get material(): Material | null {
    return this.mat;
  }

  /** `pose` is deliberately unused: this draws an IMAGE, not a skeleton. */
  emit(out: InstanceWriter, _pose: PoseBuffer, o: SkinDrawOpts): void {
    const sheet = this.sheet;
    const f = sheet.frameAt(o.anim, o.frame);
    if (f === null) return;

    const alpha = clamp01(o.alpha) * clamp01(o.tint[3]);
    if (alpha <= 0) return;

    const u = sheet.unitsPerPx;
    const [fx0, fy0, fw, fh] = f.uv;
    const [ox, oy] = f.origin;

    // The pivot lands on the fighter's world origin, shake included. origin.x
    // counts from the frame's LEFT and origin.y from its TOP, so the quad's
    // bottom-left corner sits ox left of the pivot and (h - oy) below it.
    // Facing -1 mirrors that about the pivot: same corner, negated width, and
    // `writeSprite`'s first column IS the width, so nothing else moves.
    const wx = o.worldX + o.shakeX;
    const wy = o.worldY + o.shakeY;
    const back = o.facing < 0;
    const x = back ? wx + ox * u : wx - ox * u;
    const w = back ? -fw * u : fw * u;
    const y = wy - (fh - oy) * u;

    // Atlas pixels -> UV. The quad's (0,0) corner is its BOTTOM-left and the
    // atlas is y-down, so v0 is the rect's BOTTOM edge and v0 > v1.
    //
    // INSET BY HALF A TEXEL on every side. The filter is LINEAR and the sheet
    // is an ATLAS, so a UV sitting exactly on a frame boundary blends the edge
    // column with whatever is outside the frame — CLAMP_TO_EDGE clamps to the
    // ATLAS, not to the rect, so it does not help here. The builder's 4px
    // gutter keeps that neighbour transparent rather than another pose, but a
    // half-lit seam column is still wrong, and it is worse under the facing
    // mirror below: a negative width flips the rasterisation, so the side that
    // samples past the edge is the side that was fine before.
    //
    // Costs half a texel of the frame at 0.45 scale — well under a screen
    // pixel, and it cannot be seen. The seam can.
    const tw = sheet.texW; const th = sheet.texH;
    const u0 = (fx0 + 0.5) / tw;
    const u1 = (fx0 + fw - 0.5) / tw;
    const v0 = (fy0 + fh - 0.5) / th;
    const v1 = (fy0 + 0.5) / th;

    const c = COSTUME[o.costume] ?? COSTUME[0]!;
    const i = writeSprite(
      out, x, y, w, fh * u, u0, v0, u1, v1,
      o.tint[0] * c[0], o.tint[1] * c[1], o.tint[2] * c[2], 1, o.zBase,
    );
    // writeSprite leaves the FX slot neutral; flash and fade go straight in.
    i[I.FLASH] = clamp01(o.flash);
    i[I.ALPHA] = alpha;
    i[I.GLINT] = o.glintPhase;
  }

  localBounds(): FxBox {
    return this.bounds;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl !== null && this.mat !== null) releaseSpriteProgram(gl);
    // The sheet is refcounted on its OWN context, and is released even if this
    // skin was built but never loaded — otherwise a swapped-out fighter leaks.
    releaseSheet(this.sheet.gl, this.sheet.url);
    this.gl = null;
    this.mat = null;
  }
}

/** The sprite skin for `char`, or NULL when that character has no baked sheet —
 *  the caller then keeps the stick skin and the game runs exactly as it did.
 *  Never throws, never rejects. */
export const loadSpriteSkin = async (
  gl: WebGL2RenderingContext, char: CharId, opts: SpriteSkinOptions = {},
): Promise<SkinSprite | null> => {
  const url = opts.url ?? sheetUrlFor(char);
  const sheet = await acquireSheet(gl, url);
  if (sheet === null) return null;
  const skin = new SkinSprite(char, sheet);
  await skin.load(gl);
  return skin;
};

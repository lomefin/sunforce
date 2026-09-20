// =============================================================================
// SunForce — src/gfx/stage.ts
// The painted stage backdrop: ONE textured quad per frame, parallaxed, drawn
// behind everything else through the QuadBatch.
//
// GEOMETRY. World: x in [0, width], ground at y = 0, ceiling 900, y is UP. The
// painting carries its own horizon and its own ground, so the ONE number that
// matters is where its ground line sits inside the image:
//
//   GROUND_V = 0.73   fraction from the TOP of the image down to world y = 0.
//   BG_H     = 1400   world units tall  =>  top +1218, bottom -182.
//   BG_W     = BG_H * (image width / image height), from the DECODED image and
//              never assumed, so no stage art can ever be stretched. stage-1.png
//              is 2172x724 = exactly 3:1, so BG_W = 4200.
//
// The quad is anchored in WORLD Y and never moves vertically: the tiles the
// fighters stand on must stay registered to y = 0 whatever the camera does.
// Only X is parallaxed, about the middle of the stage —
//   bgCentreX = C + (camX - C) * (1 - p),  C = width/2, p = BG_PARALLAX
// — which makes the art's apparent motion exactly p times the camera's.
//
// THE SKIRT. camera.ts clamps the view to y >= -170 and applies shake AFTER the
// clamp, so a hard hit can push the view past every clamped limit. BG_SKIRT
// world units are added on all four sides with the UV rect extended by the same
// fraction: with CLAMP_TO_EDGE that skirt is the edge pixels smeared outward
// (sky above, the nearest tile row below), while the art INSIDE it keeps
// exactly the scale and position above — the ground line lands on y = 0 to the
// pixel. `backdropCoverage` proves the margins; on stage 1 at the worst camera
// position and zoom 0.80 they are 810 left and right, 132 below and 158 above,
// against a largest possible shake of 241 x and 85 y.
// =============================================================================

import { StageId } from '@/core/contracts';
import type { StageDef, StageLayer } from '@/core/contracts';
import { devWarn } from '@/core/assert';
import { MATERIAL_KEY, makeMaterial, writeSprite } from '@/gfx/batch';
import type { Material, QuadBatch } from '@/gfx/batch';
import { BASE_H, BASE_W, ZOOM_MIN } from '@/gfx/camera';
import { acquireTexture, assetUrl, releaseTexture } from '@/gfx/texture';
import type { Texture2D } from '@/gfx/texture';

/** Fraction from the top of the image down to the ground line, world y = 0. */
export const GROUND_V = 0.73;
/** World units the painting is tall. */
export const BG_H = 1400;
/** 0 = infinitely far, 1 = the play plane. */
export const BG_PARALLAX = 0.35;
/** Clamp-to-edge overscan on all four sides, world units. */
export const BG_SKIRT = 120;

/** Mirrors camera.ts's private FLOOR_BLEED: floor kept visible below y = 0. */
const CAM_FLOOR_BLEED = 170;
/** events.ts packs shakeAmp into 8 bits (<= 255) and camera.ts shakes along
 *  (±1, 0.35) normalised, so |shakeX| <= 241 and |shakeY| <= 85. */
const MAX_SHAKE_X = 241;
const MAX_SHAKE_Y = 85;
/** Painter's order is what actually orders the batch; this matches the
 *  renderer's own stage numbering for the day a depth-sorting program lands. */
const BACKDROP_Z = -1000;

// --- where the numbers come from ---------------------------------------------
// The stage data owns its own art and states it as a StageLayer: `texture`,
// `parallax`, `scale` = world units per SOURCE PIXEL, `yOffset` = the quad's
// CENTRE y. Height and the ground line follow the moment the image is decoded —
// height = scale * imageH, groundV = (centreY + height/2) / height — which is
// why nothing here assumes an aspect. A stage that says nothing, or says
// something out of range, gets the constants above.

export interface StageBackdropSpec {
  /** Path under public/, e.g. "art/stages/stage-1.png". */
  readonly image: string;
  readonly parallax: number;
  /** World units tall and image v of y = 0, when the layer form is absent. */
  readonly height: number;
  readonly groundV: number;
  /** World units per source pixel (0 = no layer) and the quad's centre y. */
  readonly unitsPerPx: number;
  readonly centreY: number;
}

const inRange = (v: number, lo: number, hi: number, what: string): boolean => {
  if (Number.isFinite(v) && v >= lo && v <= hi) return true;
  devWarn(`gfx/stage: ${what} ${v} is outside [${lo}, ${hi}] — using the default`);
  return false;
};

/** Art root, matching sheet.ts's `sheetUrlFor` default: public/art/<texture>. */
const artUrl = (tex: string): string =>
  tex.startsWith('/') || tex.startsWith('art/') || tex.includes('://') ? tex : `art/${tex}`;

/** The one painted panorama among a stage's layers: behind the play plane, not
 *  a reflection strip, not foreground. EXACTLY one must qualify — a stage still
 *  described as a stack of strips has no single backdrop. */
const panoramaLayerOf = (def: StageDef): StageLayer | null => {
  let found: StageLayer | null = null;
  for (const L of def.layers) {
    if (L.drawOverFighters === true || (L.reflect ?? 0) > 0 || L.parallax >= 1) continue;
    if (found !== null) return null;
    found = L;
  }
  return found;
};

/** CONVENTION, like musicId: public/art/stages/<stage-id>.png, so a stage that
 *  says nothing about its art still gets its art. */
export const defaultBackdropImage = (id: StageId): string =>
  `art/stages/${(StageId[id] ?? 'STAGE_1').toLowerCase().replace(/_/g, '-')}.png`;

/** The backdrop numbers for a stage: whatever the data says, else the defaults. */
export const backdropSpecOf = (def: StageDef): StageBackdropSpec => {
  const L = panoramaLayerOf(def);
  const image = L !== null && L.texture !== '' ? artUrl(L.texture) : defaultBackdropImage(def.id);
  const parallax = L !== null && inRange(L.parallax, 0, 1, 'layer parallax') ? L.parallax : BG_PARALLAX;
  const scaled = L !== null && inRange(L.scale, 0.0001, 1000, 'layer scale');
  return {
    image,
    parallax,
    height: BG_H,
    groundV: GROUND_V,
    unitsPerPx: scaled && L !== null ? L.scale : 0,
    centreY: L !== null ? L.yOffset : 0,
  };
};

// --- coverage: pure arithmetic, no GL, so it can be checked headless ---------

/** World units of backdrop outside the worst-case view on each side. All four
 *  must stay above the shake bounds or a gap can open at the screen edge. */
export interface BackdropCoverage {
  readonly left: number;
  readonly right: number;
  readonly below: number;
  readonly above: number;
  readonly ok: boolean;
}

/**
 * The tightest margin over every legal camera position and zoom.
 *
 * X: the camera clamps x to [halfW, width - halfW], so |camX - C| <= width/2 -
 * halfW while the quad's edge sits BG_W/2 + skirt from a centre that moved only
 * (1 - p) as far: margin = BG_W/2 + skirt - halfW - p * (width/2 - halfW),
 * worst at the widest view (zoom 0.80). Y: the clamp holds the view bottom at
 * or above -FLOOR_BLEED and the top at or below max(ceiling, -FLOOR_BLEED +
 * BASE_H / ZOOM_MIN) — the second term is the case where the stage is shorter
 * than the widest view and the clamp gives up and pins the floor.
 */
export const backdropCoverage = (
  stageWidth: number, ceiling: number, bgW: number, bgH: number, groundV: number, parallax: number,
): BackdropCoverage => {
  const halfW = BASE_W / (2 * ZOOM_MIN);
  const reach = Math.max(stageWidth * 0.5 - halfW, 0);
  const marginX = bgW * 0.5 + BG_SKIRT - halfW - parallax * reach;

  const viewBottom = -CAM_FLOOR_BLEED;
  const viewTop = Math.max(ceiling, -CAM_FLOOR_BLEED + BASE_H / ZOOM_MIN);
  const below = viewBottom - (-(1 - groundV) * bgH - BG_SKIRT);
  const above = groundV * bgH + BG_SKIRT - viewTop;

  return {
    left: marginX,
    right: marginX,
    below,
    above,
    ok: marginX >= MAX_SHAKE_X && below >= MAX_SHAKE_Y && above >= MAX_SHAKE_Y,
  };
};

/** World size and ground line, known only once the image is decoded: the layer
 *  form is per SOURCE pixel, so the aspect is the image's and never stretches. */
const resolveGeometry = (
  s: StageBackdropSpec, tex: Texture2D,
): { readonly w: number; readonly h: number; readonly groundV: number } => {
  if (s.unitsPerPx > 0) {
    const h = s.unitsPerPx * tex.height;
    const gv = h > 0 ? (s.centreY + h * 0.5) / h : 0;
    if (h > 0 && gv > 0.01 && gv < 0.99) return { w: s.unitsPerPx * tex.width, h, groundV: gv };
    devWarn(`gfx/stage: ${s.image} layer geometry gives groundV ${gv.toFixed(3)} — using ${s.groundV}`);
  }
  return { w: s.height * tex.aspect, h: s.height, groundV: s.groundV };
};

// --- StageBackdrop -----------------------------------------------------------

/**
 * Loads a stage's painted panorama and draws it as one quad. Construction
 * starts the load and returns at once; `draw` returns FALSE until the image is
 * up, and forever if it never arrives — the renderer's cue to keep drawing its
 * own flat bands. Nothing here throws.
 */
export class StageBackdrop {
  readonly gl: WebGL2RenderingContext;
  readonly stageId: StageId;
  readonly spec: StageBackdropSpec;
  /** The absolute URL the browser was asked for — also the release key. */
  readonly url: string;

  private tex: Texture2D | null = null;
  private material: Material | null = null;
  private state: 'loading' | 'ready' | 'failed' = 'loading';
  private readonly centreX: number;
  private readonly stageWidth: number;
  private readonly ceiling: number;
  /** Per-stage tint / time-of-day hook. RGBA multiplied into the art. */
  private readonly tint = new Float32Array([1, 1, 1, 1]);
  private bgW = 0;
  private bgH = BG_H;
  private groundV = GROUND_V;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext, def: StageDef) {
    this.gl = gl;
    this.stageId = def.id;
    this.spec = backdropSpecOf(def);
    this.url = assetUrl(this.spec.image);
    this.centreX = def.width * 0.5;
    this.stageWidth = def.width;
    this.ceiling = def.ceiling;

    void acquireTexture(gl, this.url).then((t) => { this.adopt(t); });
  }

  private adopt(t: Texture2D | null): void {
    if (this.disposed) return;
    if (t === null) {
      this.state = 'failed';
      return;
    }
    const g = resolveGeometry(this.spec, t);
    this.tex = t;
    this.bgW = g.w;
    this.bgH = g.h;
    this.groundV = g.groundV;
    this.state = 'ready';

    const c = backdropCoverage(
      this.stageWidth, this.ceiling, g.w, g.h, g.groundV, this.spec.parallax,
    );
    if (!c.ok) {
      devWarn(
        `gfx/stage: ${this.spec.image} covers the view by only ` +
        `${c.left.toFixed(0)}x / ${c.below.toFixed(0)} below / ${c.above.toFixed(0)} above — ` +
        'a hard shake can show past its edge',
      );
    }
  }

  get status(): 'loading' | 'ready' | 'failed' {
    return this.state;
  }

  /** True while the renderer must draw its own flat bands instead. */
  get usingFallback(): boolean {
    return this.state !== 'ready';
  }

  /** Time-of-day / per-stage grade. 1,1,1,1 is the painting untouched. */
  setTint(r: number, g: number, b: number, a = 1): void {
    this.tint[0] = r;
    this.tint[1] = g;
    this.tint[2] = b;
    this.tint[3] = a;
  }

  private materialFor(batch: QuadBatch, tex: WebGLTexture): Material {
    const m = this.material;
    if (m !== null && m.program === batch.solid && m.albedo === tex) return m;
    const next = makeMaterial(MATERIAL_KEY.STAGE, batch.solid, { albedo: tex, blend: 'alpha' });
    this.material = next;
    return next;
  }

  /**
   * Pushes the backdrop quad. Call it FIRST in the frame — the batch is a
   * painter, so whatever is pushed after this lands in front of it. `camX` is
   * the camera's unshaken x (`camera.x`): the quad is in world space, so shake
   * moves the whole view including the painting, which is what a screen shake
   * is. Returns false when there is nothing to draw, pushing nothing at all in
   * that case, so the caller's fallback is a plain `if`.
   */
  draw(batch: QuadBatch, camX: number): boolean {
    const tex = this.tex;
    if (tex === null || this.state !== 'ready') return false;

    const p = this.spec.parallax;
    const h = this.bgH;
    const w = this.bgW;
    const centre = this.centreX + (camX - this.centreX) * (1 - p);
    // Skirt in UV space: the same fraction of the image the skirt is of the quad.
    const su = BG_SKIRT / w;
    const sv = BG_SKIRT / h;

    batch.use(this.materialFor(batch, tex.texture));
    writeSprite(
      batch,
      centre - w * 0.5 - BG_SKIRT, -(1 - this.groundV) * h - BG_SKIRT,
      w + BG_SKIRT * 2, h + BG_SKIRT * 2,
      // (u0, v0) lands on the quad's (x, y) = its BOTTOM-left corner, and the
      // image's bottom row is v = 1, so v runs downward: 1 + sv -> -sv.
      -su, 1 + sv, 1 + su, -sv,
      this.tint[0]!, this.tint[1]!, this.tint[2]!, this.tint[3]!,
      BACKDROP_Z,
    );
    return true;
  }

  /** Drops this holder's reference. Safe mid-load, safe twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tex = null;
    this.material = null;
    this.state = 'failed';
    releaseTexture(this.gl, this.url);
  }
}

export const createStageBackdrop = (gl: WebGL2RenderingContext, def: StageDef): StageBackdrop =>
  new StageBackdrop(gl, def);

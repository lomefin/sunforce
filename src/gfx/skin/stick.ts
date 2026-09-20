// =============================================================================
// SunForce — src/gfx/skin/stick.ts
// `SkinStick implements CharacterSkin`: the placeholder skin, drawn well.
//
// -----------------------------------------------------------------------------
// WHAT THIS FILE IS ALLOWED TO KNOW
// -----------------------------------------------------------------------------
// Everything stick-specific lives HERE. The rest of the renderer sees only
// `CharacterSkin` — kind / charId / materialKey / load / emit / localBounds /
// dispose — so gfx/skin/parts.ts drops in later against the same five calls and
// the same solved PoseBuffer. Nothing below leaks a capsule, a radius or a
// palette upward, and nothing above needs to know this is a stick figure.
//
// -----------------------------------------------------------------------------
// HOW IT DRAWS
// -----------------------------------------------------------------------------
// One PASS over a precomputed op list, built once at construction from the rest
// skeleton and `StickDef`, sorted by painter z. Per frame the ops are only
// transformed — no allocation, no sorting, no branching on character data.
//
//   * A limb exists between every bone and its parent when BOTH have a radius,
//     which is the whole skeleton and nothing else: `radii[ROOT] = 0` kills the
//     ground-to-hip wedge, `radii[HEADWEAR] = 0` leaves the hat to its proxy.
//   * The limb's z is the CHILD's BONE_Z, so the back clavicle sinks behind the
//     torso and the head rises in front of the front arm with no special cases,
//     and a facing flip stays correct because B/F is not left/right.
//   * Anything at z below the hip is DEPTH-DARKENED. That one rule is what makes
//     a flat stick figure read as having a near side and a far side.
//   * Boots, fists, the brow mark and the ground shadow are ops like any other.
//   * ACCESSORY PROXIES are mandatory: every `StickDef.accessories` entry is
//     built as its declared shape from real measured concept-sheet bounds, in
//     its ACC bone's local frame, so it inherits the bone's pose AND its jiggle
//     spring. Mirrored entries are a second op set at negated local x.
//
// The stick PROGRAM (gfx/shaders/stick.ts) does not use the instance z for
// depth — `gl_Position.z` is 0 — so painter order IS push order. The op list is
// therefore kept sorted by z and emitted in order. Both fighters share one
// program, so a whole match is one draw call.
// =============================================================================

import { never } from '@/core/assert';
import { BONE_COUNT, BONE_PARENTS, BONE_Z, Bone } from '@/core/contracts';
import type {
  CharId, CharacterSkin, CompiledChar, ConceptBox, ConceptSpace, FxBox,
  InstanceWriter, PoseBuffer, SkinDrawOpts, StickDef,
} from '@/core/contracts';
import { MATERIAL_KEY } from '@/gfx/batch';
import type { Material } from '@/gfx/batch';
import { createStickMaterial, stickStyleFromPalette, writeStickCapsule } from '@/gfx/shaders/stick';
import type { StickStyle } from '@/gfx/shaders/stick';
import {
  boneScale, boneWorldPos, boundsToFxBox, createBounds, restBounds, restPoseOf, transformPoint,
} from '@/gfx/skin/pose';
import type { Bounds, RestPose, Vec2 } from '@/gfx/skin/pose';

// -----------------------------------------------------------------------------
// The shared GL program. Two fighters, one material, one draw call.
// -----------------------------------------------------------------------------

interface Shared { readonly material: Material; refs: number }
const SHARED = new WeakMap<WebGL2RenderingContext, Shared>();

/** The stick material for `gl`, created on first use and reference counted. */
export const acquireStickMaterial = (gl: WebGL2RenderingContext): Material => {
  let e = SHARED.get(gl);
  if (e === undefined) {
    e = { material: createStickMaterial(gl), refs: 0 };
    SHARED.set(gl, e);
  }
  e.refs += 1;
  return e.material;
};

/** Balances one `acquireStickMaterial`. The program dies with the last holder. */
export const releaseStickMaterial = (gl: WebGL2RenderingContext): void => {
  const e = SHARED.get(gl);
  if (e === undefined) return;
  e.refs -= 1;
  if (e.refs > 0) return;
  SHARED.delete(gl);
  e.material.program.dispose();
};

// -----------------------------------------------------------------------------
// Colour — presentation floats, never sim state.
// -----------------------------------------------------------------------------

const byte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

const mixRGB = (hex: number, to: number, t: number): number =>
  (byte(((hex >> 16) & 0xff) + (((to >> 16) & 0xff) - ((hex >> 16) & 0xff)) * t) << 16) |
  (byte(((hex >> 8) & 0xff) + (((to >> 8) & 0xff) - ((hex >> 8) & 0xff)) * t) << 8) |
  byte((hex & 0xff) + ((to & 0xff) - (hex & 0xff)) * t);

const lighten = (hex: number, t: number): number => mixRGB(hex, 0xffffff, t);
const darken = (hex: number, t: number): number => mixRGB(hex, 0x120c10, t);

/** Costume 1: the mirror-match colourway. Swapping R and B turns the Caporal's
 *  carmine into cobalt and its gold into steel, and leaves whites white. */
const swapRB = (hex: number): number =>
  ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff);

// -----------------------------------------------------------------------------
// Ops
// -----------------------------------------------------------------------------

/**
 * One capsule. Either JOINT mode (`local === false`: the segment between two
 * solved bones) or LOCAL mode (both endpoints in `bone`'s own frame, which is
 * how anything that is not a limb — boots, fists, every accessory proxy — rides
 * its bone's rotation, scale and jiggle for free).
 */
interface DrawOp {
  readonly bone: Bone;
  readonly tip: Bone;
  readonly local: boolean;
  readonly ax: number; readonly ay: number;
  readonly bx: number; readonly by: number;
  readonly r0: number; readonly r1: number;
  readonly ink: number;
  readonly col0: number; readonly col1: number;
  readonly z: number;
  /** Glint phase offset in radians, or -1 for a surface that does not shimmer. */
  readonly glint: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Build-time context for one accessory proxy. */
interface AccCtx {
  readonly ops: DrawOp[];
  readonly bone: Bone;
  readonly color: number;
  readonly ink: number;
  readonly z: number;
  readonly depth: number;
}

type AccShape = StickDef['accessories'][number]['shape'];

const NO_GLINT = -1;

const pushOp = (
  ops: DrawOp[], bone: Bone, tip: Bone, local: boolean,
  ax: number, ay: number, bx: number, by: number,
  r0: number, r1: number, ink: number, col: number, z: number, glint: number,
): void => {
  ops.push({
    bone, tip, local, ax, ay, bx, by, r0, r1, ink,
    col0: col, col1: swapRB(col), z, glint,
  });
};

/** One element of an accessory proxy, in its bone's local frame. */
const acc = (
  c: AccCtx, ax: number, ay: number, bx: number, by: number,
  r0: number, r1: number, dz: number, col: number,
): void => {
  const phase = (c.ops.length % 8) * 0.83;
  pushOp(c.ops, c.bone, c.bone, true, ax, ay, bx, by, r0, r1, c.ink,
    darken(col, c.depth), c.z + dz, phase);
};

// -----------------------------------------------------------------------------
// Accessory proxy shapes. Crude by design, honest in silhouette: every one is
// sized from the sheet's own measured group bounds.
// -----------------------------------------------------------------------------

/** Tapered blades radiating from the box's bottom centre. fan / plume / horns. */
const spray = (
  c: AccCtx, b: Box, count: number, halfSpread: number,
  lenK: number, r0k: number, r1k: number, tuft: number,
): void => {
  const w = b.x1 - b.x0;
  const ox = (b.x0 + b.x1) * 0.5;
  const oy = b.y0;
  const len = (b.y1 - b.y0) * lenK;
  for (let i = 0; i < count; i++) {
    const t = count < 2 ? 0 : (i / (count - 1)) * 2 - 1;
    const a = Math.PI * 0.5 - t * halfSpread;
    const tx = ox + Math.cos(a) * len;
    const ty = oy + Math.sin(a) * len;
    const col = i % 2 === 0 ? c.color : lighten(c.color, 0.14);
    acc(c, ox, oy, tx, ty, w * r0k, w * r1k, i, col);
    if (tuft > 0) acc(c, tx, ty, tx, ty, w * r1k * tuft, w * r1k * tuft, i + 1, lighten(c.color, 0.22));
  }
};

/** Vertical cloth slats, optionally splaying toward the hem. apron / skirt. */
const panel = (c: AccCtx, b: Box, slats: number, splay: number): void => {
  const cx = (b.x0 + b.x1) * 0.5;
  const r = (b.x1 - b.x0) / (slats * 2);
  for (let i = 0; i < slats; i++) {
    const x = b.x0 + r + i * 2 * r;
    const xb = cx + (x - cx) * (1 + splay);
    const col = i % 2 === 0 ? c.color : darken(c.color, 0.12);
    acc(c, x, b.y1 - r, xb, b.y0 + r, r, r * (1 + splay * 0.6), i % 2, col);
  }
};

/** A rounded slab filling the box horizontally. band / shell. */
const slab = (c: AccCtx, b: Box, rk: number, dz: number, col: number): void => {
  const cy = (b.y0 + b.y1) * 0.5;
  const r = (b.y1 - b.y0) * 0.5 * rk;
  acc(c, b.x0 + r, cy, b.x1 - r, cy, r, r, dz, col);
};

const addShape = (c: AccCtx, shape: AccShape, b: Box): void => {
  const hw = (b.x1 - b.x0) * 0.5;
  const hh = (b.y1 - b.y0) * 0.5;
  const cx = (b.x0 + b.x1) * 0.5;
  const cy = (b.y0 + b.y1) * 0.5;

  switch (shape) {
    case 'brim': {
      // A montera: wide flat brim at the base of the box, domed crown above it.
      const br = Math.min(hh * 0.30, hw * 0.16);
      const by = b.y0 + br;
      const cr = Math.min(hw * 0.52, Math.max(hh * 2 - br, br));
      acc(c, cx, by, cx, Math.max(b.y1 - cr, by), cr * 0.9, cr, 0, c.color);
      acc(c, b.x0 + br, by, b.x1 - br, by, br, br, 1, c.color);
      acc(c, cx - cr * 0.78, by + br * 2.1, cx + cr * 0.78, by + br * 2.1,
        br * 0.62, br * 0.62, 2, lighten(c.color, 0.24));
      break;
    }
    case 'puff': {
      // A pompom: one core, four satellites lit front-to-back.
      const r = Math.min(hw, hh) * 0.55;
      acc(c, cx, cy, cx, cy, r, r, 0, c.color);
      for (let i = 0; i < 4; i++) {
        const a = (i * 0.5 + 0.25) * Math.PI;
        const px = cx + (hw - r * 0.85) * Math.cos(a);
        const py = cy + (hh - r * 0.85) * Math.sin(a);
        acc(c, px, py, px, py, r * 0.74, r * 0.74, i < 2 ? 1 : -1,
          i % 2 === 0 ? lighten(c.color, 0.10) : darken(c.color, 0.14));
      }
      break;
    }
    case 'bells': {
      // A cord of cascabeles. They shimmer — that is what `glintPhase` is for.
      const n = 3;
      const br = Math.min(hw * 0.62, (b.y1 - b.y0) / (n * 2.2));
      acc(c, cx, b.y1, cx, b.y0 + br, Math.max(hw * 0.13, 1), Math.max(hw * 0.10, 0.8),
        -1, darken(c.color, 0.45));
      for (let i = 0; i < n; i++) {
        const px = cx + (i % 2 === 0 ? -1 : 1) * hw * 0.3;
        const py = b.y1 - ((i + 0.72) / n) * (b.y1 - b.y0);
        acc(c, px, py, px, py, br, br, i, lighten(c.color, i * 0.07));
      }
      break;
    }
    case 'fan': spray(c, b, 5, 1.05, 0.98, 0.075, 0.14, 0); break;
    case 'plume': spray(c, b, 3, 0.62, 1.05, 0.085, 0.035, 2.0); break;
    case 'horns': spray(c, b, 2, 1.15, 0.92, 0.100, 0.030, 0); break;
    case 'apron': panel(c, b, 4, 0); break;
    case 'skirt': panel(c, b, 5, 0.22); break;
    case 'band': slab(c, b, 0.8, 0, c.color); break;
    case 'shell':
      slab(c, b, 0.92, 0, c.color);
      slab(c, b, 0.50, 1, lighten(c.color, 0.18));
      break;
    default: never(shape, 'gfx/skin/stick: accessory shape');
  }
};

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

/** Absolute concept box -> the accessory bone's local frame, world units, y up. */
const conceptBox = (box: ConceptBox, px: number, py: number, cs: ConceptSpace, out: Box): Box => {
  const u = cs.unitsPerPx;
  out.x0 = (box[0] - px) * u;
  out.x1 = (box[2] - px) * u;
  out.y0 = (py - box[3]) * u;
  out.y1 = (py - box[1]) * u;
  return out;
};

const expand = (b: Bounds, x: number, y: number, r: number): void => {
  if (x - r < b.minX) b.minX = x - r;
  if (x + r > b.maxX) b.maxX = x + r;
  if (y - r < b.minY) b.minY = y - r;
  if (y + r > b.maxY) b.maxY = y + r;
};

export interface StickSkinOptions {
  /** 0..1 cylindrical shading. 1 = full volume. */
  readonly shade?: number;
  /** 0..1 rim light strength. */
  readonly rim?: number;
  /** Soft ground shadow under the fighter. */
  readonly shadow?: boolean;
  /** 0..1 darkening for everything painted behind the hip. The depth cue. */
  readonly backDepth?: number;
}

const HIP_Z = BONE_Z[Bone.HIP] ?? 500;

const PA: Vec2 = { x: 0, y: 0 };
const PB: Vec2 = { x: 0, y: 0 };

export class SkinStick implements CharacterSkin {
  readonly kind = 'stick' as const;
  readonly charId: CharId;
  readonly materialKey = MATERIAL_KEY.STICK;

  private readonly ops: readonly DrawOp[];
  private readonly style: StickStyle;
  private readonly rim: number;
  private readonly shade: number;
  private readonly bounds: FxBox;
  /** Ground shadow half-length and radius, world units. 0 disables it. */
  private readonly shadowHalf: number;
  private readonly shadowR: number;
  private readonly shadowCol: number;

  private gl: WebGL2RenderingContext | null = null;
  private mat: Material | null = null;
  private disposed = false;

  constructor(char: CompiledChar, opts: StickSkinOptions = {}) {
    const def = char.def;
    const sd = def.stick;
    const rest = restPoseOf(def.restPose, char.conceptSpace);
    const backDepth = opts.backDepth ?? 0.30;

    this.charId = char.id;
    this.rim = opts.rim ?? 0.55;
    this.shade = opts.shade ?? 1;
    this.style = stickStyleFromPalette(sd.palette, { shade: this.shade, rimStrength: this.rim });

    const ops: DrawOp[] = [];
    buildLimbs(ops, sd, backDepth);
    buildExtras(ops, sd, rest, backDepth);
    buildAccessories(ops, def.restPose, sd, char.conceptSpace, backDepth);
    ops.sort((a, b) => a.z - b.z);
    this.ops = ops;

    // Bones only: the shadow is cast by the body, not by the hat.
    const body = restBounds(rest, createBounds(), sd.radii, sd.outline);
    const wide = body.maxX - body.minX;
    this.shadowHalf = (opts.shadow ?? true) ? wide * 0.30 : 0;
    this.shadowR = wide * 0.105;
    this.shadowCol = sd.palette.ink;

    // Visual bounds: bones, plus everything the proxies add to the silhouette.
    const vis = restBounds(rest, createBounds(), sd.radii, sd.outline);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (!op.local) continue;
      const bx = rest.worldX[op.bone] ?? 0;
      const by = rest.worldY[op.bone] ?? 0;
      expand(vis, bx + op.ax, by + op.ay, op.r0 + sd.outline);
      expand(vis, bx + op.bx, by + op.by, op.r1 + sd.outline);
    }
    this.bounds = boundsToFxBox(vis);
  }

  load(gl: WebGL2RenderingContext): Promise<void> {
    if (!this.disposed && this.mat === null) {
      this.gl = gl;
      this.mat = acquireStickMaterial(gl);
    }
    return Promise.resolve();
  }

  /** The material to bind before `emit`. Null until `load` has run. */
  get material(): Material | null {
    return this.mat;
  }

  emit(out: InstanceWriter, pose: PoseBuffer, o: SkinDrawOpts): void {
    const st = this.style;
    const alpha = clamp01(o.alpha * o.tint[3]);
    if (alpha <= 0) return;

    st.alpha = alpha;
    st.flash = clamp01(o.flash);
    st.tintR = o.tint[0];
    st.tintG = o.tint[1];
    st.tintB = o.tint[2];

    const ox = o.worldX + o.shakeX;
    const oy = o.worldY + o.shakeY;
    const zb = o.zBase;
    const costume = o.costume;

    if (this.shadowHalf > 0) {
      // Pinned to the stage floor and shrinking with altitude, so a jump reads
      // as a jump. The shake stays out of it: the floor does not vibrate.
      const lift = o.worldY > 0 ? o.worldY : 0;
      const k = 1 / (1 + lift / 150);
      const hw = this.shadowHalf * k;
      const r = this.shadowR * k;
      st.alpha = alpha * 0.42 * k;
      st.flash = 0;
      st.rimStrength = 0;
      st.shade = 0;
      writeStickCapsule(out, o.worldX - hw, 0, o.worldX + hw, 0, r, r, 0,
        this.shadowCol, zb, st);
      st.alpha = alpha;
      st.flash = clamp01(o.flash);
      st.shade = this.shade;
    }

    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if (pose.visible[op.bone] === 0) continue;

      let r0: number;
      let r1: number;
      if (op.local) {
        const s = boneScale(pose, op.bone);
        transformPoint(pose, op.bone, op.ax, op.ay, PA);
        transformPoint(pose, op.bone, op.bx, op.by, PB);
        r0 = op.r0 * s;
        r1 = op.r1 * s;
      } else {
        if (pose.visible[op.tip] === 0) continue;
        boneWorldPos(pose, op.bone, PA);
        boneWorldPos(pose, op.tip, PB);
        r0 = op.r0 * boneScale(pose, op.bone);
        r1 = op.r1 * boneScale(pose, op.tip);
      }

      // Sequins catch the light when the fighter moves. Presentation only.
      st.rimStrength = op.glint < 0
        ? this.rim
        : this.rim * (1 + 0.42 * Math.sin(o.glintPhase + op.glint));

      writeStickCapsule(out, PA.x + ox, PA.y + oy, PB.x + ox, PB.y + oy,
        r0, r1, op.ink, costume === 1 ? op.col1 : op.col0, op.z + zb, st);
    }

    st.rimStrength = this.rim;
  }

  localBounds(): FxBox {
    return this.bounds;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (gl !== null && this.mat !== null) releaseStickMaterial(gl);
    this.gl = null;
    this.mat = null;
  }
}

export const createStickSkin = (char: CompiledChar, opts?: StickSkinOptions): SkinStick =>
  new SkinStick(char, opts);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// -----------------------------------------------------------------------------
// Op builders
// -----------------------------------------------------------------------------

/** Depth cue: anything painted behind the hip is a far-side limb. */
const depthOf = (z: number, backDepth: number): number => (z < HIP_Z ? backDepth : 0);

const limbColor = (sd: StickDef, bone: Bone, z: number, backDepth: number): number => {
  const p = sd.palette;
  const col = bone === Bone.HEAD ? lighten(p.base, 0.12) : p.base;
  return darken(col, depthOf(z, backDepth));
};

/**
 * A limb exists between every bone and its parent that BOTH carry a radius. The
 * fatter end owns the colour (so NECK->HEAD is a head, not a neck) and the
 * child owns the z (so the limb sorts with the joint it reaches).
 */
const buildLimbs = (ops: DrawOp[], sd: StickDef, backDepth: number): void => {
  for (let b = 1; b < BONE_COUNT; b++) {
    const par = BONE_PARENTS[b] ?? -1;
    if (par < 0) continue;
    const rc = sd.radii[b] ?? 0;
    const rp = sd.radii[par] ?? 0;
    if (rc <= 0 || rp <= 0) continue;
    const z = BONE_Z[b] ?? 0;
    const owner = (rc > rp ? b : par) as Bone;
    pushOp(ops, par as Bone, b as Bone, false, 0, 0, 0, 0, rp, rc, sd.outline,
      limbColor(sd, owner, z, backDepth), z, NO_GLINT);
  }
};

/** Boots, fists and the brow mark: local-frame ops on the bones that need mass. */
const buildExtras = (ops: DrawOp[], sd: StickDef, rest: RestPose, backDepth: number): void => {
  const p = sd.palette;

  for (const foot of [Bone.FOOT_B, Bone.FOOT_F]) {
    const r = sd.radii[foot] ?? 0;
    if (r <= 0) continue;
    const shin = Math.hypot(rest.tx[foot] ?? 0, rest.ty[foot] ?? 0);
    const len = Math.max(shin * 0.22, r * 2.4);
    const toe = r * 0.82;
    // The sole lands on y = 0 at rest; posed, the toe rides the ankle's frame.
    const drop = Math.max((rest.worldY[foot] ?? 0) - toe, 0);
    const z = (BONE_Z[foot] ?? 0) + 1;
    pushOp(ops, foot, foot, true, 0, 0, len, -drop, r, toe, sd.outline,
      darken(p.accent, depthOf(z, backDepth)), z, NO_GLINT);
  }

  for (const hand of [Bone.HAND_B, Bone.HAND_F]) {
    const r = sd.radii[hand] ?? 0;
    if (r <= 0) continue;
    const z = (BONE_Z[hand] ?? 0) + 1;
    pushOp(ops, hand, hand, true, 0, 0, 0, 0, r * 1.28, r * 1.28, sd.outline,
      darken(p.accent, depthOf(z, backDepth)), z, NO_GLINT);
  }

  const rh = sd.radii[Bone.HEAD] ?? 0;
  if (rh > 0) {
    // A brow on the facing side: no outline, inside the skull, so the figure
    // never loses which way it is looking. Facing rides ROOT's scaleX.
    pushOp(ops, Bone.HEAD, Bone.HEAD, true, rh * 0.22, rh * 0.20, rh * 0.74, rh * 0.10,
      rh * 0.12, rh * 0.10, 0, p.ink, (BONE_Z[Bone.HEAD] ?? 0) + 1, NO_GLINT);
  }
};

const buildAccessories = (
  ops: DrawOp[],
  restPose: readonly (readonly [number, number])[],
  sd: StickDef,
  cs: ConceptSpace,
  backDepth: number,
): void => {
  const box: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };
  for (const a of sd.accessories) {
    const pivot = restPose[a.bone];
    if (pivot === undefined) continue;
    const z = BONE_Z[a.bone] ?? 0;
    const c: AccCtx = {
      ops, bone: a.bone, color: a.color, ink: sd.outline, z,
      depth: depthOf(z, backDepth),
    };
    conceptBox(a.box, pivot[0], pivot[1], cs, box);
    addShape(c, a.shape, box);
    if (!a.mirrored) continue;
    const x0 = box.x0;
    box.x0 = -box.x1;
    box.x1 = -x0;
    addShape(c, a.shape, box);
  }
};

// =============================================================================
// SunForce — tools/bake-sprites.mts       THE OFFLINE FRAME GENERATOR
//
// SunForce renders like Guilty Gear XX: one image per animation frame, blitted
// as a single quad, no bones at runtime. The 24-bone rig does not go away — it
// moves OFFLINE, to here. This steps each pose frame by frame, rasterises it on
// the CPU, packs the frames into one power-of-two atlas and writes
// public/art/a.png + public/art/a.sheet.json (the `SpriteSheet` contract). When
// hand-drawn art arrives it replaces both files and the runtime is unchanged,
// because the runtime never learns where the pixels came from. The rasteriser
// is a CPU port of gfx/shaders/stick.ts's fragment shader — the same
// tapered-capsule SDF, ink threshold, dome shading and rim light — so this is a
// change of ARCHITECTURE, not of art direction.
//
// THE ORIGIN, the one number that must be right: each frame is trimmed to its
// tight alpha box and `origin` is where the fighter's world (0, 0) — feet
// centre, on the ground line — landed in it, x from LEFT, y from TOP. Exact by
// construction (the transform that rasterised the frame places the origin, on a
// whole pixel). The other half is the POSE standing on y = 0, which `soleOf`
// plus the ground lock in `main` guarantee and which `main` then MEASURES BACK
// off the finished bitmap, per frame, refusing to write a sheet whose boots are
// not exactly `outline` units under the origin. Airborne clips are exempt
// upward only: feet may leave the floor, never sink through it.
// =============================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { AnimId, BONE_COUNT, BONE_PARENTS, BONE_Z, Bone, MoveId } from '@/core/contracts';
import type {
  CompiledChar, CompiledMove, PoseBuffer, PoseHint, SpriteClip, SpriteFrame, SpriteSheet, StickDef,
} from '@/core/contracts';
import { CHAR_A } from '@/data/chars/a';
import { compileChar } from '@/data/compile';
import { sample } from '@/gfx/skin/anim';
import {
  applyRest, boneScale, boneWorldPos, createPoseBuffer, restPoseOf, solve, transformPoint,
} from '@/gfx/skin/pose';
import type { RestPose, Vec2 } from '@/gfx/skin/pose';
import { encodePng } from './png.mts';

// --- Bake settings -----------------------------------------------------------
/** Atlas pixels per WORLD unit. The fighter is 378 units on a 1080-tall logical
 *  screen, so 1.5 is 1.5x a 1080p pixel: headroom for 1440p, for a retina
 *  backing store and for the camera's 1.30 zoom-in. It costs atlas area fast —
 *  1.5 is the largest value whose frames still fit one 4096x4096 atlas. */
const PX_PER_UNIT = 1.5;
/** Supersample factor: every frame is rendered SSxSS and box-downsampled. */
const SS = 2;
/** Transparent gutter between packed frames. >= 2 stops a bilinear tap at
 *  non-integer zoom from reaching into the neighbouring frame. */
const PAD = 2;
/** Candidate atlases, smallest area first. Both axes stay powers of two. */
const SIZES = [[512, 512], [1024, 512], [1024, 1024], [2048, 1024], [2048, 2048],
  [4096, 2048], [4096, 4096]] as const;
/** Cap on the feet-to-floor correction, world units. A rail, not a tool. */
const LOCK_MAX = 48;
/** Rim light, FIGHTER-LOCAL and front-high. A sprite carries its own light
 *  baked in: the runtime mirrors the quad for facing, so a world-space light
 *  (StageDef.rimLightDir, which the stick shader uses) would flip with it. */
const LIGHT_X = 0.55, LIGHT_Y = 0.84;
const RIM_STRENGTH = 0.55;   // SkinStick's default `opts.rim`
const BACK_DEPTH = 0.30;     // SkinStick's default `opts.backDepth`
/** Mirrors anim.ts's private IDLE_PERIOD: one breath cycle, in sim frames. */
const BREATH = 96;
const TAU = Math.PI * 2;
const HIP_Z = BONE_Z[Bone.HIP] ?? 500;
/** Ink colour, rim colour, outline width — lifted from the palette in `main`. */
let INK = 0, RIM = 0, OUTLINE = 0;

// --- Colour — the helpers SkinStick builds its op colours with ----------------
const byte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (hex: number, to: number, t: number): number =>
  (byte(((hex >> 16) & 0xff) + (((to >> 16) & 0xff) - ((hex >> 16) & 0xff)) * t) << 16) |
  (byte(((hex >> 8) & 0xff) + (((to >> 8) & 0xff) - ((hex >> 8) & 0xff)) * t) << 8) |
  byte((hex & 0xff) + ((to & 0xff) - (hex & 0xff)) * t);
const lighten = (hex: number, t: number): number => mix(hex, 0xffffff, t);
const darken = (hex: number, t: number): number => mix(hex, 0x120c10, t);
/** Anything painted behind the hip is a far-side limb. The one depth cue. */
const depthOf = (z: number): number => (z < HIP_Z ? BACK_DEPTH : 0);

// --- Draw ops — a port of SkinStick's build phase, minus the GL ---------------
/** `sole` is true for the two boots — they, and only they, set ground contact. */
interface Op {
  readonly bone: Bone; readonly tip: Bone; readonly local: boolean; readonly sole: boolean;
  readonly ax: number; readonly ay: number; readonly bx: number; readonly by: number;
  readonly r0: number; readonly r1: number;
  readonly ink: number; readonly col: number; readonly z: number;
}
function buildOps(sd: StickDef, rest: RestPose): Op[] {
  const ops: Op[] = [];
  const p = sd.palette;
  const add = (
    bone: Bone, tip: Bone, local: boolean, ax: number, ay: number, bx: number, by: number,
    r0: number, r1: number, ink: number, col: number, z: number, sole = false,
  ): void => { ops.push({ bone, tip, local, ax, ay, bx, by, r0, r1, ink, col, z, sole }); };
  // A limb exists between every bone and its parent that BOTH carry a radius.
  // The fatter end owns the colour, the child owns the z.
  for (let b = 1; b < BONE_COUNT; b++) {
    const par = BONE_PARENTS[b] ?? -1;
    const rc = sd.radii[b] ?? 0, rp = par < 0 ? 0 : sd.radii[par] ?? 0;
    if (par < 0 || rc <= 0 || rp <= 0) continue;
    const z = BONE_Z[b] ?? 0;
    const base = (rc > rp ? b : par) === Bone.HEAD ? lighten(p.base, 0.12) : p.base;
    add(par as Bone, b as Bone, false, 0, 0, 0, 0, rp, rc, sd.outline, darken(base, depthOf(z)), z);
  }
  // Boots, fists and the brow: local-frame ops on the bones that need mass.
  for (const foot of [Bone.FOOT_B, Bone.FOOT_F]) {
    const r = sd.radii[foot] ?? 0, z = (BONE_Z[foot] ?? 0) + 1, toe = r * 0.82;
    if (r <= 0) continue;
    const len = Math.max(Math.hypot(rest.tx[foot] ?? 0, rest.ty[foot] ?? 0) * 0.22, r * 2.4);
    const drop = Math.max((rest.worldY[foot] ?? 0) - toe, 0);
    add(foot, foot, true, 0, 0, len, -drop, r, toe, sd.outline, darken(p.accent, depthOf(z)), z, true);
  }
  for (const hand of [Bone.HAND_B, Bone.HAND_F]) {
    const r = (sd.radii[hand] ?? 0) * 1.28, z = (BONE_Z[hand] ?? 0) + 1;
    if (r > 0) add(hand, hand, true, 0, 0, 0, 0, r, r, sd.outline, darken(p.accent, depthOf(z)), z);
  }
  const rh = sd.radii[Bone.HEAD] ?? 0;   // brow: no ink, inside the skull
  if (rh > 0) {
    add(Bone.HEAD, Bone.HEAD, true, rh * 0.22, rh * 0.20, rh * 0.74, rh * 0.10,
      rh * 0.12, rh * 0.10, 0, p.ink, (BONE_Z[Bone.HEAD] ?? 0) + 1);
  }
  return ops.sort((a, b) => a.z - b.z);   // painter order IS draw order
}

/** One op resolved against a solved pose: world endpoints and world radii. */
interface Seg {
  x0: number; y0: number; x1: number; y1: number;
  r0: number; r1: number; ink: number; col: number; sole: boolean;
}
const PA: Vec2 = { x: 0, y: 0 }, PB: Vec2 = { x: 0, y: 0 };
function resolve(pose: PoseBuffer, ops: readonly Op[]): Seg[] {
  const segs: Seg[] = [];
  for (const op of ops) {
    if (pose.visible[op.bone] === 0) continue;
    let r0: number, r1: number;
    if (op.local) {
      const s = boneScale(pose, op.bone);
      transformPoint(pose, op.bone, op.ax, op.ay, PA);
      transformPoint(pose, op.bone, op.bx, op.by, PB);
      r0 = op.r0 * s; r1 = op.r1 * s;
    } else {
      if (pose.visible[op.tip] === 0) continue;
      boneWorldPos(pose, op.bone, PA);
      boneWorldPos(pose, op.tip, PB);
      r0 = op.r0 * boneScale(pose, op.bone);
      r1 = op.r1 * boneScale(pose, op.tip);
    }
    if (r0 > 0 || r1 > 0) {
      segs.push({ x0: PA.x, y0: PA.y, x1: PB.x, y1: PB.y, r0, r1, ink: op.ink, col: op.col, sole: op.sole });
    }
  }
  return segs;
}

/** World y of the lowest INK pixel of the lowest boot — the sprite's true
 *  ground contact. At rest the toe capsule kisses y = 0 and its outline hangs
 *  `outline` under that, so a correctly planted pose returns exactly -outline. */
function soleOf(segs: readonly Seg[]): number {
  let lo = Infinity;
  for (const s of segs) {
    if (s.sole) lo = Math.min(lo, s.y0 - s.r0 - s.ink, s.y1 - s.r1 - s.ink);
  }
  return lo;
}

// --- The rasteriser — capsuleSD and the shading, from the fragment shader -----
/** Signed distance to a tapered capsule (0,0)->(L,0) with radii R0/R1, plus its
 *  exact outward unit gradient. Written into `SD` so nothing allocates. */
const SD = { d: 0, gx: 0, gy: 0 };
function capsuleSD(px: number, py: number, L: number, R0: number, R1: number): void {
  if (L < 1e-3) {                                   // degenerate bone: a disc
    const dd = Math.hypot(px, py);
    SD.d = dd - Math.max(R0, R1);
    SD.gx = dd > 1e-5 ? px / dd : 0; SD.gy = dd > 1e-5 ? py / dd : 1;
    return;
  }
  const sy = py < 0 ? -1 : 1, qy = py < 0 ? -py : py;
  const b = Math.max(-0.999, Math.min(0.999, (R0 - R1) / L));
  const a = Math.sqrt(Math.max(1e-8, 1 - b * b));
  const k = a * px - b * qy;
  if (k < 0) {                                      // start cap
    const dd = Math.hypot(px, qy);
    SD.d = dd - R0;
    SD.gx = dd > 1e-5 ? px / dd : -1; SD.gy = (dd > 1e-5 ? qy / dd : 0) * sy;
  } else if (k > a * L) {                           // end cap
    const wx = px - L, dd = Math.hypot(wx, qy);
    SD.d = dd - R1;
    SD.gx = dd > 1e-5 ? wx / dd : 1; SD.gy = (dd > 1e-5 ? qy / dd : 0) * sy;
  } else {                                          // slanted side
    SD.d = px * b + qy * a - R0; SD.gx = b; SD.gy = a * sy;
  }
}

/** A rasterised frame: tight RGBA pixels plus where world (0,0) sits in them. */
interface Frame { w: number; h: number; ox: number; oy: number; rgba: Uint8Array }

function rasterise(segs: readonly Seg[]): Frame {
  // 1. Analytic bounds of everything that will be drawn, world units.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    const r = Math.max(s.r0, s.r1) + s.ink + 1;
    minX = Math.min(minX, s.x0 - r, s.x1 - r); maxX = Math.max(maxX, s.x0 + r, s.x1 + r);
    minY = Math.min(minY, s.y0 - r, s.y1 - r); maxY = Math.max(maxY, s.y0 + r, s.y1 + r);
  }
  if (minX > maxX) throw new Error('rasterise: nothing to draw');

  // 2. Canvas, with a 2px margin. The origin lands on a WHOLE pixel, so
  //    `origin` stays integral and a 1:1 blit is never half a pixel off.
  const ox = Math.ceil(-minX * PX_PER_UNIT) + 2, oy = Math.ceil(maxY * PX_PER_UNIT) + 2;
  const w = ox + Math.ceil(maxX * PX_PER_UNIT) + 2, h = oy + Math.ceil(-minY * PX_PER_UNIT) + 2;
  const sw = w * SS, sh = h * SS;
  const scale = PX_PER_UNIT * SS;              // supersampled px per world unit
  const oxs = ox * SS, oys = oy * SS;
  const acc = new Float32Array(sw * sh * 4);   // premultiplied, straight-alpha "over"
  const ir = ((INK >> 16) & 0xff) / 255, ig = ((INK >> 8) & 0xff) / 255, ib = (INK & 0xff) / 255;
  const mr = ((RIM >> 16) & 0xff) / 255, mg = ((RIM >> 8) & 0xff) / 255, mb = (RIM & 0xff) / 255;

  for (const s of segs) {
    let ux = s.x1 - s.x0, uy = s.y1 - s.y0;
    const L = Math.hypot(ux, uy);
    if (L > 1e-6) { ux /= L; uy /= L; } else { ux = 1; uy = 0; }
    const R0 = s.r0 + s.ink, R1 = s.r1 + s.ink, reach = Math.max(R0, R1) + 1;
    // The light rotated into the capsule's own orthonormal frame, once.
    const lx = LIGHT_X * ux + LIGHT_Y * uy, ly = -LIGHT_X * uy + LIGHT_Y * ux;
    const cr = ((s.col >> 16) & 0xff) / 255, cg = ((s.col >> 8) & 0xff) / 255, cb = (s.col & 0xff) / 255;
    const i0 = Math.max(0, Math.floor((Math.min(s.x0, s.x1) - reach) * scale + oxs));
    const i1 = Math.min(sw - 1, Math.ceil((Math.max(s.x0, s.x1) + reach) * scale + oxs));
    const j0 = Math.max(0, Math.floor(oys - (Math.max(s.y0, s.y1) + reach) * scale));
    const j1 = Math.min(sh - 1, Math.ceil(oys - (Math.min(s.y0, s.y1) - reach) * scale));

    for (let j = j0; j <= j1; j++) {
      const dy = (oys - (j + 0.5)) / scale - s.y0;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5 - oxs) / scale - s.x0;
        const along = dx * ux + dy * uy;
        capsuleSD(along, -dx * uy + dy * ux, L, R0, R1);
        const d = SD.d;
        // One supersampled pixel of coverage — the shader's fwidth(d), exactly.
        const cover = clamp01(0.5 - d * scale);
        if (cover <= 0) continue;
        const t = L > 1e-4 ? clamp01(along / L) : 0;
        const e = clamp01(1 + (d + s.ink) / Math.max(s.r0 + (s.r1 - s.r0) * t, 1e-3));
        // Cylindrical cross-section: a tube, not a flat lozenge.
        const dome = 0.60 + 0.48 * Math.sqrt(Math.max(0, 1 - e * e));
        const nl = SD.gx * lx + SD.gy * ly;
        const rim = nl > 0 ? clamp01(Math.pow(nl, 1.6) * Math.pow(e, 2.4) * RIM_STRENGTH) : 0;
        let r = cr * dome, g = cg * dome, b = cb * dome;
        r += (mr - r) * rim; g += (mg - g) * rim; b += (mb - b) * rim;
        // Ink underneath, body composited over it inside this one sample, so the
        // outline never double-blends and stays exactly `ink` units wide.
        const m = Math.min(1, clamp01(0.5 - (d + s.ink) * scale) / Math.max(cover, 1e-4));
        r = ir + (r - ir) * m; g = ig + (g - ig) * m; b = ib + (b - ib) * m;
        const o = (j * sw + i) * 4, inv = 1 - cover;
        acc[o] = r * cover + acc[o]! * inv;
        acc[o + 1] = g * cover + acc[o + 1]! * inv;
        acc[o + 2] = b * cover + acc[o + 2]! * inv;
        acc[o + 3] = cover + acc[o + 3]! * inv;
      }
    }
  }

  // 3. Box-downsample, un-premultiply, and trim to the tight alpha box.
  const rgba = new Uint8Array(w * h * 4);
  const inv = 1 / (SS * SS);
  let tx0 = w, ty0 = h, tx1 = -1, ty1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        let o = ((y * SS + sy) * sw + x * SS) * 4;
        for (let sx = 0; sx < SS; sx++, o += 4) {
          r += acc[o]!; g += acc[o + 1]!; b += acc[o + 2]!; a += acc[o + 3]!;
        }
      }
      a *= inv;
      if (a <= 0) continue;
      const k = inv / a, o = (y * w + x) * 4;
      rgba[o] = byte(r * k * 255 + 0.5); rgba[o + 1] = byte(g * k * 255 + 0.5);
      rgba[o + 2] = byte(b * k * 255 + 0.5); rgba[o + 3] = byte(a * 255 + 0.5);
      if (rgba[o + 3]! === 0) continue;
      if (x < tx0) tx0 = x;
      if (x > tx1) tx1 = x;
      if (y < ty0) ty0 = y;
      if (y > ty1) ty1 = y;
    }
  }
  if (tx1 < tx0) throw new Error('rasterise: frame is fully transparent');

  const fw = tx1 - tx0 + 1, fh = ty1 - ty0 + 1;
  const out = new Uint8Array(fw * fh * 4);
  for (let y = 0; y < fh; y++) {
    const src = ((y + ty0) * w + tx0) * 4;
    out.set(rgba.subarray(src, src + fw * 4), y * fw * 4);
  }
  return { w: fw, h: fh, ox: ox - tx0, oy: oy - ty0, rgba: out };
}

// --- The poses. anim.ts and pose.ts are pure floats, so they run here as-is ---
const IDLE_HINT: PoseHint = { limb: 'body', reach: 0, height: 0, lean: 0, crouch: 0, accSwing: 0 };
const IDLE_PHASE = { startup: 0, activeFirst: -1, activeLast: -1 };

/** Breathing stance at animation time `t` — exactly what gfx/renderer.ts asks
 *  for when a fighter is standing: `sample` with no active window. */
function idleAt(p: PoseBuffer, rest: RestPose, t: number): void {
  applyRest(p, rest, 1);
  const f = Math.floor(t);
  sample(p, CHAR_A.restPose, null, IDLE_HINT, f, 0, IDLE_PHASE, t - f);
}
/** One attack frame, identical to what gfx/renderer.ts would solve on screen. */
function moveAt(p: PoseBuffer, rest: RestPose, mv: CompiledMove, f: number): void {
  applyRest(p, rest, 1);
  sample(p, CHAR_A.restPose, null, mv.poseHint, f, mv.totalFrames,
    { startup: mv.startup, activeFirst: mv.activeFirst, activeLast: mv.activeLast }, 0);
}

/** A whole-body deflection added ON TOP of the breathing stance — one amplitude
 *  set per clip, scaled by an envelope. `hip` is world units of drop, the rest
 *  are radians: +thigh swings the knee forward, +shin bends it back, +lean tips
 *  the chest forward, +head tips it back, +arm swings the elbow forward. */
interface Flex {
  readonly hip: number; readonly thigh: number; readonly shin: number;
  readonly lean: number; readonly arm: number; readonly fore: number; readonly head: number;
}
/** bone, which Flex term drives it, and how much. Back limbs trail the front. */
const FLEX_MAP: readonly (readonly [Bone, keyof Flex, number])[] = [
  [Bone.THIGH_F, 'thigh', 1], [Bone.THIGH_B, 'thigh', 0.82],
  [Bone.SHIN_F, 'shin', -1], [Bone.SHIN_B, 'shin', -0.82],
  [Bone.SPINE_LOW, 'lean', -0.6], [Bone.SPINE_UP, 'lean', -0.4],
  [Bone.NECK, 'head', 1], [Bone.HEAD, 'head', 0.6],
  [Bone.UPPER_ARM_F, 'arm', 1], [Bone.UPPER_ARM_B, 'arm', 1.15],
  [Bone.FOREARM_F, 'fore', 1], [Bone.FOREARM_B, 'fore', 1.1],
];
function flex(p: PoseBuffer, k: Flex, e: number): void {
  p.ty[Bone.HIP] = p.ty[Bone.HIP]! - k.hip * e;
  for (const [bone, term, s] of FLEX_MAP) p.rot[bone] = p.rot[bone]! + k[term] * e * s;
}
const SQUAT: Flex = { hip: 30, thigh: 0.52, shin: 0.92, lean: 0.22, arm: -0.78, fore: 0.34, head: 0.06 };
const TUCK: Flex = { hip: -7, thigh: 0.95, shin: 1.25, lean: 0.12, arm: 0.52, fore: 0.46, head: -0.05 };
const REACH: Flex = { hip: -8, thigh: 0.16, shin: -0.14, lean: -0.08, arm: 0.34, fore: -0.26, head: 0.06 };
const RECOIL: Flex = { hip: 4, thigh: -0.20, shin: 0.34, lean: -0.45, arm: 0.66, fore: -0.30, head: 0.34 };

/** Alternating stride over the stance. `dir` reverses it for WALK_B, which is
 *  what stops walking backward reading as walking forward played sideways. */
function stride(p: PoseBuffer, u: number, dir: number): void {
  const a = u * TAU * dir, s = Math.sin(a);
  const lift = (ph: number): number => Math.max(0, Math.sin(a + ph));
  p.ty[Bone.HIP] = p.ty[Bone.HIP]! - 3.0 * (0.5 - 0.5 * Math.cos(2 * a));
  p.rot[Bone.HIP] = p.rot[Bone.HIP]! + 0.05 * s;
  p.rot[Bone.THIGH_F] = p.rot[Bone.THIGH_F]! + 0.44 * s;
  p.rot[Bone.THIGH_B] = p.rot[Bone.THIGH_B]! - 0.44 * s;
  p.rot[Bone.SHIN_F] = p.rot[Bone.SHIN_F]! - 0.62 * lift(-0.7);
  p.rot[Bone.SHIN_B] = p.rot[Bone.SHIN_B]! - 0.62 * lift(Math.PI - 0.7);
  p.rot[Bone.UPPER_ARM_F] = p.rot[Bone.UPPER_ARM_F]! - 0.28 * s;
  p.rot[Bone.UPPER_ARM_B] = p.rot[Bone.UPPER_ARM_B]! + 0.28 * s;
  p.rot[Bone.SPINE_LOW] = p.rot[Bone.SPINE_LOW]! - 0.05 * dir;
}

// --- The clip list -----------------------------------------------------------
interface ClipSpec {
  readonly anim: AnimId;
  readonly count: number;
  /** Sim frames each image is held for. */
  readonly dur: number;
  readonly loopAt: number;
  /** Airborne clips are lifted out of the floor but never planted on it. */
  readonly air: boolean;
  readonly pose: (p: PoseBuffer, i: number) => void;
}
function buildClips(char: CompiledChar, rest: RestPose): ClipSpec[] {
  const moveOf = (id: MoveId): CompiledMove => {
    const m = char.moves[id];
    if (m === null || m === undefined) throw new Error(`bake: character A has no move ${id}`);
    return m;
  };
  const p5 = moveOf(MoveId.A_5P), k5 = moveOf(MoveId.A_5K);
  const n = (i: number, c: number): number => (c > 1 ? i / (c - 1) : 0);
  return [
    { anim: AnimId.IDLE, count: 8, dur: BREATH / 8, loopAt: 0, air: false,
      pose: (p, i) => idleAt(p, rest, (i * BREATH) / 8) },
    { anim: AnimId.WALK_F, count: 8, dur: 4, loopAt: 0, air: false,
      pose: (p, i) => { idleAt(p, rest, i * 4); stride(p, i / 8, 1); } },
    { anim: AnimId.WALK_B, count: 8, dur: 4, loopAt: 0, air: false,
      pose: (p, i) => { idleAt(p, rest, i * 4); stride(p, i / 8, -1); } },
    // One image per jumpSquat frame: the crouch deepens into the launch.
    { anim: AnimId.JUMP_SQUAT, count: char.jumpSquat, dur: 1, loopAt: -1, air: false,
      pose: (p, i) => { idleAt(p, rest, i); flex(p, SQUAT, (i + 1) / char.jumpSquat); } },
    // Rise holds its last frame at the apex; fall picks it up and extends.
    { anim: AnimId.JUMP_RISE, count: 4, dur: 4, loopAt: 3, air: true,
      pose: (p, i) => { idleAt(p, rest, i * 4); flex(p, TUCK, 0.40 + 0.60 * n(i, 4)); } },
    { anim: AnimId.JUMP_FALL, count: 4, dur: 4, loopAt: 3, air: true,
      pose: (p, i) => {
        const e = n(i, 4);
        idleAt(p, rest, i * 4);
        flex(p, TUCK, 0.55 * (1 - e)); flex(p, REACH, 0.35 + 0.65 * e);
        p.rot[Bone.THIGH_F] = p.rot[Bone.THIGH_F]! + 0.30 * e;   // legs split for the
        p.rot[Bone.THIGH_B] = p.rot[Bone.THIGH_B]! - 0.34 * e;   // landing silhouette
      } },
    { anim: AnimId.LAND, count: char.landingLag, dur: 1, loopAt: -1, air: false,
      pose: (p, i) => { idleAt(p, rest, i); flex(p, SQUAT, 1 - n(i, char.landingLag) * 0.72); } },
    // 6 images over 18 frames: hitstun runs 16 (punch) to 21 (kick), and a
    // one-shot clip holds its last image for whatever is left.
    { anim: AnimId.HIT_STAND, count: 6, dur: 3, loopAt: -1, air: false,
      pose: (p, i) => { idleAt(p, rest, i * 3); flex(p, RECOIL, Math.pow(1 - i / 6, 1.6)); } },
    { anim: AnimId.ATK_5P, count: p5.totalFrames, dur: 1, loopAt: -1, air: false,
      pose: (p, i) => moveAt(p, rest, p5, i) },
    { anim: AnimId.ATK_5K, count: k5.totalFrames, dur: 1, loopAt: -1, air: false,
      pose: (p, i) => moveAt(p, rest, k5, i) },
  ];
}

// --- Atlas packing -----------------------------------------------------------
/** Shelf packer, tallest first. Every frame keeps PAD transparent pixels on all
 *  four sides, including against the atlas border. */
function shelf(
  frames: readonly Frame[], order: readonly number[], W: number, H: number,
): { x: number; y: number }[] | null {
  const pos: { x: number; y: number }[] = new Array(frames.length);
  let x = PAD, y = PAD, tall = 0;
  for (const k of order) {
    const f = frames[k]!;
    if (x + f.w + PAD > W) { x = PAD; y += tall + PAD; tall = 0; }
    if (y + f.h + PAD > H) return null;
    pos[k] = { x, y };
    x += f.w + PAD;
    if (f.h > tall) tall = f.h;
  }
  return pos;
}
/** Dilates colour into fully transparent pixels so a bilinear tap at a frame's
 *  edge picks up the sprite's colour and not black. The classic halo fix. A
 *  neighbour step may wrap a row, but only into gutter nobody ever samples. */
function bleed(atlas: Uint8Array, W: number, passes: number): void {
  const near = [-4, 4, -W * 4, W * 4];
  for (let pass = 0; pass < passes; pass++) {
    const src = atlas.slice();
    for (let o = 0; o < src.length; o += 4) {
      if (src[o + 3] !== 0) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const step of near) {
        const q = o + step;
        if (q < 0 || q >= src.length || src[q + 3] === 0) continue;
        r += src[q]!; g += src[q + 1]!; b += src[q + 2]!; n++;
      }
      if (n > 0) { atlas[o] = (r / n) | 0; atlas[o + 1] = (g / n) | 0; atlas[o + 2] = (b / n) | 0; }
    }
  }
}

// --- Bake --------------------------------------------------------------------
function main(): void {
  const char = compileChar(CHAR_A);
  const sd = CHAR_A.stick;
  if (sd.accessories.length > 0) {
    console.warn(`bake: ${sd.accessories.length} accessory proxies are NOT baked; port SkinStick's addShape() first`);
  }
  INK = sd.palette.ink; RIM = sd.palette.rim; OUTLINE = sd.outline;
  const rest = restPoseOf(CHAR_A.restPose, char.conceptSpace);
  const ops = buildOps(sd, rest);
  const pose = createPoseBuffer();
  const specs = buildClips(char, rest);
  const frames: Frame[] = [];
  const owner: number[] = [];          // frame index -> clip index
  const report: string[] = [];
  let maxLock = 0;

  for (let c = 0; c < specs.length; c++) {
    const spec = specs[c]!;
    const name = AnimId[spec.anim] ?? String(spec.anim);
    let soleLo = Infinity, soleHi = -Infinity;
    for (let i = 0; i < spec.count; i++) {
      spec.pose(pose, i);
      solve(pose);
      let segs = resolve(pose, ops);
      // GROUND LOCK. Slide the figure so the lowest boot's ink sits ON the ground
      // line. The rig's own moves already pin a foot, so this is ~0 for them; it
      // is what makes the hand-authored squat / land / hit poses honest, and why
      // world (0, 0) is the floor in every frame. Airborne clips are clamped ONE
      // WAY — lifted out of the floor, never pushed onto it.
      let fix = Math.max(-LOCK_MAX, Math.min(LOCK_MAX, soleOf(segs) + OUTLINE));
      if (spec.air && fix > 0) fix = 0;
      if (Math.abs(fix) > 1e-4) {
        pose.ty[Bone.ROOT] = pose.ty[Bone.ROOT]! - fix;
        solve(pose);
        segs = resolve(pose, ops);
      }
      maxLock = Math.max(maxLock, Math.abs(fix));
      const f = rasterise(segs);
      // The fighter straddles its own origin horizontally, and the origin is
      // never ABOVE the art — though it IS legitimately below it on an airborne
      // frame, which is what tucked feet mean.
      if (f.ox < 0 || f.ox > f.w || f.oy < 0) {
        throw new Error(`bake: origin (${f.ox}, ${f.oy}) is wrong for frame ${f.w}x${f.h}`);
      }
      // Measured back off the FINISHED bitmap: world y of the lowest opaque row.
      // The end-to-end check on pose, raster, trim AND origin.
      const sole = (f.oy - (f.h - 0.5)) / PX_PER_UNIT;
      soleLo = Math.min(soleLo, sole); soleHi = Math.max(soleHi, sole);
      frames.push(f); owner.push(c);
    }
    report.push(`  ${name.padEnd(11)} ${String(spec.count).padStart(2)} frames x${spec.dur}` +
      ` = ${spec.count * spec.dur} sim frames, sole y ${soleLo.toFixed(2)}..${soleHi.toFixed(2)}`);
    const lo = -OUTLINE - 1.2, hi = spec.air ? 90 : -OUTLINE + 1.2;
    if (soleLo < lo || soleHi > hi) {
      throw new Error(`bake: ${name} is not planted on the ground line (sole y ` +
        `${soleLo.toFixed(2)}..${soleHi.toFixed(2)}, expected ${lo.toFixed(2)}..${hi.toFixed(2)})`);
    }
  }

  const order = frames.map((_, i) => i).sort((a, b) => frames[b]!.h - frames[a]!.h);
  let W = 0, H = 0, pos: { x: number; y: number }[] | null = null;
  for (const [cw, ch] of SIZES) {
    pos = shelf(frames, order, cw, ch);
    if (pos !== null) { W = cw; H = ch; break; }
  }
  if (pos === null) throw new Error('bake: frames do not fit the largest allowed atlas');
  const atlas = new Uint8Array(W * H * 4);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!, p = pos[i]!;
    for (let y = 0; y < f.h; y++) {
      const src = y * f.w * 4;
      atlas.set(f.rgba.subarray(src, src + f.w * 4), ((p.y + y) * W + p.x) * 4);
    }
  }
  bleed(atlas, W, PAD);

  const clips: Record<string, SpriteClip> = {};
  for (let c = 0; c < specs.length; c++) {
    const spec = specs[c]!;
    const list: SpriteFrame[] = [];
    for (let i = 0; i < frames.length; i++) {
      if (owner[i] !== c) continue;
      const f = frames[i]!, p = pos[i]!;
      list.push({ uv: [p.x, p.y, f.w, f.h], origin: [f.ox, f.oy], dur: spec.dur });
    }
    // Keyed by the AnimId NAME, never its numeric value: the enum can grow.
    clips[AnimId[spec.anim] ?? String(spec.anim)] = { frames: list, loopAt: spec.loopAt };
  }
  const sheet: SpriteSheet = { image: 'a.png', atlasW: W, atlasH: H, unitsPerPx: 1 / PX_PER_UNIT, clips };

  mkdirSync('public/art', { recursive: true });
  const png = encodePng(atlas, W, H);
  writeFileSync('public/art/a.png', png);
  writeFileSync('public/art/a.sheet.json', `${JSON.stringify(sheet, null, 2)}\n`);
  console.log('--- SunForce sprite bake: character A ---');
  for (const line of report) console.log(line);
  console.log(`  atlas ${W}x${H}, ${frames.length} frames, ${(png.length / 1024).toFixed(0)} KiB PNG`);
  console.log(`  unitsPerPx ${(1 / PX_PER_UNIT).toFixed(6)}, max ground correction ${maxLock.toFixed(2)} units`);
  console.log('  wrote public/art/a.png + public/art/a.sheet.json');
}

main();

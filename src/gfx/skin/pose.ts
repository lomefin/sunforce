// =============================================================================
// SunForce — src/gfx/skin/pose.ts
// THE SKELETON. 24 bones, one forward pass, and the seam every skin binds to.
//
// This file is PRESENTATION: floats, rebuilt from scratch every render frame
// from the sim's (charId, action, actionFrame, state, stateFrame). Nothing here
// is ever written back into SimState, so animation quality can change daily
// without touching a determinism hash.
//
// -----------------------------------------------------------------------------
// SPACES
// -----------------------------------------------------------------------------
// CONCEPT space is the 640x960 authoring sheet: x right, y DOWN, absolute,
// origin at the sheet's top-left. `CharDef.restPose` lives there because a
// designer reads those numbers straight off concept/<char>.svg.
//
// FIGHTER-LOCAL space is what a PoseBuffer holds: world units, x FORWARD,
// y UP, (0, 0) is the fighter's own ground point. `ConceptSpace.unitsPerPx`
// scales, and the y axis is NEGATED, exactly as src/data/compile.ts does it for
// boxes. A bone's LOCAL translation is its concept position minus its PARENT's
// concept position, converted the same way; ROOT is measured from the sheet's
// (originX, groundY), which for caporal.svg lands ROOT exactly on (0, 0).
//
// The skin adds SkinDrawOpts.worldX / worldY on top. Solve never knows where
// on the stage the fighter is standing.
//
// -----------------------------------------------------------------------------
// FACING IS scaleX = -1 ON ROOT. THAT IS THE WHOLE TRICK.
// -----------------------------------------------------------------------------
// Bones are BACK / FRONT relative to facing, never left / right. So mirroring
// the root mirrors every descendant's local translation across the midline and
// the B/F chains stay semantically correct: no bone swapping, no mirrored
// clips, no z-order inversion when a fighter turns around. BONE_Z keeps working
// untouched. Never mirror anything else, anywhere.
//
// -----------------------------------------------------------------------------
// MATRIX CONVENTIONS — READ BEFORE TOUCHING A SKIN
// -----------------------------------------------------------------------------
// `PoseBuffer.world` is ROW-MAJOR 2x3 per bone: [a b tx / c d ty], i.e.
//   world[i*6 + 0..5] = a, b, tx, c, d, ty
//   x' = a*x + b*y + tx        y' = c*x + d*y + ty
// The instance layout in src/gfx/batch.ts is COLUMN-MAJOR (column0 = (a, b),
// column1 = (c, d)). They are TRANSPOSES of each other. Use
// `writeInstanceAffine` rather than copying six floats and hoping.
//
// Local composition is T * R * S with rotation in radians, counter-clockwise
// (y is up). `stretch` is volume-preserving squash/stretch along the bone's
// local +Y — its length axis in this skeleton — so syEff = sy * stretch and
// sxEff = sx / stretch. stretch = 1 costs nothing and changes nothing.
// =============================================================================

import { Bone, BONE_COUNT, BONE_PARENTS } from '@/core/contracts';
import type { ConceptSpace, Facing, FxBox, PoseBuffer, SolveFn } from '@/core/contracts';
import { fx } from '@/core/fixed';
import { assert } from '@/core/assert';

/** Parents MUST precede children — that is what makes `solve` one pass. */
for (let i = 0; i < BONE_COUNT; i++) {
  assert(
    BONE_PARENTS[i]! < i,
    `BONE_PARENTS[${i}] = ${BONE_PARENTS[i]!} does not precede its child; solve is a single forward pass`,
  );
}

/** Mutable 2D point, world units. Callers own the instance; nothing here allocates. */
export interface Vec2 { x: number; y: number }

// -----------------------------------------------------------------------------
// Allocation
// -----------------------------------------------------------------------------

/** A fresh PoseBuffer at identity: no rotation, no translation, unit scale,
 *  neutral stretch, every bone visible, every world affine the identity. */
export function createPoseBuffer(): PoseBuffer {
  const p: PoseBuffer = {
    count: BONE_COUNT,
    rot: new Float32Array(BONE_COUNT),
    tx: new Float32Array(BONE_COUNT),
    ty: new Float32Array(BONE_COUNT),
    sx: new Float32Array(BONE_COUNT),
    sy: new Float32Array(BONE_COUNT),
    world: new Float32Array(BONE_COUNT * 6),
    stretch: new Float32Array(BONE_COUNT),
    visible: new Uint8Array(BONE_COUNT),
  };
  resetPose(p);
  return p;
}

/** Back to identity. Keeps the arrays; a pose is rebuilt, never reallocated. */
export function resetPose(p: PoseBuffer): void {
  p.rot.fill(0);
  p.tx.fill(0);
  p.ty.fill(0);
  p.sx.fill(1);
  p.sy.fill(1);
  p.stretch.fill(1);
  p.visible.fill(1);
  for (let i = 0; i < p.count; i++) {
    const o = i * 6;
    p.world[o] = 1; p.world[o + 1] = 0; p.world[o + 2] = 0;
    p.world[o + 3] = 0; p.world[o + 4] = 1; p.world[o + 5] = 0;
  }
}

// -----------------------------------------------------------------------------
// CONCEPT rest pose -> bone-LOCAL rest, world units
// -----------------------------------------------------------------------------

/**
 * A character's rest skeleton, converted once at load.
 * `tx`/`ty` are LOCAL (relative to the parent), `worldX`/`worldY` are the same
 * skeleton composed — the absolute fighter-local rest position of each bone,
 * which is what limb lengths and static bounds are measured from.
 */
export interface RestPose {
  readonly count: number;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly worldX: Float32Array;
  readonly worldY: Float32Array;
}

/** Concept pixels -> fighter-local world units. y is NEGATED: concept y runs DOWN. */
export function computeRestPose(
  concept: readonly (readonly [number, number])[],
  cs: ConceptSpace,
): RestPose {
  assert(
    concept.length === BONE_COUNT,
    `restPose has ${concept.length} bones, expected ${BONE_COUNT}`,
  );
  const u = cs.unitsPerPx;
  const tx = new Float32Array(BONE_COUNT);
  const ty = new Float32Array(BONE_COUNT);
  const worldX = new Float32Array(BONE_COUNT);
  const worldY = new Float32Array(BONE_COUNT);

  for (let i = 0; i < BONE_COUNT; i++) {
    const b = concept[i]!;
    const cx = b[0];
    const cy = b[1];
    assert(Number.isFinite(cx + cy), `restPose[${i}] is not finite: [${cx}, ${cy}]`);

    // Absolute first — same formulas as compile.ts's conceptX / conceptY.
    worldX[i] = (cx - cs.originX) * u;
    worldY[i] = (cs.groundY - cy) * u;

    const par = BONE_PARENTS[i]!;
    if (par < 0) {
      tx[i] = worldX[i]!;
      ty[i] = worldY[i]!;
    } else {
      // Parents precede children, so the parent's absolute is already final.
      tx[i] = worldX[i]! - worldX[par]!;
      ty[i] = worldY[i]! - worldY[par]!;
    }
  }
  return { count: BONE_COUNT, tx, ty, worldX, worldY };
}

/**
 * Memoised `computeRestPose`, keyed on the restPose array's identity so a
 * sampler can ask for it every frame for free. A CharDef owns exactly one
 * restPose array and exactly one ConceptSpace, so identity is a safe key.
 */
const REST_CACHE = new WeakMap<readonly (readonly [number, number])[], RestPose>();

export function restPoseOf(
  concept: readonly (readonly [number, number])[],
  cs: ConceptSpace,
): RestPose {
  let r = REST_CACHE.get(concept);
  if (r === undefined) {
    r = computeRestPose(concept, cs);
    REST_CACHE.set(concept, r);
  }
  return r;
}

/**
 * Loads the rest skeleton into `p` and applies facing. This is the starting
 * point of every sampled pose: the sampler then adds rotations on top, so a
 * move with no clip yet still reads as the character standing, never a T-pose.
 */
export function applyRest(p: PoseBuffer, rest: RestPose, facing: Facing = 1): void {
  p.rot.fill(0);
  p.sx.fill(1);
  p.sy.fill(1);
  p.stretch.fill(1);
  p.visible.fill(1);
  p.tx.set(rest.tx);
  p.ty.set(rest.ty);
  setFacing(p, facing);
}

/** Facing lives on ROOT's scaleX and NOWHERE else. Never mirror a bone. */
export function setFacing(p: PoseBuffer, facing: Facing): void {
  p.sx[Bone.ROOT] = facing;
}

// -----------------------------------------------------------------------------
// The solve — one forward pass, parents before children
// -----------------------------------------------------------------------------

export const solve: SolveFn = (p) => {
  const rot = p.rot, tx = p.tx, ty = p.ty, sx = p.sx, sy = p.sy;
  const stretch = p.stretch, world = p.world;
  const n = p.count;

  for (let i = 0; i < n; i++) {
    const st = stretch[i]!;
    let ex = sx[i]!;
    let ey = sy[i]!;
    if (st !== 1 && st !== 0) {
      ex /= st;     // volume-preserving: squash across, stretch along
      ey *= st;
    }
    const a = rot[i]!;
    const cs = Math.cos(a);
    const sn = Math.sin(a);

    // Local 2x3, row-major: T * R * S.
    const l0 = cs * ex, l1 = -sn * ey, l2 = tx[i]!;
    const l3 = sn * ex, l4 = cs * ey, l5 = ty[i]!;

    const o = i * 6;
    const par = BONE_PARENTS[i]!;
    if (par < 0) {
      world[o] = l0; world[o + 1] = l1; world[o + 2] = l2;
      world[o + 3] = l3; world[o + 4] = l4; world[o + 5] = l5;
      continue;
    }

    const q = par * 6;
    const m0 = world[q]!, m1 = world[q + 1]!, m2 = world[q + 2]!;
    const m3 = world[q + 3]!, m4 = world[q + 4]!, m5 = world[q + 5]!;

    world[o]     = m0 * l0 + m1 * l3;
    world[o + 1] = m0 * l1 + m1 * l4;
    world[o + 2] = m0 * l2 + m1 * l5 + m2;
    world[o + 3] = m3 * l0 + m4 * l3;
    world[o + 4] = m3 * l1 + m4 * l4;
    world[o + 5] = m3 * l2 + m4 * l5 + m5;
  }
};

// -----------------------------------------------------------------------------
// Queries — what the renderer and the camera ask of a solved pose
// -----------------------------------------------------------------------------

/** Fighter-local x of a solved bone. Add SkinDrawOpts.worldX for stage space. */
export function boneX(p: PoseBuffer, bone: Bone): number {
  return p.world[bone * 6 + 2]!;
}

/** Fighter-local y of a solved bone. 0 is the fighter's ground point. */
export function boneY(p: PoseBuffer, bone: Bone): number {
  return p.world[bone * 6 + 5]!;
}

/** Writes a solved bone's position into `out`. Returns `out`; allocates nothing. */
export function boneWorldPos(p: PoseBuffer, bone: Bone, out: Vec2): Vec2 {
  const o = bone * 6;
  out.x = p.world[o + 2]!;
  out.y = p.world[o + 5]!;
  return out;
}

/** Bone-local point -> fighter-local. This is how a limb tip, a part pivot or
 *  a spark anchor is found. Returns `out`; allocates nothing. */
export function transformPoint(
  p: PoseBuffer, bone: Bone, lx: number, ly: number, out: Vec2,
): Vec2 {
  const o = bone * 6;
  const a = p.world[o]!, b = p.world[o + 1]!, tx = p.world[o + 2]!;
  const c = p.world[o + 3]!, d = p.world[o + 4]!, ty = p.world[o + 5]!;
  out.x = a * lx + b * ly + tx;
  out.y = c * lx + d * ly + ty;
  return out;
}

/** Row-major world affine -> the batcher's COLUMN-major (a, b, c, d) at `at`.
 *  The transpose lives here so no skin has to remember it. */
export function writeInstanceAffine(
  p: PoseBuffer, bone: Bone, out: Float32Array, at: number,
): void {
  const o = bone * 6;
  out[at]     = p.world[o]!;      // column 0 = (m00, m10)
  out[at + 1] = p.world[o + 3]!;
  out[at + 2] = p.world[o + 1]!;  // column 1 = (m01, m11)
  out[at + 3] = p.world[o + 4]!;
}

/** Uniform scale magnitude of a solved bone, used to widen a capsule radius by
 *  whatever the pose did to that bone. Facing's -1 comes back positive. */
export function boneScale(p: PoseBuffer, bone: Bone): number {
  const o = bone * 6;
  const cx = Math.hypot(p.world[o]!, p.world[o + 3]!);
  const cy = Math.hypot(p.world[o + 1]!, p.world[o + 4]!);
  return cx > cy ? cx : cy;
}

// -----------------------------------------------------------------------------
// Visual bounds — for culling and for the camera's framing
// -----------------------------------------------------------------------------

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function createBounds(): Bounds {
  return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/**
 * Bounds of a SOLVED pose, fighter-local world units. Each visible bone
 * contributes a disc of `radii[bone]` (world units — StickDef.radii already is)
 * grown by that bone's world scale, plus `pad` for ink outlines and plumes.
 * Bones with no radius still contribute their point. Returns `out`.
 */
export function poseBounds(
  p: PoseBuffer,
  out: Bounds,
  radii?: readonly number[] | null,
  pad = 0,
): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < p.count; i++) {
    if (p.visible[i] === 0) continue;
    const o = i * 6;
    const x = p.world[o + 2]!;
    const y = p.world[o + 5]!;
    let r = radii?.[i] ?? 0;
    if (r !== 0) r *= boneScale(p, i as Bone);
    r += pad;
    if (x - r < minX) minX = x - r;
    if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r;
    if (y + r > maxY) maxY = y + r;
  }

  if (minX > maxX) { minX = 0; maxX = 0; minY = 0; maxY = 0; }  // nothing visible
  out.minX = minX; out.minY = minY; out.maxX = maxX; out.maxY = maxY;
  return out;
}

/**
 * Static bounds straight off the rest skeleton, no solve needed. This is what a
 * CharacterSkin's `localBounds()` wants: a stable, pose-independent envelope
 * computed once at load.
 */
export function restBounds(
  rest: RestPose,
  out: Bounds,
  radii?: readonly number[] | null,
  pad = 0,
): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < rest.count; i++) {
    const x = rest.worldX[i]!;
    const y = rest.worldY[i]!;
    const r = (radii?.[i] ?? 0) + pad;
    if (x - r < minX) minX = x - r;
    if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r;
    if (y + r > maxY) maxY = y + r;
  }

  if (minX > maxX) { minX = 0; maxX = 0; minY = 0; maxY = 0; }
  out.minX = minX; out.minY = minY; out.maxX = maxX; out.maxY = maxY;
  return out;
}

/** Float bounds -> the FxBox the CharacterSkin contract asks for. (x, y) is the
 *  MIN corner, matching compile.ts's conceptBox. Allocates: call it at load and
 *  cache the result, not once per frame. */
export function boundsToFxBox(b: Bounds): FxBox {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return {
    x: fx(b.minX),
    y: fx(b.minY),
    w: fx(w > 0 ? w : 0),
    h: fx(h > 0 ? h : 0),
  };
}

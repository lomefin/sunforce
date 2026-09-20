// =============================================================================
// SunForce — src/gfx/shaders/stick.ts
// The stick-figure program: one instanced quad per bone, shaded as a signed
// distance field capsule.
//
// -----------------------------------------------------------------------------
// THIS IS A PLACEHOLDER SKIN. IT IS NOT ALLOWED TO LOOK LIKE ONE.
// -----------------------------------------------------------------------------
// CLAUDE.md is explicit that SunForce is not pixel art and not 8-bit, and the
// stick figures are the first thing anyone will ever see of it. A pile of
// 1px lines would set the wrong expectation for the whole project and, worse,
// would hide real rig bugs behind visual noise.
//
// So each bone is a TAPERED CAPSULE (a 2D round cone) evaluated as an exact
// signed distance field in the fragment shader:
//
//   - SMOOTH AT ANY RESOLUTION. The silhouette is analytic; anti-aliasing is
//     `fwidth` of the distance, so it is exactly one device pixel wide at 4K,
//     at 720p, and through the camera's whole 0.80..1.30 zoom range. Nothing is
//     rasterised into a texture and then scaled.
//   - ROUND JOINTS FOR FREE. Capsules have round caps, so two bones sharing a
//     joint blend into a continuous limb with no seam and no extra geometry.
//   - A REAL INK OUTLINE. The `#2A2118`-at-1..3px ink line is what makes the
//     concept art read as hand-drawn; the SDF gives it as a second threshold on
//     the SAME distance, so the outline is free, always closed, and exactly as
//     smooth as the silhouette.
//   - A TUBE, NOT A PILL. `sqrt(1 - e^2)` across the limb is the cross-section
//     of a cylinder, so limbs have volume instead of reading as flat lozenges.
//   - A SUBTLE RIM LIGHT along the stage's light direction, computed from the
//     analytic SDF gradient and pushed to the silhouette — the same cheap trick
//     the baked-parts skin will do with the material atlas's G channel, so the
//     two skins already look like they belong to one game.
//   - PER-FIGHTER TINT, ink colour and rim colour ride on the instance, so both
//     fighters and every accessory proxy draw in ONE draw call.
//
// -----------------------------------------------------------------------------
// INSTANCE LAYOUT — the frozen 24 floats of gfx/batch.ts, reinterpreted
// -----------------------------------------------------------------------------
// Reinterpretation is per PROGRAM. The buffer, the VAO and the batcher are
// untouched, which is exactly why the textured-parts skin later needs no new
// path: it binds the same VAO to a different program that reads slot [2] as the
// UV rect it was named for.
//
//   [1] iXform  a,b,c,d          columns map the unit quad onto the capsule's
//                                padded oriented box (written by writeStickCapsule)
//   [2] iPos    tx,ty,-,-        that box's (0,0) corner in world units
//   [3] iCap    segLen, r0, r1, ink      <- slot [2] "u0,v0,u1,v1"
//                                bone length and BODY radii in world units,
//                                plus the ink width. The silhouette radius is
//                                r + ink, so `StickDef.radii` stays the radius
//                                of the limb the animator sees.
//   [4] iTint   body colour RGBA
//   [5] iFx     flash, rimStrength, alpha, shade   <- "sparkleAmt" is `shade`
//   [6] iMat    inkRGB, rimRGB, 0, 0               <- slot [5] material UVs
//                                packed as r*65536 + g*256 + b, exact in fp32
//
// Uniforms: uViewProj (mat3, column major) and uRimDir (world-space unit vector
// pointing TOWARD the light — feed it StageDef.rimLightDir).
// =============================================================================

import type { InstanceWriter } from '@/core/contracts';
import { I, MATERIAL_KEY, makeMaterial } from '@/gfx/batch';
import type { Material } from '@/gfx/batch';
import { createProgram } from '@/gfx/programs';
import type { ProgramSource, ShaderProgram } from '@/gfx/programs';

/**
 * Extra world units of quad beyond the silhouette, so the outermost half-pixel
 * of anti-aliasing is not clipped by the quad's own edge. The vertex shader and
 * `writeStickCapsule` must agree exactly, so the number is injected into the
 * GLSL from here and exists in exactly one place.
 */
export const STICK_AA_PAD = 2.0;

const AA_PAD_GLSL = STICK_AA_PAD.toFixed(1);

// -----------------------------------------------------------------------------
// GLSL
// -----------------------------------------------------------------------------

export const STICK_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iXform;   // a, b, c, d  (columns)
layout(location = 2) in vec4 iPos;     // tx, ty, z, -
layout(location = 3) in vec4 iCap;     // segLen, r0, r1, ink
layout(location = 4) in vec4 iTint;    // body colour RGBA
layout(location = 5) in vec4 iFx;      // flash, rimStrength, alpha, shade
layout(location = 6) in vec4 iMat;     // packed ink RGB, packed rim RGB, -, -

uniform mat3 uViewProj;
uniform vec2 uRimDir;

/** Position in the capsule's own frame, world units: x along the bone from its
 *  first joint, y across it. The ONLY interpolated varying. */
out vec2 vLocal;

flat out vec4 vCap;
flat out vec4 vTint;
flat out vec4 vFx;
flat out vec2 vLight;
flat out vec3 vInk;
flat out vec3 vRim;

vec3 unpackRGB(float v) {
  float b = floor(mod(v, 256.0));
  float g = floor(mod(v / 256.0, 256.0));
  float r = floor(v / 65536.0);
  return vec3(r, g, b) * (1.0 / 255.0);
}

void main() {
  float ink = iCap.w;
  // Must match writeStickCapsule() exactly, or the SDF frame slides off the quad.
  float pad = max(iCap.y, iCap.z) + ink + max(${AA_PAD_GLSL}, ink);

  vLocal = vec2(aCorner.x * (iCap.x + 2.0 * pad) - pad,
                aCorner.y * (2.0 * pad) - pad);

  vCap = iCap;
  vTint = iTint;
  vFx = iFx;
  vInk = unpackRGB(iMat.x);
  vRim = unpackRGB(iMat.y);

  // The capsule frame is orthonormal in world units, so rotating the world-space
  // light into it is two dot products with the normalised columns, and the
  // fragment shader can then work entirely in local space.
  vec2 ax = iXform.xy;
  vec2 ay = iXform.zw;
  ax /= max(length(ax), 1e-6);
  ay /= max(length(ay), 1e-6);
  vLight = vec2(dot(uRimDir, ax), dot(uRimDir, ay));

  vec2 world = mat2(iXform.xy, iXform.zw) * aCorner + iPos.xy;
  vec3 clip = uViewProj * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`;

export const STICK_FRAG = `#version 300 es
precision highp float;

in vec2 vLocal;

flat in vec4 vCap;    // segLen, r0, r1, ink
flat in vec4 vTint;
flat in vec4 vFx;     // flash, rimStrength, alpha, shade
flat in vec2 vLight;
flat in vec3 vInk;
flat in vec3 vRim;

out vec4 oColor;

/**
 * Signed distance to a tapered capsule whose spine runs (0,0) -> (L,0) with
 * radius R0 at the start and R1 at the end, plus its outward unit gradient.
 * Returns vec3(distance, gradient.x, gradient.y).
 *
 * The three branches are the start cap, the end cap, and the slanted side; the
 * gradient is exact in each, which is what lets the rim light key off a real
 * surface normal instead of a screen-space derivative.
 */
vec3 capsuleSD(vec2 p, float L, float R0, float R1) {
  if (L < 1e-3) {
    // Degenerate bone: a disc. Keeps joints, heads and accessory puffs exact.
    float dd = length(p);
    vec2 gg = dd > 1e-5 ? p / dd : vec2(0.0, 1.0);
    return vec3(dd - max(R0, R1), gg.x, gg.y);
  }

  float sy = p.y < 0.0 ? -1.0 : 1.0;
  vec2 q = vec2(p.x, abs(p.y));

  float b = clamp((R0 - R1) / L, -0.999, 0.999);
  float a = sqrt(max(1e-8, 1.0 - b * b));

  float k = a * q.x - b * q.y;
  if (k < 0.0) {
    float dd = length(q);
    vec2 gg = dd > 1e-5 ? q / dd : vec2(-1.0, 0.0);
    return vec3(dd - R0, gg.x, gg.y * sy);
  }
  if (k > a * L) {
    vec2 w = q - vec2(L, 0.0);
    float dd = length(w);
    vec2 gg = dd > 1e-5 ? w / dd : vec2(1.0, 0.0);
    return vec3(dd - R1, gg.x, gg.y * sy);
  }
  return vec3(dot(q, vec2(b, a)) - R0, b, a * sy);
}

void main() {
  float L = max(vCap.x, 0.0);
  float ink = max(vCap.w, 0.0);
  float r0 = max(vCap.y, 0.0);
  float r1 = max(vCap.z, 0.0);

  // The radii are the radii of the LIMB; the ink is drawn around it, so the
  // silhouette sits ink units further out. An animator thickening a forearm
  // never has to think about the outline eating it.
  vec3 sd = capsuleSD(vLocal, L, r0 + ink, r1 + ink);
  float d = sd.x;
  vec2 n = sd.yz;

  // One device pixel of coverage, whatever the resolution or the camera zoom.
  float aa = max(fwidth(d), 1e-5);
  float cover = clamp(0.5 - d / aa, 0.0, 1.0);
  if (cover <= 0.0) discard;
  float bodyCover = clamp(0.5 - (d + ink) / aa, 0.0, 1.0);

  // e = 0 on the spine, 1 at the body's edge. mix(r0,r1,t) is the EXACT local
  // radius of a round cone, not an approximation.
  float t = clamp(vLocal.x / max(L, 1e-4), 0.0, 1.0);
  float rLocal = max(mix(r0, r1, t), 1e-3);
  float e = clamp(1.0 + (d + ink) / rLocal, 0.0, 1.0);

  // Cylindrical cross-section: bright along the spine, falling off to the edge.
  float dome = sqrt(max(0.0, 1.0 - e * e));
  float shade = clamp(vFx.w, 0.0, 1.0);
  vec3 body = vTint.rgb * mix(1.0, 0.60 + 0.48 * dome, shade);

  // Rim: the lit side of the surface, pushed hard toward the silhouette.
  float rim = pow(max(dot(n, vLight), 0.0), 1.6) * pow(e, 2.4);
  body = mix(body, vRim, clamp(rim * max(vFx.y, 0.0), 0.0, 1.0));

  // Ink underneath, body composited over it inside this one fragment, so the
  // outline never double-blends and stays exactly ink units wide.
  vec3 col = mix(vInk, body, bodyCover / max(cover, 1e-4));
  col = mix(col, vec3(1.0), clamp(vFx.x, 0.0, 1.0));

  oColor = vec4(col, cover * clamp(vFx.z, 0.0, 1.0) * vTint.a);
}
`;

export const STICK_PROGRAM_SOURCE: ProgramSource = {
  name: 'stick',
  vert: STICK_VERT,
  frag: STICK_FRAG,
};

/** Default light direction: high and behind-left. Override with the stage's. */
export const STICK_DEFAULT_RIM_DIR: readonly [number, number] = [-0.55, 0.84];

export const createStickProgram = (gl: WebGL2RenderingContext): ShaderProgram => {
  const p = createProgram(gl, STICK_PROGRAM_SOURCE);
  p.use();
  p.setVec2('uRimDir', STICK_DEFAULT_RIM_DIR[0], STICK_DEFAULT_RIM_DIR[1]);
  return p;
};

/** Ready-to-use material for gfx/batch.ts. Untextured; straight alpha. */
export const createStickMaterial = (gl: WebGL2RenderingContext): Material =>
  makeMaterial(MATERIAL_KEY.STICK, createStickProgram(gl), { blend: 'alpha' });

/** World-space direction pointing TOWARD the light. Normalised here. */
export const setStickLight = (program: ShaderProgram, x: number, y: number): void => {
  const len = Math.hypot(x, y) || 1;
  program.use();
  program.setVec2('uRimDir', x / len, y / len);
};

// -----------------------------------------------------------------------------
// Instance encoding
// -----------------------------------------------------------------------------

/**
 * Everything about a fighter's stick look that does NOT change per bone. Build
 * one per fighter per frame (or keep one and mutate `flash`/`alpha`), so the
 * per-bone call stays a list of numbers and allocates nothing.
 */
export interface StickStyle {
  /** 0xRRGGBB ink outline colour. */
  ink: number;
  /** 0xRRGGBB rim light colour. */
  rim: number;
  /** 0..1 rim light strength. */
  rimStrength: number;
  /** 0..1 mix-to-white. THE hit flash. */
  flash: number;
  /** 0..1 overall opacity. */
  alpha: number;
  /** 0..1 how much cylindrical shading to apply. 1 = full volume. */
  shade: number;
  /** Multiplied into every bone colour — the costume / P2 colourway. */
  tintR: number;
  tintG: number;
  tintB: number;
}

/** 0xRRGGBB packed for the instance stream. Exact in fp32 (max 16777215). */
export const packRGB = (hex: number): number => (hex & 0xffffff) >>> 0;

/** A sane style straight from `StickDef.palette`. */
export const stickStyleFromPalette = (
  palette: { readonly ink: number; readonly rim: number },
  over: Partial<StickStyle> = {},
): StickStyle => ({
  ink: palette.ink,
  rim: palette.rim,
  rimStrength: 0.5,
  flash: 0,
  alpha: 1,
  shade: 1,
  tintR: 1,
  tintG: 1,
  tintB: 1,
  ...over,
});

/**
 * Writes ONE bone capsule.
 *
 * `(x0,y0)`-`(x1,y1)` are the bone's two joints in WORLD UNITS (x right, y up,
 * ground at 0) — i.e. the solved PoseBuffer positions, already through the
 * facing flip. `r0`/`r1` are the limb radii at those joints (`StickDef.radii`;
 * pass the same value twice for an untapered limb, or a smaller `r1` for a
 * forearm that thins toward the hand). `ink` is `StickDef.outline`.
 *
 * The affine maps the unit quad onto the capsule's padded oriented box, so the
 * fragment shader's local frame is the bone's own frame with the first joint at
 * the origin. Zero-length bones are legal and draw as a disc.
 */
export const writeStickCapsule = (
  out: InstanceWriter,
  x0: number, y0: number, x1: number, y1: number,
  r0: number, r1: number, ink: number,
  color: number, z: number, style: StickStyle,
): void => {
  const rr0 = r0 > 0 ? r0 : 0;
  const rr1 = r1 > 0 ? r1 : 0;
  const ii = ink > 0 ? ink : 0;
  if (rr0 <= 0 && rr1 <= 0) return; // a radius-0 bone (ROOT, ACC pivots) draws nothing

  const pad = Math.max(rr0, rr1) + ii + Math.max(STICK_AA_PAD, ii);

  let ax = x1 - x0;
  let ay = y1 - y0;
  let len = Math.sqrt(ax * ax + ay * ay);
  if (len < 1e-6) {
    ax = 1;
    ay = 0;
    len = 0;
  } else {
    ax /= len;
    ay /= len;
  }
  // Perpendicular, left of the bone direction.
  const nx = -ay;
  const ny = ax;

  const spanX = len + 2 * pad;
  const spanY = 2 * pad;

  const i = out.push();
  i[I.A] = ax * spanX; i[I.B] = ay * spanX;
  i[I.C] = nx * spanY; i[I.D] = ny * spanY;
  // Quad corner (0,0) = first joint, backed off one pad along both axes.
  i[I.TX] = x0 - ax * pad - nx * pad;
  i[I.TY] = y0 - ay * pad - ny * pad;
  i[I.Z] = z;
  i[I.GLINT] = 0;

  i[I.U0] = len; i[I.V0] = rr0; i[I.U1] = rr1; i[I.V1] = ii;

  // These shifts are on a COLOUR, not on an FX value — see the note on rgbR in
  // gfx/batch.ts. Nothing here ever reaches the simulation's fixed-point maths.
  i[I.TINT_R] = (((color >> 16) & 0xff) / 255) * style.tintR;
  i[I.TINT_G] = (((color >> 8) & 0xff) / 255) * style.tintG;
  i[I.TINT_B] = ((color & 0xff) / 255) * style.tintB;
  i[I.TINT_A] = 1;

  i[I.FLASH] = style.flash;
  i[I.RIM] = style.rimStrength;
  i[I.ALPHA] = style.alpha;
  i[I.SPARKLE] = style.shade;

  i[I.MAT_U0] = packRGB(style.ink);
  i[I.MAT_V0] = packRGB(style.rim);
  i[I.MAT_U1] = 0;
  i[I.MAT_V1] = 0;
};

/** A round blob — joint caps, the head, accessory puffs, the ground shadow. */
export const writeStickDisc = (
  out: InstanceWriter,
  cx: number, cy: number, r: number, ink: number,
  color: number, z: number, style: StickStyle,
): void => {
  writeStickCapsule(out, cx, cy, cx, cy, r, r, ink, color, z, style);
};

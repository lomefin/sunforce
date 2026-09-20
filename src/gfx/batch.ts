// =============================================================================
// SunForce — src/gfx/batch.ts
// THE instanced quad batcher. One draw call for many quads, and the only
// geometry primitive the renderer owns: the stick skin, the baked parts skin,
// the stage layers, sparks, HP bars and the F1 debug boxes all go through here.
//
// -----------------------------------------------------------------------------
// THE INSTANCE LAYOUT IS FROZEN IN contracts.ts (INSTANCE_FLOATS = 24)
// -----------------------------------------------------------------------------
//   [0]  a, b, c, d                 2x2 affine, COLUMN MAJOR:
//                                   column0 = (a, b), column1 = (c, d)
//   [1]  tx, ty, z, glintPhase      translation; z is a CPU sort key (see below)
//   [2]  u0, v0, u1, v1             UV rect: (u0,v0) is the corner at quad (0,0)
//   [3]  tintR, tintG, tintB, tintA 0..1
//   [4]  flash, rimStrength, alpha, sparkleAmt
//   [5]  matU0, matV0, matU1, matV1 material-atlas UVs (equal to [2] when the
//                                   albedo and material atlases share a layout)
//
// A quad's four corners are `mat2(a,b,c,d) * corner + (tx,ty)` where `corner`
// runs over the unit square. Columns ARE the quad's edge vectors, so a rotated,
// scaled, sheared or flipped quad is one 2x2 with no separate rotation uniform,
// and a fighter's facing flip is a negated first column — nothing special.
//
// WHY THIS LAYOUT AND NOT SOMETHING SIMPLER
// The placeholder stick figures need a transform and a colour; that is all.
// But the real skin is high-resolution rasterised vector costume parts sampled
// from a 2048^2 albedo atlas plus a 1024^2 material atlas, with per-instance
// hit flash, rim strength, sequin glint phase and a costume tint. If the
// batcher were built for flat untextured quads today, that skin would need a
// second, parallel path — and the whole point of the one-CharacterSkin-interface
// rule is that it must not. So the UV rects, the material UVs and the FX slot
// are carried from day one, even though M0's stick shader reinterprets two of
// them (see gfx/shaders/stick.ts). Reinterpretation is per PROGRAM; the buffer,
// the VAO and this file never change.
//
// Z IS A SORT KEY, NOT A DEPTH VALUE. ENGINE-DECISIONS §12 locks painter's
// order with no depth buffer (depth-testing alpha-blended quads haloes the
// ink outline). `z` travels with the instance so an emitter can sort BEFORE
// pushing; gl_Position.z is always 0.
//
// ATTRIBUTE LOCATIONS ARE FROZEN HERE and declared with `layout(location = N)`
// in every program's GLSL, so ONE VAO feeds every program and no program has to
// be linked with bindAttribLocation.
// =============================================================================

import { INSTANCE_FLOATS } from '@/core/contracts';
import type { InstanceWriter } from '@/core/contracts';
import { devWarn } from '@/core/assert';
import { createProgram } from '@/gfx/programs';
import type { ShaderProgram } from '@/gfx/programs';

// -----------------------------------------------------------------------------
// Frozen vertex-attribute layout
// -----------------------------------------------------------------------------

/** Attribute locations. Every batch program must declare exactly these. */
export const ATTR = {
  /** vec2, per VERTEX: the unit quad corner, (0,0)..(1,1). */
  CORNER: 0,
  /** vec4, per INSTANCE: a, b, c, d. */
  XFORM: 1,
  /** vec4, per INSTANCE: tx, ty, z, glintPhase. */
  POS: 2,
  /** vec4, per INSTANCE: u0, v0, u1, v1. */
  UV: 3,
  /** vec4, per INSTANCE: tint RGBA. */
  TINT: 4,
  /** vec4, per INSTANCE: flash, rimStrength, alpha, sparkleAmt. */
  FX: 5,
  /** vec4, per INSTANCE: material-atlas UV rect. */
  MATUV: 6,
} as const;

/** Float indices inside one instance. Use these instead of magic numbers. */
export const I = {
  A: 0, B: 1, C: 2, D: 3,
  TX: 4, TY: 5, Z: 6, GLINT: 7,
  U0: 8, V0: 9, U1: 10, V1: 11,
  TINT_R: 12, TINT_G: 13, TINT_B: 14, TINT_A: 15,
  FLASH: 16, RIM: 17, ALPHA: 18, SPARKLE: 19,
  MAT_U0: 20, MAT_V0: 21, MAT_U1: 22, MAT_V1: 23,
} as const;

export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

/**
 * Reserved material keys, so parallel agents do not collide on
 * `CharacterSkin.materialKey`. Instances sharing a key flush together.
 */
export const MATERIAL_KEY = {
  SOLID: 1,
  STICK: 2,
  STAGE: 3,
  FX: 4,
  HUD: 5,
  DEBUG: 6,
  /** Baked part atlases: PARTS_BASE + CharId. */
  PARTS_BASE: 16,
} as const;

// -----------------------------------------------------------------------------
// Materials
// -----------------------------------------------------------------------------

export type BlendMode = 'alpha' | 'premultiplied' | 'add' | 'none';

/** What a run of instances is drawn WITH. Changing it forces a flush. */
export interface Material {
  /** Batching key. See MATERIAL_KEY. */
  readonly key: number;
  readonly program: ShaderProgram;
  /** Texture unit 0. null binds the built-in 1x1 white texture. */
  readonly albedo: WebGLTexture | null;
  /** Texture unit 1. null binds the built-in 1x1 white texture. */
  readonly material: WebGLTexture | null;
  readonly blend: BlendMode;
}

export interface MaterialOptions {
  readonly albedo?: WebGLTexture | null;
  readonly material?: WebGLTexture | null;
  readonly blend?: BlendMode;
}

export const makeMaterial = (key: number, program: ShaderProgram, o: MaterialOptions = {}): Material => ({
  key,
  program,
  albedo: o.albedo ?? null,
  material: o.material ?? null,
  blend: o.blend ?? 'alpha',
});

// -----------------------------------------------------------------------------
// The built-in textured/tinted quad program
//
// This is the default material: it samples the albedo with the instance's UV
// rect, multiplies by the tint, mixes to white by `flash` and scales by
// `alpha`. With the built-in white texture bound it is a flat coloured quad, so
// HP bars, the F1 debug boxes and untextured stage fills all use it unchanged.
// gfx/shaders/part.ts will add the richer program (palette LUT, material atlas,
// rim from mat.G, sequin glint) against this same VAO.
// -----------------------------------------------------------------------------

export const QUAD_VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iXform;
layout(location = 2) in vec4 iPos;
layout(location = 3) in vec4 iUV;
layout(location = 4) in vec4 iTint;
layout(location = 5) in vec4 iFx;

uniform mat3 uViewProj;

out vec2 vUV;
flat out vec4 vTint;
flat out vec4 vFx;

void main() {
  vec2 world = mat2(iXform.xy, iXform.zw) * aCorner + iPos.xy;
  vUV = mix(iUV.xy, iUV.zw, aCorner);
  vTint = iTint;
  vFx = iFx;
  vec3 clip = uViewProj * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`;

export const QUAD_FRAG = `#version 300 es
precision highp float;

in vec2 vUV;
flat in vec4 vTint;
flat in vec4 vFx;

uniform sampler2D uAlbedo;

out vec4 oColor;

void main() {
  vec4 c = texture(uAlbedo, vUV) * vTint;
  c.rgb = mix(c.rgb, vec3(1.0), clamp(vFx.x, 0.0, 1.0));
  c.a *= clamp(vFx.z, 0.0, 1.0);
  oColor = c;
}
`;

// -----------------------------------------------------------------------------
// Instance writers — every one fills all 24 floats, because `push()` hands back
// a RECYCLED slot whose contents are last frame's instance.
// -----------------------------------------------------------------------------

/**
 * 0xRRGGBB -> the three 0..1 channels.
 *
 * NOTE FOR THE LINT WALL: the `>>` here is on a COLOUR, not on an FX value. The
 * mirror-safety rule that bans shifts exists because `>>` floors where `|0`
 * truncates, which breaks side parity on negative fixed-point numbers. These
 * operands are unsigned 24-bit literals and never reach the simulation.
 */
export const rgbR = (hex: number): number => ((hex >> 16) & 0xff) / 255;
export const rgbG = (hex: number): number => ((hex >> 8) & 0xff) / 255;
export const rgbB = (hex: number): number => (hex & 0xff) / 255;

/**
 * An axis-aligned, fully textured quad. `(u0,v0)` is the texel corner that lands
 * on the quad's (x, y) corner — with world +y UP and most atlases v-down, an
 * emitter usually passes v0 > v1.
 */
export const writeSprite = (
  out: InstanceWriter,
  x: number, y: number, w: number, h: number,
  u0: number, v0: number, u1: number, v1: number,
  r: number, g: number, b: number, a: number,
  z = 0,
): Float32Array => {
  const i = out.push();
  i[I.A] = w; i[I.B] = 0; i[I.C] = 0; i[I.D] = h;
  i[I.TX] = x; i[I.TY] = y; i[I.Z] = z; i[I.GLINT] = 0;
  i[I.U0] = u0; i[I.V0] = v0; i[I.U1] = u1; i[I.V1] = v1;
  i[I.TINT_R] = r; i[I.TINT_G] = g; i[I.TINT_B] = b; i[I.TINT_A] = a;
  i[I.FLASH] = 0; i[I.RIM] = 0; i[I.ALPHA] = 1; i[I.SPARKLE] = 0;
  i[I.MAT_U0] = u0; i[I.MAT_V0] = v0; i[I.MAT_U1] = u1; i[I.MAT_V1] = v1;
  return i;
};

/** A flat coloured rectangle in world units. The HUD and debug-box workhorse. */
export const writeQuad = (
  out: InstanceWriter,
  x: number, y: number, w: number, h: number,
  color: number, alpha = 1, z = 0,
): Float32Array =>
  writeSprite(out, x, y, w, h, 0, 0, 1, 1, rgbR(color), rgbG(color), rgbB(color), alpha, z);

/**
 * Column-major 3x3 orthographic projection from world units to clip space, for
 * `uViewProj`. World is x right, y UP, ground at y = 0, so there is no flip
 * anywhere: `t` is simply the higher world y.
 */
export const orthoMat3 = (out: Float32Array, left: number, right: number, bottom: number, top: number): Float32Array => {
  const rl = right - left || 1;
  const tb = top - bottom || 1;
  out[0] = 2 / rl; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = 2 / tb; out[5] = 0;
  out[6] = -(right + left) / rl; out[7] = -(top + bottom) / tb; out[8] = 1;
  return out;
};

// -----------------------------------------------------------------------------
// QuadBatch
// -----------------------------------------------------------------------------

export interface QuadBatchOptions {
  /** Instances the buffer starts with. It grows on demand. */
  readonly capacity?: number;
  /** Hard ceiling; past it the batch auto-flushes instead of growing. */
  readonly maxCapacity?: number;
}

const DEFAULT_CAPACITY = 2048;
const DEFAULT_MAX_CAPACITY = 65536;

/** Unit quad, TRIANGLE_STRIP order: (0,0) (1,0) (0,1) (1,1). */
const QUAD_CORNERS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

export class QuadBatch implements InstanceWriter {
  readonly gl: WebGL2RenderingContext;
  /** The built-in textured/tinted quad program. */
  readonly solid: ShaderProgram;
  /** Ready-made material: built-in program, white texture, alpha blend. */
  readonly solidMaterial: Material;
  /** 1x1 opaque white. Bound wherever a material leaves a texture slot null. */
  readonly white: WebGLTexture;

  /** Draw calls issued since `beginFrame()`. The number to keep an eye on. */
  drawCalls = 0;
  /** Instances drawn since `beginFrame()`. */
  instancesDrawn = 0;

  private data: Float32Array;
  private views: (Float32Array | undefined)[];
  private n = 0;
  private capacity: number;
  private readonly maxCapacity: number;

  private readonly vao: WebGLVertexArrayObject;
  private readonly cornerVbo: WebGLBuffer;
  private instVbo: WebGLBuffer;

  private readonly viewProj = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private current: Material | null = null;
  private blend: BlendMode | null = null;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext, opts: QuadBatchOptions = {}) {
    this.gl = gl;
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.maxCapacity = Math.max(this.capacity, opts.maxCapacity ?? DEFAULT_MAX_CAPACITY);
    this.data = new Float32Array(this.capacity * INSTANCE_FLOATS);
    this.views = new Array<Float32Array | undefined>(this.capacity);

    const vao = gl.createVertexArray();
    const cornerVbo = gl.createBuffer();
    const instVbo = gl.createBuffer();
    if (vao === null || cornerVbo === null || instVbo === null) {
      throw new Error('gfx/batch: could not allocate the quad VAO/VBOs (context lost?)');
    }
    this.vao = vao;
    this.cornerVbo = cornerVbo;
    this.instVbo = instVbo;

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, cornerVbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(ATTR.CORNER);
    gl.vertexAttribPointer(ATTR.CORNER, 2, gl.FLOAT, false, 8, 0);
    gl.vertexAttribDivisor(ATTR.CORNER, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    this.bindInstanceAttribs();

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.solid = createProgram(gl, {
      name: 'quad',
      vert: QUAD_VERT,
      frag: QUAD_FRAG,
      samplers: { uAlbedo: 0, uMaterial: 1 },
    });
    this.solidMaterial = makeMaterial(MATERIAL_KEY.SOLID, this.solid);

    const white = gl.createTexture();
    if (white === null) throw new Error('gfx/batch: could not allocate the 1x1 white texture');
    this.white = white;
    gl.bindTexture(gl.TEXTURE_2D, white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Six vec4s at 16-byte strides inside one 96-byte instance, divisor 1. */
  private bindInstanceAttribs(): void {
    const gl = this.gl;
    const locs = [ATTR.XFORM, ATTR.POS, ATTR.UV, ATTR.TINT, ATTR.FX, ATTR.MATUV];
    for (let i = 0; i < locs.length; i++) {
      const loc = locs[i]!;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_BYTES, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
  }

  get count(): number {
    return this.n;
  }

  /**
   * A 24-float window on the next instance slot. ZERO ALLOCATION after the
   * first frame: the subarray views are pooled per slot and reused.
   *
   * TWO RULES.
   *   1. The slot is DIRTY — it holds whatever was there last frame. Fill all
   *      INSTANCE_FLOATS, or use writeQuad / writeSprite / writeStickCapsule.
   *   2. The view is valid only until the next `push()` or `flush()`.
   */
  push(): Float32Array {
    if (this.n >= this.capacity) this.makeRoom();
    const i = this.n++;
    let v = this.views[i];
    if (v === undefined) {
      v = this.data.subarray(i * INSTANCE_FLOATS, (i + 1) * INSTANCE_FLOATS);
      this.views[i] = v;
    }
    return v;
  }

  private makeRoom(): void {
    if (this.capacity < this.maxCapacity) {
      this.grow(Math.min(this.capacity * 2, this.maxCapacity));
      return;
    }
    // At the ceiling: draw what we have. Painter's order survives, because
    // everything already pushed is drawn before anything pushed after.
    this.flush();
  }

  private grow(next: number): void {
    const gl = this.gl;
    const data = new Float32Array(next * INSTANCE_FLOATS);
    data.set(this.data.subarray(0, this.n * INSTANCE_FLOATS));
    this.data = data;
    this.capacity = next;
    this.views = new Array<Float32Array | undefined>(next);

    gl.bindVertexArray(this.vao);
    gl.deleteBuffer(this.instVbo);
    const vbo = gl.createBuffer();
    if (vbo === null) throw new Error('gfx/batch: could not grow the instance buffer');
    this.instVbo = vbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, next * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    this.bindInstanceAttribs();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    devWarn(`gfx/batch: instance capacity grew to ${next}`);
  }

  /** Per-frame stat reset. Does not touch pending instances. */
  beginFrame(): void {
    this.drawCalls = 0;
    this.instancesDrawn = 0;
  }

  /**
   * The world -> clip matrix for every subsequent flush. Flushes first, because
   * a uniform applies to a whole draw call.
   */
  setViewProj(m: Float32Array): void {
    this.flush();
    this.viewProj.set(m.subarray(0, 9));
  }

  /**
   * Selects the material for subsequent pushes, flushing the previous run.
   *
   * A material rebuilt each frame (a new object with the same program, textures
   * and blend) does NOT break the batch — the comparison is on GPU state, not
   * on object identity, so an emitter is free to be careless about allocation.
   */
  use(m: Material): void {
    const cur = this.current;
    if (cur === m) return;
    if (
      cur !== null &&
      cur.program === m.program &&
      cur.albedo === m.albedo &&
      cur.material === m.material &&
      cur.blend === m.blend
    ) {
      this.current = m;
      return;
    }
    this.flush();
    this.current = m;
  }

  private setBlend(mode: BlendMode): void {
    if (this.blend === mode) return;
    const gl = this.gl;
    this.blend = mode;
    if (mode === 'none') {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    if (mode === 'alpha') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else if (mode === 'premultiplied') gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
  }

  /** Uploads and draws everything pending, then empties the batch. */
  flush(): void {
    const n = this.n;
    if (n === 0) return;
    const mat = this.current;
    if (mat === null) {
      this.n = 0;
      devWarn('gfx/batch: dropped instances pushed with no material bound — call use() first');
      return;
    }

    const gl = this.gl;
    mat.program.use();
    mat.program.setMat3('uViewProj', this.viewProj);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mat.albedo ?? this.white);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mat.material ?? this.white);
    gl.activeTexture(gl.TEXTURE0);

    this.setBlend(mat.blend);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, n * INSTANCE_FLOATS);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);

    this.n = 0;
    this.drawCalls++;
    this.instancesDrawn += n;
  }

  /** Throws pending instances away without drawing. For an aborted frame. */
  discard(): void {
    this.n = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.cornerVbo);
    gl.deleteBuffer(this.instVbo);
    gl.deleteTexture(this.white);
    this.solid.dispose();
    this.views = [];
    this.n = 0;
  }
}

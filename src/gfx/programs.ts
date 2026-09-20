// =============================================================================
// SunForce — src/gfx/programs.ts
// Shader compile / link, with error reporting that actually tells you where.
//
// WHY THIS FILE IS LONGER THAN "gl.createShader; gl.compileShader"
// A silent or unreadable shader failure is the worst debugging experience in
// graphics: the screen goes black, `gl.getError()` says nothing useful, and the
// driver's log is a bare `ERROR: 0:47: 'vRim' : undeclared identifier` against
// a source string nobody can see. Since every shader in this project is an
// exported template literal (so six agents need no build-config change), the
// line numbers in that log are meaningless unless something prints the source.
//
// So: on failure we parse the line numbers out of the log — handling BOTH the
// desktop GL form `ERROR: 0:47:` and the ANGLE/D3D form `ERROR: 0(47) :` — and
// print a numbered excerpt with the offending line marked. That turns a black
// screen into a diff you can read in the terminal.
//
// ATTRIBUTE LOCATIONS ARE DECLARED IN THE GLSL, not bound here. Every program
// that feeds off the instanced quad VAO uses `layout(location = N) in ...` with
// the locations frozen in gfx/batch.ts, so one VAO drives every program and
// nothing has to remember to call bindAttribLocation before linking.
// =============================================================================

import { DEV, devWarn } from '@/core/assert';

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type ShaderStage = 'vertex' | 'fragment' | 'link';

export class ShaderError extends Error {
  readonly stage: ShaderStage;
  readonly shaderName: string;
  readonly log: string;
  /** The fully preprocessed source that was handed to the driver. */
  readonly source: string;
  /** Multi-line, already formatted for a console or the #fatal overlay. */
  readonly detail: string;

  constructor(shaderName: string, stage: ShaderStage, log: string, source: string, detail: string) {
    super(`${shaderName}.${stage === 'link' ? 'link' : stage === 'vertex' ? 'vert' : 'frag'} failed`);
    this.name = 'ShaderError';
    this.shaderName = shaderName;
    this.stage = stage;
    this.log = log;
    this.source = source;
    this.detail = detail;
  }
}

// -----------------------------------------------------------------------------
// Log -> annotated source
// -----------------------------------------------------------------------------

/** `ERROR: 0:47: ...` (desktop GL / Mesa) and `ERROR: 0(47) : ...` (ANGLE). */
const LOG_LINE_PATTERNS: readonly RegExp[] = [
  /(?:ERROR|WARNING)\s*:\s*\d+\s*:\s*(\d+)\s*:/gi,
  /(?:ERROR|WARNING)\s*:\s*\d+\s*\(\s*(\d+)\s*\)/gi,
];

const linesFromLog = (log: string): number[] => {
  const out = new Set<number>();
  for (const re of LOG_LINE_PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(log);
    while (m !== null) {
      const n = Number.parseInt(m[1] ?? '', 10);
      if (Number.isFinite(n) && n > 0) out.add(n);
      m = re.exec(log);
    }
  }
  return [...out].sort((a, b) => a - b);
};

const CONTEXT_LINES = 3;

/**
 * Numbered source excerpt around each line the driver complained about, with
 * `>` on the offending lines. Falls back to the first 40 lines when the log
 * carries no position at all (some drivers report only "compile failed").
 */
const annotate = (source: string, log: string): string => {
  const src = source.split('\n');
  const hits = linesFromLog(log);
  const width = String(src.length).length;
  const render = (from: number, to: number): string => {
    const rows: string[] = [];
    for (let i = from; i <= to; i++) {
      const text = src[i - 1];
      if (text === undefined) continue;
      const mark = hits.includes(i) ? '>' : ' ';
      rows.push(`${mark} ${String(i).padStart(width, ' ')} | ${text}`);
    }
    return rows.join('\n');
  };

  if (hits.length === 0) {
    return `${render(1, Math.min(src.length, 40))}${src.length > 40 ? '\n  ...' : ''}`;
  }

  const blocks: string[] = [];
  let lastEnd = 0;
  for (const line of hits) {
    const from = Math.max(1, line - CONTEXT_LINES);
    const to = Math.min(src.length, line + CONTEXT_LINES);
    if (from > lastEnd + 1 && lastEnd !== 0) blocks.push('  ...');
    blocks.push(render(Math.max(from, lastEnd + 1), to));
    lastEnd = to;
  }
  return blocks.join('\n');
};

// -----------------------------------------------------------------------------
// Preprocessing
// -----------------------------------------------------------------------------

export type DefineValue = string | number | boolean;

/**
 * GLSL ES 3.00 requires `#version 300 es` to be the FIRST thing in the source,
 * so injected defines have to be spliced in AFTER it, not prepended. Getting
 * this wrong produces "#version directive must occur before anything else",
 * which is a confusing error for a file that plainly starts with #version.
 */
const withDefines = (src: string, defines: Readonly<Record<string, DefineValue>> | undefined): string => {
  const body = src.startsWith('\n') ? src.slice(1) : src;
  if (defines === undefined) return body;
  const keys = Object.keys(defines);
  if (keys.length === 0) return body;

  const lines = keys.map((k) => {
    const v = defines[k];
    if (v === true) return `#define ${k} 1`;
    if (v === false) return `#define ${k} 0`;
    return `#define ${k} ${String(v)}`;
  });

  const nl = body.indexOf('\n');
  if (body.startsWith('#version') && nl >= 0) {
    return `${body.slice(0, nl + 1)}${lines.join('\n')}\n${body.slice(nl + 1)}`;
  }
  return `${lines.join('\n')}\n${body}`;
};

// -----------------------------------------------------------------------------
// Compile + link
// -----------------------------------------------------------------------------

const compileStage = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
  name: string,
  stage: ShaderStage,
): WebGLShader => {
  const sh = gl.createShader(type);
  if (sh === null) throw new ShaderError(name, stage, 'gl.createShader returned null', source, 'The GL context is probably lost.');

  gl.shaderSource(sh, source);
  gl.compileShader(sh);

  // getShaderParameter forces a synchronous compile; do it once, at load.
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(sh) ?? '(driver returned no log)';
    gl.deleteShader(sh);
    const detail = `${log.trim()}\n\n${annotate(source, log)}`;
    throw new ShaderError(name, stage, log, source, detail);
  }
  return sh;
};

export interface ProgramSource {
  /** Shows up in every error message. Use the file name, e.g. 'stick'. */
  readonly name: string;
  readonly vert: string;
  readonly frag: string;
  readonly defines?: Readonly<Record<string, DefineValue>>;
  /** Uniform sampler name -> texture unit, applied once after linking. */
  readonly samplers?: Readonly<Record<string, number>>;
}

/**
 * A linked program plus its uniform table. Locations are enumerated once at
 * link time (ACTIVE_UNIFORMS) instead of being looked up per draw, because
 * `getUniformLocation` is a string hash on every driver and this is the inner
 * loop of every pass.
 */
export class ShaderProgram {
  readonly gl: WebGL2RenderingContext;
  readonly name: string;
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation>();
  private readonly attribs = new Map<string, number>();
  private disposed = false;

  constructor(gl: WebGL2RenderingContext, name: string, program: WebGLProgram) {
    this.gl = gl;
    this.name = name;
    this.program = program;

    const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info === null) continue;
      // Array uniforms are reported as `uThing[0]`; store both spellings.
      const base = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
      const loc = gl.getUniformLocation(program, info.name);
      if (loc === null) continue;
      this.uniforms.set(info.name, loc);
      this.uniforms.set(base, loc);
    }

    const na = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(program, i);
      if (info === null) continue;
      this.attribs.set(info.name, gl.getAttribLocation(program, info.name));
    }
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  /** null when the uniform does not exist or was optimised away. */
  uniform(name: string): WebGLUniformLocation | null {
    return this.uniforms.get(name) ?? null;
  }

  /** -1 when the attribute is not active in this program. */
  attribLocation(name: string): number {
    return this.attribs.get(name) ?? -1;
  }

  setFloat(name: string, v: number): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniform1f(l, v);
  }

  setInt(name: string, v: number): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniform1i(l, v);
  }

  setVec2(name: string, x: number, y: number): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniform2f(l, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniform3f(l, x, y, z);
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniform4f(l, x, y, z, w);
  }

  /** Column-major 3x3, length 9. The view-projection convention everywhere. */
  setMat3(name: string, m: Float32Array): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniformMatrix3fv(l, false, m);
  }

  setMat4(name: string, m: Float32Array): void {
    const l = this.uniform(name);
    if (l !== null) this.gl.uniformMatrix4fv(l, false, m);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteProgram(this.program);
    this.uniforms.clear();
    this.attribs.clear();
  }
}

/**
 * Compiles, links and validates one program. Throws `ShaderError` carrying a
 * ready-to-display `detail` string — hand it to gfx/gl.ts's `showFatal`.
 */
export const createProgram = (gl: WebGL2RenderingContext, src: ProgramSource): ShaderProgram => {
  const vertSrc = withDefines(src.vert, src.defines);
  const fragSrc = withDefines(src.frag, src.defines);

  const vs = compileStage(gl, gl.VERTEX_SHADER, vertSrc, src.name, 'vertex');
  let fs: WebGLShader;
  try {
    fs = compileStage(gl, gl.FRAGMENT_SHADER, fragSrc, src.name, 'fragment');
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }

  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new ShaderError(src.name, 'link', 'gl.createProgram returned null', vertSrc, 'The GL context is probably lost.');
  }

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Shaders are refcounted by the program; detach+delete immediately so a long
  // session with hot-reloaded shaders does not leak them.
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? '(driver returned no log)';
    gl.deleteProgram(program);
    const detail = [
      log.trim(),
      '',
      'Link failures are almost always a varying that the vertex shader writes',
      'and the fragment shader declares with a different type or qualifier',
      '(a `flat out` must be a `flat in`), or an `out` the fragment shader never',
      'reads. Both stages compiled, so the line numbers above are the linker’s.',
      '',
      '--- vertex ---',
      annotate(vertSrc, ''),
      '--- fragment ---',
      annotate(fragSrc, ''),
    ].join('\n');
    throw new ShaderError(src.name, 'link', log, `${vertSrc}\n${fragSrc}`, detail);
  }

  const wrapped = new ShaderProgram(gl, src.name, program);

  if (src.samplers !== undefined) {
    wrapped.use();
    for (const key of Object.keys(src.samplers)) {
      const unit = src.samplers[key];
      if (unit !== undefined) wrapped.setInt(key, unit);
    }
  }

  if (DEV) {
    // validateProgram is meaningful only against the current VAO/state, so a
    // warning here is informational — never fatal.
    gl.validateProgram(program);
    if (gl.getProgramParameter(program, gl.VALIDATE_STATUS) !== true) {
      const log = (gl.getProgramInfoLog(program) ?? '').trim();
      if (log !== '') devWarn(`gfx/programs: ${src.name} validate: ${log}`);
    }
  }

  return wrapped;
};

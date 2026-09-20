// =============================================================================
// SunForce — src/gfx/gl.ts
// WebGL2 context creation, capability probe, DPR/letterbox resize, context-loss
// handling, and the ONE path that turns a graphics failure into something the
// user can read instead of a black screen.
//
// WHY THE FATAL OVERLAY IS IN THIS FILE
// index.html ships a `#fatal` / `#fatal-msg` overlay and NOTHING writes to it
// today. A browser without WebGL2 (old Safari, a VM with software rendering
// disabled, a locked-down enterprise profile) would otherwise get the boot
// screen forever with one line in a console they will never open. `showFatal`
// is the single writer, it is defensive about the DOM (so it is safe in tests
// and in bare Node), and every throw in this module carries a message written
// for a human, not for a stack trace.
//
// LETTERBOXING — DONE IN CSS, NOT IN THE VIEWPORT
// The game is authored for LOGICAL_W x LOGICAL_H (1920x1080). We size the
// CANVAS ELEMENT to the largest 16:9 box that fits its container and give the
// drawing buffer exactly that many device pixels. The bars are then the page's
// own background (index.html paints it `--sf-ink`), so:
//   - no fragment is ever shaded for a black bar,
//   - `gl.viewport` is always the whole drawing buffer, so no pass can forget
//     to restore a letterboxed sub-rect and silently draw into a bar,
//   - a full-canvas post-process pass covers exactly the play area.
// `view` is still exposed as an explicit rect, because the post chain and any
// future render target want the number rather than a convention.
//
// NO DEPTH BUFFER. ENGINE-DECISIONS §12 locks painter's order for the two
// fighters (depth-testing alpha-blended quads haloes), so the context is
// created with depth: false and nothing here ever enables DEPTH_TEST.
// =============================================================================

import { LOGICAL_H, LOGICAL_W } from '@/core/contracts';
import { devWarn } from '@/core/assert';

// -----------------------------------------------------------------------------
// Errors + the fatal overlay
// -----------------------------------------------------------------------------

/** Anything this module refuses to continue past. `detail` is the long form. */
export class GlError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'GlError';
    this.detail = detail;
  }
}

const FATAL_ROOT_ID = 'fatal';
const FATAL_MSG_ID = 'fatal-msg';

/** Long-form text for any thrown value, including our own `detail` payloads. */
const describe = (err: unknown): string => {
  if (err instanceof GlError) return err.detail !== '' ? `${err.message}\n\n${err.detail}` : err.message;
  if (err instanceof Error) return err.stack !== undefined && err.stack !== '' ? err.stack : `${err.name}: ${err.message}`;
  return String(err);
};

/**
 * Reveals index.html's `#fatal` overlay with a readable reason. Safe to call
 * when the DOM is absent or the overlay has been removed — it always at least
 * reaches the console, and it never throws from inside an error path.
 */
export const showFatal = (err: unknown, where = 'SunForce'): void => {
  const text = `${where}\n\n${describe(err)}`;
  console.error(`[sunforce] ${text}`);
  if (typeof document === 'undefined') return;
  try {
    const msg = document.getElementById(FATAL_MSG_ID);
    if (msg !== null) msg.textContent = text;
    const root = document.getElementById(FATAL_ROOT_ID);
    if (root !== null) root.classList.add('show');
  } catch {
    // The overlay is a courtesy; never let it mask the original failure.
  }
};

/** Hides the overlay again (used when a lost context is restored). */
export const clearFatal = (): void => {
  if (typeof document === 'undefined') return;
  try {
    document.getElementById(FATAL_ROOT_ID)?.classList.remove('show');
    const msg = document.getElementById(FATAL_MSG_ID);
    if (msg !== null) msg.textContent = '';
  } catch {
    /* ignore */
  }
};

// -----------------------------------------------------------------------------
// Capabilities
// -----------------------------------------------------------------------------

/**
 * What this machine can actually do. Probed ONCE at boot; nothing here is
 * queried per frame (a `getParameter` is a pipeline flush on some drivers).
 */
export interface GlCaps {
  readonly maxTextureSize: number;
  readonly maxTextureUnits: number;
  readonly maxVertexAttribs: number;
  readonly maxSamples: number;
  /** Max anisotropy, or 0 when EXT_texture_filter_anisotropic is absent. */
  readonly anisotropy: number;
  /** Renderable float colour attachments — the later bloom/HDR chain wants this. */
  readonly colorBufferFloat: boolean;
  /** Renderable half-float attachments. The cheaper HDR path. */
  readonly colorBufferHalfFloat: boolean;
  readonly textureFloatLinear: boolean;
  /** UNMASKED_RENDERER_WEBGL when the debug extension exists, else ''. */
  readonly renderer: string;
  readonly vendor: string;
  /** True when the atlas pipeline's 2048^2 albedo will fit. */
  readonly atlasFits: boolean;
}

/** Attributes we need beyond the unit quad: 6 instance vec4s + 1 vertex vec2. */
const REQUIRED_VERTEX_ATTRIBS = 7;

/** ATLAS_ALBEDO_SIZE from the contract; kept local so this file probes, not imports policy. */
const WANTED_TEXTURE_SIZE = 2048;

const probeCaps = (gl: WebGL2RenderingContext): GlCaps => {
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  return {
    maxTextureSize,
    maxTextureUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
    anisotropy: aniso === null ? 0 : (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number),
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float') !== null,
    colorBufferHalfFloat:
      gl.getExtension('EXT_color_buffer_float') !== null ||
      gl.getExtension('EXT_color_buffer_half_float') !== null,
    textureFloatLinear: gl.getExtension('OES_texture_float_linear') !== null,
    renderer: dbg === null ? '' : String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)),
    vendor: dbg === null ? '' : String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)),
    atlasFits: maxTextureSize >= WANTED_TEXTURE_SIZE,
  };
};

// -----------------------------------------------------------------------------
// The host
// -----------------------------------------------------------------------------

/** Device-pixel rectangle inside the drawing buffer. Mutated in place on resize. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GlHostOptions {
  /** Defaults to the element with id `game`. */
  readonly canvas?: HTMLCanvasElement;
  /** Element whose client box the canvas is fitted into. Defaults to the canvas's parent. */
  readonly container?: HTMLElement;
  /** Clamp for devicePixelRatio. 2 is plenty for SDF limbs and halves 4K fill cost. */
  readonly maxDpr?: number;
  /**
   * `desynchronized: true` shaves a frame of presentation latency, which matters
   * in a fighting game, but has produced tearing on a handful of Windows/ANGLE
   * configurations. Off by default; flip it once we can test on real hardware.
   */
  readonly desynchronized?: boolean;
  /** Passed straight through; the defaults below are the ones M0 wants. */
  readonly powerPreference?: WebGLPowerPreference;
  /** Fit the canvas to its container. Off means the caller owns sizing entirely. */
  readonly autoResize?: boolean;
}

type Unsubscribe = () => void;

export interface GlHost {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;
  /** Live device-pixel viewport. The same object every frame — read, never keep a copy. */
  readonly view: Viewport;
  /** CSS pixels the canvas occupies (the letterboxed 16:9 box). */
  readonly cssW: number;
  readonly cssH: number;
  readonly dpr: number;
  /** True once the context has been lost and not yet restored. */
  readonly lost: boolean;
  /**
   * Re-measures and, if anything changed, resizes the drawing buffer and calls
   * every `onResize` listener. Cheap to call every frame: it only touches layout
   * when a resize event or a DPR change marked it dirty.
   */
  resize(): boolean;
  /** gl.viewport + gl.scissor to the full drawing buffer. Call at the top of a frame. */
  applyViewport(): void;
  onResize(cb: (cssW: number, cssH: number, dpr: number) => void): Unsubscribe;
  onContextLost(cb: () => void): Unsubscribe;
  onContextRestored(cb: () => void): Unsubscribe;
  dispose(): void;
}

const listenerSet = <T extends (...args: never[]) => void>(): {
  add: (cb: T) => Unsubscribe;
  emit: (invoke: (cb: T) => void) => void;
  clear: () => void;
} => {
  const set = new Set<T>();
  return {
    add: (cb) => {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    emit: (invoke) => {
      for (const cb of set) {
        try {
          invoke(cb);
        } catch (err) {
          console.error('[sunforce] gl listener threw', err);
        }
      }
    },
    clear: () => set.clear(),
  };
};

class GlHostImpl implements GlHost {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;
  readonly view: Viewport = { x: 0, y: 0, w: 1, h: 1 };

  cssW = LOGICAL_W;
  cssH = LOGICAL_H;
  dpr = 1;
  lost = false;

  private readonly container: HTMLElement | null;
  private readonly maxDpr: number;
  private readonly autoResize: boolean;
  private dirty = true;
  private disposed = false;

  private readonly resized = listenerSet<(cssW: number, cssH: number, dpr: number) => void>();
  private readonly lostCbs = listenerSet<() => void>();
  private readonly restoredCbs = listenerSet<() => void>();

  private readonly ro: ResizeObserver | null;
  private readonly onWindowResize = (): void => {
    this.dirty = true;
  };
  private readonly onLost = (e: Event): void => {
    // Without preventDefault the browser will never fire contextrestored.
    e.preventDefault();
    this.lost = true;
    this.lostCbs.emit((cb) => cb());
  };
  private readonly onRestored = (): void => {
    this.lost = false;
    this.dirty = true;
    this.restoredCbs.emit((cb) => cb());
  };

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, opts: GlHostOptions) {
    this.canvas = canvas;
    this.gl = gl;
    this.caps = probeCaps(gl);
    this.maxDpr = opts.maxDpr ?? 2;
    this.autoResize = opts.autoResize ?? true;
    this.container = opts.container ?? canvas.parentElement;

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);

    if (typeof ResizeObserver !== 'undefined' && this.container !== null && this.autoResize) {
      this.ro = new ResizeObserver(this.onWindowResize);
      this.ro.observe(this.container);
    } else {
      this.ro = null;
    }
    if (typeof window !== 'undefined' && this.autoResize) {
      window.addEventListener('resize', this.onWindowResize, { passive: true });
      window.addEventListener('orientationchange', this.onWindowResize, { passive: true });
    }

    this.resize();
  }

  private measure(): { availW: number; availH: number } {
    const c = this.container;
    const cw = c !== null ? c.clientWidth : 0;
    const ch = c !== null ? c.clientHeight : 0;
    if (cw > 0 && ch > 0) return { availW: cw, availH: ch };
    if (typeof window !== 'undefined') return { availW: window.innerWidth, availH: window.innerHeight };
    return { availW: LOGICAL_W, availH: LOGICAL_H };
  }

  resize(): boolean {
    if (this.disposed) return false;
    const liveDpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, this.maxDpr);
    // Reading devicePixelRatio does not force layout; clientWidth does. So a DPR
    // change is caught every frame for free, and the layout read only happens
    // when a resize event or the observer actually fired.
    if (!this.dirty && liveDpr === this.dpr) return false;
    this.dirty = false;

    let cssW = this.cssW;
    let cssH = this.cssH;
    if (this.autoResize) {
      const { availW, availH } = this.measure();
      const scale = Math.min(availW / LOGICAL_W, availH / LOGICAL_H);
      cssW = Math.max(1, Math.floor(LOGICAL_W * scale));
      cssH = Math.max(1, Math.floor(LOGICAL_H * scale));
    }

    const dw = Math.max(1, Math.round(cssW * liveDpr));
    const dh = Math.max(1, Math.round(cssH * liveDpr));

    const changed = dw !== this.canvas.width || dh !== this.canvas.height || cssW !== this.cssW || cssH !== this.cssH;
    if (!changed) {
      this.dpr = liveDpr;
      return false;
    }

    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = liveDpr;
    if (this.autoResize) {
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    this.canvas.width = dw;
    this.canvas.height = dh;

    this.view.x = 0;
    this.view.y = 0;
    this.view.w = dw;
    this.view.h = dh;
    this.applyViewport();

    this.resized.emit((cb) => cb(cssW, cssH, liveDpr));
    return true;
  }

  applyViewport(): void {
    const v = this.view;
    this.gl.viewport(v.x, v.y, v.w, v.h);
    this.gl.scissor(v.x, v.y, v.w, v.h);
  }

  onResize(cb: (cssW: number, cssH: number, dpr: number) => void): Unsubscribe {
    return this.resized.add(cb);
  }

  onContextLost(cb: () => void): Unsubscribe {
    return this.lostCbs.add(cb);
  }

  onContextRestored(cb: () => void): Unsubscribe {
    return this.restoredCbs.add(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    this.ro?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('orientationchange', this.onWindowResize);
    }
    this.resized.clear();
    this.lostCbs.clear();
    this.restoredCbs.clear();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const NO_WEBGL2_HELP = [
  'This machine reported no WebGL2 context.',
  '',
  'Usually one of:',
  '  - hardware acceleration is disabled in the browser settings',
  '  - the browser is older than 2021 (Safari gained WebGL2 in 15.4)',
  '  - a remote desktop / VM session with no GPU passthrough',
  '  - a GPU driver crash earlier in this session (try reloading)',
].join('\n');

/**
 * Creates the context on `#game` (or a supplied canvas) and probes it.
 *
 * THROWS `GlError` rather than returning null: every caller has to stop, and a
 * throw is the one control flow nobody forgets to handle. `main.ts` should wrap
 * the call and pass the error to `showFatal`.
 */
export const createGlHost = (opts: GlHostOptions = {}): GlHost => {
  let canvas = opts.canvas ?? null;
  if (canvas === null) {
    if (typeof document === 'undefined') {
      throw new GlError('No document: SunForce needs a browser with a canvas.');
    }
    const el = document.getElementById('game');
    if (el === null) {
      throw new GlError('index.html is missing <canvas id="game">.');
    }
    if (!(el instanceof HTMLCanvasElement)) {
      throw new GlError(`#game is a <${el.tagName.toLowerCase()}>, not a <canvas>.`);
    }
    canvas = el;
  }

  const attrs: WebGLContextAttributes = {
    alpha: false,
    // ENGINE-DECISIONS §12: painter's order, no depth test, so no depth buffer.
    depth: false,
    stencil: false,
    // SDF limbs anti-alias themselves and the post chain wants a clean 1:1
    // buffer; MSAA on the default framebuffer would cost fill for nothing.
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: opts.powerPreference ?? 'high-performance',
    desynchronized: opts.desynchronized ?? false,
    failIfMajorPerformanceCaveat: false,
  };

  const gl = canvas.getContext('webgl2', attrs);
  if (gl === null) {
    throw new GlError('WebGL2 is not available in this browser.', NO_WEBGL2_HELP);
  }

  const host = new GlHostImpl(canvas, gl, opts);
  const caps = host.caps;

  if (caps.maxVertexAttribs < REQUIRED_VERTEX_ATTRIBS) {
    throw new GlError(
      `This GPU exposes only ${caps.maxVertexAttribs} vertex attributes; SunForce needs ${REQUIRED_VERTEX_ATTRIBS}.`,
      'The instanced quad batcher uses one vec2 for the quad corner and six vec4s per instance.',
    );
  }
  if (!caps.atlasFits) {
    devWarn(
      `gfx/gl: MAX_TEXTURE_SIZE is ${caps.maxTextureSize}; the baked part atlas wants ` +
        `${WANTED_TEXTURE_SIZE}. The stick skin is unaffected.`,
    );
  }

  // One line, once, so a bug report carries the GPU that produced it.
  devWarn(
    `gfx/gl: WebGL2 ready — ${caps.renderer !== '' ? caps.renderer : 'renderer hidden'}` +
      ` | maxTexture ${caps.maxTextureSize} | dpr ${host.dpr} | ${host.cssW}x${host.cssH} css`,
  );

  // Fixed global state. Nothing in the renderer turns these back on.
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.enable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.clearColor(0, 0, 0, 1);

  return host;
};

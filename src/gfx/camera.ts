// =============================================================================
// SunForce — src/gfx/camera.ts
//
// PRESENTATION ONLY. Floats, render clock, never touches SimState and never
// reaches a determinism hash. The sim does not know a camera exists.
//
// The framing rule that matters: ZOOM OUT TWICE AS FAST AS IN. When two
// fighters separate, the camera must already have widened by the time they
// reach the edge; when they close, it must drift in slowly. Symmetric springs
// are what make a fighting-game camera feel seasick.
// =============================================================================

import type { Camera, EventRing, SimState, StageDef } from '@/core/contracts';
import { px } from '@/core/fixed';
import { orthoMat3 } from '@/gfx/batch';
import { extraShakeAmp, extraShakeFrames } from '@/sim/events';

/** World units visible across the full viewport at zoom 1. */
export const BASE_W = 1920;
export const BASE_H = 1080;

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.3;

/** Horizontal headroom kept outside the two fighters, world units. */
const FIT_MARGIN = 520;
/** Camera eye height above the ground line. Fighters are 378 tall. */
const EYE_Y = 300;
/** How much of the fighters' vertical midpoint the camera follows. */
const VERT_FOLLOW = 0.42;
/** World units of floor kept visible below the ground line. */
const FLOOR_BLEED = 170;

const ZOOM_IN_RATE = 0.06;
const ZOOM_OUT_RATE = 0.12;
const PAN_RATE = 0.18;

const SHAKE_DECAY = 0.86;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Frame-rate independent lerp factor: `rate` is the per-60Hz-frame amount. */
const springK = (rate: number, dtMs: number): number => {
  const frames = dtMs / (1000 / 60);
  return 1 - Math.pow(1 - rate, frames <= 0 ? 0 : frames);
};

export interface CameraOptions {
  /** Skip tracking and hold a fixed frame. Useful for debugging box alignment. */
  readonly fixed?: boolean;
}

export class FightCamera implements Camera {
  x = BASE_W * 0.5;
  y = EYE_Y;
  zoom = 1;
  shakeX = 0;
  shakeY = 0;

  private shakeAmp = 0;
  private shakeDirX = 1;
  private shakeDirY = 0;
  private shakeLeft = 0;

  private punchAmt = 0;
  private punchLeft = 0;
  private punchTotal = 1;

  private readonly fixed: boolean;
  private settled = false;

  constructor(opts: CameraOptions = {}) {
    this.fixed = opts.fixed ?? false;
  }

  update(s: SimState, def: StageDef, dtMs: number): void {
    const f0 = s.fighter(0);
    const f1 = s.fighter(1);
    const x0 = px(f0.posX);
    const x1 = px(f1.posX);
    const y0 = px(f0.posY);
    const y1 = px(f1.posY);

    const midX = (x0 + x1) * 0.5;
    const midY = (y0 + y1) * 0.5;

    // --- zoom: fit the pair, clamped, asymmetric spring -----------------------
    const span = Math.abs(x0 - x1) + FIT_MARGIN;
    const wantZoom = clamp(BASE_W / Math.max(span, 1), ZOOM_MIN, ZOOM_MAX);

    if (this.fixed) {
      this.zoom = 1;
    } else if (!this.settled) {
      this.zoom = wantZoom;
    } else {
      // Widening (wantZoom < zoom) is urgent; closing in is leisurely.
      const rate = wantZoom < this.zoom ? ZOOM_OUT_RATE : ZOOM_IN_RATE;
      this.zoom += (wantZoom - this.zoom) * springK(rate, dtMs);
    }

    // --- pan -----------------------------------------------------------------
    const wantX = this.fixed ? def.width * 0.5 : midX;
    const wantY = this.fixed ? EYE_Y : EYE_Y + midY * VERT_FOLLOW;

    if (!this.settled) {
      this.x = wantX;
      this.y = wantY;
      this.settled = true;
    } else {
      const k = springK(PAN_RATE, dtMs);
      this.x += (wantX - this.x) * k;
      this.y += (wantY - this.y) * k;
    }

    // --- punch zoom (a kick shoves the camera in, then releases) -------------
    if (this.punchLeft > 0) {
      this.punchLeft -= 1;
      const t = this.punchLeft / this.punchTotal;
      this.zoom *= 1 + this.punchAmt * t * t;
      if (this.punchLeft <= 0) this.punchAmt = 0;
    }

    // --- CLAMP FIRST, then shake. A corner hit must still shake. -------------
    const halfW = BASE_W / (2 * this.zoom);
    const halfH = BASE_H / (2 * this.zoom);

    if (halfW * 2 >= def.width) {
      this.x = def.width * 0.5;
    } else {
      this.x = clamp(this.x, halfW, def.width - halfW);
    }
    const floorY = -FLOOR_BLEED + halfH;
    const ceilY = def.ceiling - halfH;
    this.y = ceilY < floorY ? floorY : clamp(this.y, floorY, ceilY);

    // --- shake ---------------------------------------------------------------
    if (this.shakeLeft > 0) {
      this.shakeLeft -= 1;
      // Flip every frame: a shake that decays smoothly reads as a wobble, and
      // a wobble reads as weak. Alternating is what sells the impact.
      const sign = (this.shakeLeft & 1) === 0 ? 1 : -1;
      this.shakeX = this.shakeDirX * this.shakeAmp * sign;
      this.shakeY = this.shakeDirY * this.shakeAmp * sign;
      this.shakeAmp *= SHAKE_DECAY;
      if (this.shakeLeft <= 0) {
        this.shakeAmp = 0;
        this.shakeX = 0;
        this.shakeY = 0;
      }
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  addShake(nx: number, ny: number, amp: number, frames: number): void {
    if (amp <= 0 || frames <= 0) return;
    const len = Math.hypot(nx, ny) || 1;
    // Strongest shake wins rather than accumulating — stacked shakes on a
    // multi-hit turn the screen to soup.
    if (amp >= this.shakeAmp) {
      this.shakeDirX = nx / len;
      this.shakeDirY = ny / len;
      this.shakeAmp = amp;
    }
    if (frames > this.shakeLeft) this.shakeLeft = frames;
  }

  punchZoom(amount: number, frames: number): void {
    if (frames <= 0) return;
    this.punchAmt = amount;
    this.punchLeft = frames;
    this.punchTotal = frames;
  }

  onEvent(r: EventRing, i: number): void {
    const extra = r.extra(i);
    const amp = extraShakeAmp(extra);
    const frames = extraShakeFrames(extra);
    if (amp <= 0 || frames <= 0) return;
    // Shake away from the attacker, so the hit has a direction.
    const dir = r.a(i) === 0 ? 1 : -1;
    this.addShake(dir, 0.35, amp, frames);
  }

  viewMatrix(out: Float32Array): void {
    const halfW = BASE_W / (2 * this.zoom);
    const halfH = BASE_H / (2 * this.zoom);
    const cx = this.x + this.shakeX;
    const cy = this.y + this.shakeY;
    orthoMat3(out, cx - halfW, cx + halfW, cy - halfH, cy + halfH);
  }

  /** World units per device pixel — the debug overlay needs it for line weight. */
  worldPerPixel(viewportW: number): number {
    return BASE_W / this.zoom / Math.max(viewportW, 1);
  }

  /** Re-snap on a round reset or teleport so the camera does not sweep. */
  reset(): void {
    this.settled = false;
    this.shakeLeft = 0;
    this.shakeAmp = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.punchLeft = 0;
    this.punchAmt = 0;
  }
}

export const createCamera = (opts?: CameraOptions): FightCamera => new FightCamera(opts);

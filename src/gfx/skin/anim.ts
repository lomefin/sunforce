// =============================================================================
// SunForce — src/gfx/skin/anim.ts
// THE PROCEDURAL POSE. There are zero authored AnimClips, so `clip === null` is
// not a fallback — it is THE path, and it is what makes M0 look like a fight
// instead of two T-poses sliding at each other.
//
// -----------------------------------------------------------------------------
// WHAT A MOVE LOOKS LIKE WITH NO KEYFRAMES
// -----------------------------------------------------------------------------
// One scalar, `ext`, runs the whole strike:
//
//   ext = -1  cocked   (wind-back: limb pulls back, torso coils AGAINST it)
//   ext =  0  stance   (rest skeleton + a small relaxed guard)
//   ext = +1  peak     (limb TIP exactly on hint.reach / hint.height)
//
//   startup  0 -> -1 -> +1   coil (easeOut = anticipation holds), then an
//                            ease-IN strike so the fastest frame is the frame
//                            the hitbox turns on. Linear here reads as a robot.
//   active   +1 -> +1.05     follow-through drift; the tip is ON TARGET for the
//                            whole active window, which is what makes F1's
//                            hitboxes line up with the limb (acceptance 6).
//   recovery +1.05 -> 0      slow settle that overshoots slightly PAST rest and
//                            comes back. That overshoot is the difference
//                            between "animated" and "interpolated".
//
// The limb is placed by a two-bone analytic IK so the TIP lands on the hint,
// never by guessing joint angles: a punch that stops short of its own hitbox is
// the single most obvious way this slice can look wrong.
//
// -----------------------------------------------------------------------------
// SPACE — everything here is FIGHTER-LOCAL, UNMIRRORED
// -----------------------------------------------------------------------------
// +x is FORWARD, +y is UP, (0, 0) is the fighter's ground point, exactly like
// PoseBuffer and the compiled FxBoxes. Facing is ROOT.sx = -1 and is applied by
// `solve`, so NOTHING in this file mirrors anything; hint.reach is just +x.
// ROOT.sx is read and restored, never clobbered.
//
// `hint.reach` / `hint.height` are read as the tip's ABSOLUTE fighter-local
// position, because that is what the authored data means: A_5P's hitbox ends at
// world x 92 with reach 92 and is centred on world y 248 with height 248, and
// A_5K's ends at 119 with reach 119, centred on 194 with height 194. See the
// contractIssues note — the doc comment says "forward from the shoulder/hip".
// =============================================================================

import { Bone, BONE_COUNT, BONE_PARENTS } from '@/core/contracts';
import type { AnimClip, JiggleFn, PoseBuffer, PoseHint, SampleFn } from '@/core/contracts';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Only used if `out` reaches us with no rest pose loaded at all. caporal = 0.5. */
const FALLBACK_UNITS_PER_PX = 0.5;

const COIL_FRACTION = 0.55;   // share of startup spent winding back
const STRIKE_POW = 1.7;       // ease-IN exponent: peak speed AT the active frame
const FOLLOW = 0.05;          // follow-through past the target across active
const RECOIL = 0.14;          // settle dips past rest before returning
const IK_FADE = 0.30;         // |ext| under this fades IK back into the stance
const ARM_BEND = -1;          // elbow BELOW the shoulder->fist line
const LEG_BEND = 1;           // knee leads UP and FORWARD
const COUNTER_ARM = 0.34;     // rad the idle arm pulls back against the strike
const COCK_BACK = 0.16;       // wind-back, as a fraction of limb length
const COCK_UP = 0.10;
const IDLE_PERIOD = 96;       // frames per breath cycle

// A relaxed guard, applied to BOTH the idle and the attack paths so there is no
// pop on frame 0 of a move. Deliberately small: the concept skeleton's arms are
// 114 units long and a jab only travels to x = 92, so a big forward guard would
// leave the punch nowhere to go.
const STANCE_UPPER_F = -0.08, STANCE_FORE_F = 0.30;
const STANCE_UPPER_B = -0.12, STANCE_FORE_B = 0.38;

const JIG_DRIVE_X = 0.0006;    // rad per (world unit / second) of root motion
const JIG_DRIVE_Y = 0.00021;
const JIG_W_BASE = 4, JIG_W_SCALE = 40;   // stiffness -> natural frequency, rad/s
const JIG_MAX_MS = 100, JIG_SUBSTEP_MS = 8, JIG_MAX_SUBSTEPS = 4;

// -----------------------------------------------------------------------------
// Easing
// -----------------------------------------------------------------------------

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function outCubic(u: number): number { const v = 1 - u; return 1 - v * v * v; }
function lerp(a: number, b: number, w: number): number { return a + (b - a) * w; }

// -----------------------------------------------------------------------------
// Per-character metrics, derived once from the CONCEPT rest pose
// -----------------------------------------------------------------------------

/** Rest skeleton in fighter-local world units: local translations and the same
 *  chain composed into absolute positions (which is where a pinned foot and an
 *  un-driven limb tip live). */
interface Metrics {
  readonly tx: Float32Array; readonly ty: Float32Array;
  readonly wx: Float32Array; readonly wy: Float32Array;
}

const METRICS = new WeakMap<readonly (readonly [number, number])[], Metrics>();

/**
 * SampleFn hands us CharDef.restPose (CONCEPT pixels) but not its ConceptSpace,
 * so unitsPerPx is recovered from `out` itself: after `applyRest` its tx/ty ARE
 * this skeleton in world units, and the ratio of the two L1 norms is exactly
 * unitsPerPx. That makes the result identical to pose.ts's own conversion when
 * the documented call order is followed, and still sane (0.5, caporal's value)
 * if a caller ever samples into a blank buffer. Cached on array identity, so
 * this runs once per character.
 */
function buildMetrics(out: PoseBuffer, concept: readonly (readonly [number, number])[]): Metrics {
  const n = concept.length < BONE_COUNT ? concept.length : BONE_COUNT;
  let cSum = 0, wSum = 0;
  for (let i = 1; i < n; i++) {
    const par = BONE_PARENTS[i]!;
    const c = concept[i]!, p = concept[par]!;
    cSum += Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]);
    wSum += Math.abs(out.tx[i]!) + Math.abs(out.ty[i]!);
  }
  const primed = cSum > 1e-6 && wSum > 1e-6 && Number.isFinite(wSum);
  const u = primed ? wSum / cSum : FALLBACK_UNITS_PER_PX;

  const tx = new Float32Array(BONE_COUNT), ty = new Float32Array(BONE_COUNT);
  const wx = new Float32Array(BONE_COUNT), wy = new Float32Array(BONE_COUNT);
  tx[0] = primed ? out.tx[0]! : 0;      // ROOT sits on the ground point by design
  ty[0] = primed ? out.ty[0]! : 0;
  wx[0] = tx[0]!; wy[0] = ty[0]!;
  for (let i = 1; i < n; i++) {
    const par = BONE_PARENTS[i]!;
    const c = concept[i]!, p = concept[par]!;
    tx[i] = (c[0] - p[0]) * u;
    ty[i] = -(c[1] - p[1]) * u;         // concept y runs DOWN
    wx[i] = wx[par]! + tx[i]!;
    wy[i] = wy[par]! + ty[i]!;
  }
  return { tx, ty, wx, wy };
}

function metricsOf(out: PoseBuffer, concept: readonly (readonly [number, number])[]): Metrics {
  let m = METRICS.get(concept);
  if (m === undefined) { m = buildMetrics(out, concept); METRICS.set(concept, m); }
  return m;
}

// -----------------------------------------------------------------------------
// Two-bone IK
// -----------------------------------------------------------------------------

interface Chain { readonly base: Bone; readonly mid: Bone; readonly tip: Bone }

const CHAINS: { readonly armF: Chain; readonly armB: Chain; readonly legF: Chain; readonly legB: Chain } = {
  armF: { base: Bone.UPPER_ARM_F, mid: Bone.FOREARM_F, tip: Bone.HAND_F },
  armB: { base: Bone.UPPER_ARM_B, mid: Bone.FOREARM_B, tip: Bone.HAND_B },
  legF: { base: Bone.THIGH_F, mid: Bone.SHIN_F, tip: Bone.FOOT_F },
  legB: { base: Bone.THIGH_B, mid: Bone.SHIN_B, tip: Bone.FOOT_B },
};

const PATH = new Int32Array(BONE_COUNT);
/** Scratch: world origin and world rotation of a chain base's PARENT frame. */
const FRAME = { x: 0, y: 0, r: 0 };

/**
 * Mini forward pass down one ancestor path — the same composition `solve` does,
 * minus scale (every bone but ROOT is left at unit scale here, and ROOT's -1 is
 * skipped on purpose so the IK stays in unmirrored space). Leaves the base
 * bone's own rotation out of FRAME.r: that is the unknown we are solving for.
 */
function baseFrame(out: PoseBuffer, bone: Bone): void {
  let n = 0;
  for (let b: number = bone; b >= 0 && n < BONE_COUNT; b = BONE_PARENTS[b]!) PATH[n++] = b;
  let ax = 0, ay = 0, ar = 0;
  for (let k = n - 1; k >= 0; k--) {
    const b = PATH[k]!;
    const c = Math.cos(ar), s = Math.sin(ar);
    const lx = out.tx[b]!, ly = out.ty[b]!;
    ax += c * lx - s * ly;
    ay += s * lx + c * ly;
    if (k > 0) ar += out.rot[b]!;
  }
  FRAME.x = ax; FRAME.y = ay; FRAME.r = ar;
}

/**
 * Puts the chain's TIP on (tgtX, tgtY), blended `w` of the way from whatever
 * the bones already hold (the stance). `bend` picks the elbow/knee side.
 * Unreachable targets are clamped to the reachable annulus, so the limb points
 * at the target and straightens instead of snapping or producing NaN.
 */
function driveChain(
  out: PoseBuffer, m: Metrics, ch: Chain, tgtX: number, tgtY: number, bend: number, w: number,
): void {
  if (w <= 0) return;
  const v1x = m.tx[ch.mid]!, v1y = m.ty[ch.mid]!;
  const v2x = m.tx[ch.tip]!, v2y = m.ty[ch.tip]!;
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-3 || l2 < 1e-3) return;

  baseFrame(out, ch.base);
  let dx = tgtX - FRAME.x, dy = tgtY - FRAME.y;
  let d = Math.hypot(dx, dy);
  if (d < 1e-4) { dx = 1; dy = 0; d = 1; }
  const dMin = Math.abs(l1 - l2) + 1e-3, dMax = l1 + l2 - 1e-3;
  d = clamp(d, dMin > dMax ? dMax : dMin, dMax);

  const phi = Math.atan2(dy, dx);
  const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const cb = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  const th1 = phi + bend * Math.acos(ca);
  const th2 = th1 - bend * (Math.PI - Math.acos(cb));

  // World rotation of each bone's FRAME, minus what the rest pose already gives.
  const r1 = th1 - Math.atan2(v1y, v1x);
  const r2 = th2 - Math.atan2(v2y, v2x) - r1;
  const b0 = out.rot[ch.base]!, m0 = out.rot[ch.mid]!;
  out.rot[ch.base] = lerp(b0, r1 - FRAME.r, w);
  out.rot[ch.mid] = lerp(m0, r2, w);
}

function chainLength(m: Metrics, ch: Chain): number {
  return Math.hypot(m.tx[ch.mid]!, m.ty[ch.mid]!) + Math.hypot(m.tx[ch.tip]!, m.ty[ch.tip]!);
}

/** Holds a foot on its rest ground contact while the hip leans and drops. */
function pinLeg(out: PoseBuffer, m: Metrics, ch: Chain, w: number): void {
  driveChain(out, m, ch, m.wx[ch.tip]!, m.wy[ch.tip]!, LEG_BEND, w);
}

// -----------------------------------------------------------------------------
// The strike curve
// -----------------------------------------------------------------------------

function extensionAt(
  t: number, total: number, phase: { startup: number; activeFirst: number; activeLast: number },
): number {
  const aF = phase.activeFirst;
  const aL = phase.activeLast < aF ? aF : phase.activeLast;
  const startup = phase.startup > 0 ? phase.startup : aF;
  const coil = startup > 0 ? startup * COIL_FRACTION : 0;

  if (t < coil) return -outCubic(clamp01(t / coil));
  if (t < aF) {
    const span = aF - coil;
    const u = span > 1e-4 ? clamp01((t - coil) / span) : 1;
    return -1 + 2 * Math.pow(u, STRIKE_POW);
  }
  if (t <= aL) {
    const span = aL - aF;
    const u = span > 1e-4 ? clamp01((t - aF) / span) : 0;
    return 1 + FOLLOW * u * u;
  }
  const span = (total - 1) - aL;
  const u = span > 1e-4 ? clamp01((t - aL) / span) : 1;
  return (1 + FOLLOW) * (1 - outCubic(u)) - RECOIL * Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - u);
}

// -----------------------------------------------------------------------------
// Pose assembly
// -----------------------------------------------------------------------------

function loadRest(out: PoseBuffer, m: Metrics): void {
  const facing = out.sx[Bone.ROOT]!;
  out.rot.fill(0);
  out.sx.fill(1);
  out.sy.fill(1);
  out.stretch.fill(1);
  out.visible.fill(1);
  out.tx.set(m.tx);
  out.ty.set(m.ty);
  out.sx[Bone.ROOT] = facing < 0 ? -1 : 1;   // facing survives; never mirrored here
}

function applyStance(out: PoseBuffer): void {
  out.rot[Bone.UPPER_ARM_F] = STANCE_UPPER_F;
  out.rot[Bone.FOREARM_F] = STANCE_FORE_F;
  out.rot[Bone.UPPER_ARM_B] = STANCE_UPPER_B;
  out.rot[Bone.FOREARM_B] = STANCE_FORE_B;
}

/** Torso, hip and accessories. The coil terms are NEGATIVE of the drive terms:
 *  the body loads backwards before it commits forwards. */
function applyBody(out: PoseBuffer, m: Metrics, hint: PoseHint, ext: number): void {
  const drive = ext > 0 ? ext : 0;
  const coil = ext < 0 ? -ext : 0;
  const lean = hint.lean * DEG * (drive - 0.35 * coil);   // +lean = forward = CW = -rot
  const crouch = hint.crouch * (drive + 0.45 * coil);
  const swing = hint.accSwing * DEG * (drive - 0.4 * coil);

  out.ty[Bone.HIP] = m.ty[Bone.HIP]! - crouch;
  out.rot[Bone.SPINE_LOW] = -lean * 0.55;
  out.rot[Bone.SPINE_UP] = -lean * 0.45;
  out.rot[Bone.NECK] = lean * 0.35;      // head stays up while the chest dives
  out.rot[Bone.HEAD] = lean * 0.15;
  out.rot[Bone.ACC0] = swing;            // plume / puffs trail the motion
  out.rot[Bone.ACC1] = swing * 0.8;      // hat fan
  out.rot[Bone.ACC2] = swing * 1.1;      // apron, bells belt
}

/** The limbs that are not striking still have to look like they are fighting. */
function balanceArms(out: PoseBuffer, limb: PoseHint['limb'], ext: number): void {
  const s = COUNTER_ARM * ext;
  if (limb === 'armF') {
    out.rot[Bone.UPPER_ARM_B] = STANCE_UPPER_B - s;
    out.rot[Bone.FOREARM_B] = STANCE_FORE_B + s * 0.5;
  } else if (limb === 'armB') {
    out.rot[Bone.UPPER_ARM_F] = STANCE_UPPER_F - s;
    out.rot[Bone.FOREARM_F] = STANCE_FORE_F + s * 0.5;
  } else {
    // Legs and body: arms counter-rotate, which is what stops a kick reading
    // like a mannequin tipping over.
    out.rot[Bone.UPPER_ARM_F] = STANCE_UPPER_F - s * 0.5;
    out.rot[Bone.FOREARM_F] = STANCE_FORE_F + s * 0.35;
    out.rot[Bone.UPPER_ARM_B] = STANCE_UPPER_B + s * 0.7;
    out.rot[Bone.FOREARM_B] = STANCE_FORE_B - s * 0.2;
  }
}

function driveLimbs(out: PoseBuffer, m: Metrics, hint: PoseHint, ext: number): void {
  const w = clamp01(Math.abs(ext) / IK_FADE);
  const limb = hint.limb;
  balanceArms(out, limb, ext);

  if (limb === 'body') {
    // No chain drives a body move: the hips carry it instead.
    out.tx[Bone.HIP] = m.tx[Bone.HIP]! + 0.10 * hint.reach * (ext > 0 ? ext : 0);
    pinLeg(out, m, CHAINS.legF, w);
    pinLeg(out, m, CHAINS.legB, w);
    return;
  }

  const ch = CHAINS[limb];
  const arm = limb === 'armF' || limb === 'armB';
  const restX = m.wx[ch.tip]!, restY = m.wy[ch.tip]!;
  let tgtX: number, tgtY: number;
  if (ext >= 0) {
    tgtX = lerp(restX, hint.reach, ext);      // ext > 1 on follow-through: overshoot
    tgtY = lerp(restY, hint.height, ext);
  } else {
    const len = chainLength(m, ch);
    tgtX = restX - COCK_BACK * len * -ext;
    tgtY = restY + COCK_UP * len * -ext;
  }
  driveChain(out, m, ch, tgtX, tgtY, arm ? ARM_BEND : LEG_BEND, w);

  // Plant everything that is not swinging.
  if (limb !== 'legF') pinLeg(out, m, CHAINS.legF, w);
  if (limb !== 'legB') pinLeg(out, m, CHAINS.legB, w);
}

/** Breathing. Used whenever the caller hands us a state with no active window —
 *  standing, walking, blocking. A fighter that is perfectly still reads as dead. */
function idlePose(out: PoseBuffer, m: Metrics, t: number): void {
  const ph = (t / IDLE_PERIOD) * TAU;
  const b = Math.sin(ph), b2 = Math.sin(ph * 2);
  out.ty[Bone.HIP] = m.ty[Bone.HIP]! + 1.4 * b;
  out.rot[Bone.SPINE_LOW] = 0.016 * b;
  out.rot[Bone.SPINE_UP] = 0.024 * b;
  out.rot[Bone.NECK] = -0.022 * b;
  out.rot[Bone.HEAD] = 0.014 * b2;
  out.rot[Bone.HEADWEAR] = 0.020 * b2;
  out.rot[Bone.UPPER_ARM_F] = STANCE_UPPER_F + 0.045 * b;
  out.rot[Bone.FOREARM_F] = STANCE_FORE_F + 0.030 * b;
  out.rot[Bone.UPPER_ARM_B] = STANCE_UPPER_B - 0.045 * b;
  out.rot[Bone.FOREARM_B] = STANCE_FORE_B - 0.030 * b;
  out.rot[Bone.ACC0] = 0.050 * b;
  out.rot[Bone.ACC1] = 0.035 * b2;
  out.rot[Bone.ACC2] = 0.060 * b;
  pinLeg(out, m, CHAINS.legF, 1);
  pinLeg(out, m, CHAINS.legB, 1);
}

// -----------------------------------------------------------------------------
// Authored clips — int16 keyframe lerp, for the day they exist
// -----------------------------------------------------------------------------

function sampleClip(out: PoseBuffer, clip: AnimClip, t: number): boolean {
  const keys = clip.keyAt.length;
  const stride = BONE_COUNT * 5;
  if (keys === 0 || clip.frameCount <= 0 || clip.keyFrames.length < keys * stride) return false;

  let f = t;
  if (clip.loopAt >= 0 && f >= clip.frameCount) {
    const span = clip.frameCount - clip.loopAt;
    f = span > 0 ? clip.loopAt + ((f - clip.loopAt) % span) : clip.loopAt;
  }
  f = clamp(f, 0, clip.frameCount - 1);

  let k = 0;
  while (k + 1 < keys && clip.keyAt[k + 1]! <= f) k++;
  const k2 = k + 1 < keys ? k + 1 : k;
  const f0 = clip.keyAt[k]!, f1 = clip.keyAt[k2]!;
  const w = f1 > f0 ? clamp01((f - f0) / (f1 - f0)) : 0;

  const kf = clip.keyFrames;
  const s0 = k * stride, s1 = k2 * stride;
  const facing = out.sx[Bone.ROOT]! < 0 ? -1 : 1;
  for (let i = 0; i < BONE_COUNT; i++) {
    const a = s0 + i * 5, b = s1 + i * 5;
    out.rot[i] = lerp(kf[a]!, kf[b]!, w) * (TAU / 1024);
    out.tx[i] = lerp(kf[a + 1]!, kf[b + 1]!, w) / 16;
    out.ty[i] = lerp(kf[a + 2]!, kf[b + 2]!, w) / 16;
    out.sx[i] = lerp(kf[a + 3]!, kf[b + 3]!, w) / 256;
    out.sy[i] = lerp(kf[a + 4]!, kf[b + 4]!, w) / 256;
  }
  // A clip authors magnitude; the runner still owns which way the fighter looks.
  out.sx[Bone.ROOT] = Math.abs(out.sx[Bone.ROOT]!) * facing;
  return true;
}

// -----------------------------------------------------------------------------
// SampleFn
// -----------------------------------------------------------------------------

/**
 * Writes rot / tx / ty / sx / sy / stretch / visible itself, so a caller may
 * skip `applyRest` — but calling `applyRest(pose, rest, facing)` first is still
 * the documented order and is what lets this file recover the character's
 * world scale exactly. ROOT.sx (facing) is always preserved. `solve` after.
 */
export const sample: SampleFn = (out, restPose, clip, hint, frame, totalFrames, phase, alpha) => {
  const m = metricsOf(out, restPose);
  const t = frame + clamp01(alpha);

  loadRest(out, m);
  if (clip !== null && sampleClip(out, clip, t)) return;

  applyStance(out);
  const aF = phase.activeFirst, aL = phase.activeLast;
  if (totalFrames <= 0 || aF < 0 || aL < aF || aF >= totalFrames) {
    idlePose(out, m, t);
    return;
  }

  const ext = extensionAt(t, totalFrames, phase);
  applyBody(out, m, hint, ext);
  driveLimbs(out, m, hint, ext);
};

// -----------------------------------------------------------------------------
// JiggleFn — one critically-damped spring per accessory bone
// -----------------------------------------------------------------------------

/** [angle, angular velocity] per bone, per PoseBuffer. Presentation-only state:
 *  it never reaches the sim and never touches a hash. */
const SPRINGS = new WeakMap<PoseBuffer, Float32Array>();

/** Drop a fighter's accessory momentum — round reset, teleport, camera cut.
 *  Without this a plume keeps swinging from wherever the fighter used to be. */
export function resetJiggle(p: PoseBuffer): void {
  const st = SPRINGS.get(p);
  if (st !== undefined) st.fill(0);
}

/**
 * Driven by the DERIVATIVE of root position, not position: a costume reacts to
 * how fast you moved, so walking trails the plumes back, a dash pins them and a
 * stop snaps them forward past neutral. `damping` is read as a damping RATIO
 * (a.ts authors 0.72-0.80, just under critical, so there is one visible bounce)
 * and `stiffness` as a natural frequency. Deflection is added on top of whatever
 * `sample` already wrote, then hard-clamped to `limit` degrees.
 */
export const jiggle: JiggleFn = (p, defs, prevRootX, rootX, prevRootY, rootY, dtMs) => {
  if (defs.length === 0) return;
  let st = SPRINGS.get(p);
  if (st === undefined) { st = new Float32Array(BONE_COUNT * 2); SPRINGS.set(p, st); }

  const dt = clamp(dtMs > 0 ? dtMs : 0, 0, JIG_MAX_MS);
  if (dt <= 0) {
    for (const d of defs) p.rot[d.bone] = p.rot[d.bone]! + st[d.bone * 2]!;
    return;
  }
  // Root motion is STAGE x; the pose is fighter-local, so fold facing in.
  const facing = p.sx[Bone.ROOT]! < 0 ? -1 : 1;
  const perSec = 1000 / dt;
  const vx = (rootX - prevRootX) * perSec * facing;
  const vy = (rootY - prevRootY) * perSec;

  const steps = Math.min(JIG_MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / JIG_SUBSTEP_MS)));
  const h = dt / (1000 * steps);

  for (const d of defs) {
    const bone = d.bone;
    if (bone < 0 || bone >= BONE_COUNT) continue;
    const o = bone * 2;
    const lim = Math.abs(d.limit) * DEG;
    const target = clamp(-(vx * JIG_DRIVE_X + vy * JIG_DRIVE_Y), -lim, lim);
    const wn = JIG_W_BASE + (d.stiffness > 0 ? d.stiffness : 0) * JIG_W_SCALE;
    const z = d.damping > 0 ? d.damping : 1;

    let ang = st[o]!, vel = st[o + 1]!;
    for (let s = 0; s < steps; s++) {
      vel += (-wn * wn * (ang - target) - 2 * z * wn * vel) * h;   // semi-implicit
      ang += vel * h;
    }
    if (ang > lim) { ang = lim; if (vel > 0) vel = 0; }
    else if (ang < -lim) { ang = -lim; if (vel < 0) vel = 0; }
    if (!Number.isFinite(ang) || !Number.isFinite(vel)) { ang = 0; vel = 0; }

    st[o] = ang; st[o + 1] = vel;
    p.rot[bone] = p.rot[bone]! + ang;
  }
};

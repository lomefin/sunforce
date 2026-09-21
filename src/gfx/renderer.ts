// =============================================================================
// SunForce — src/gfx/renderer.ts
//
// THE ONLY PLACE gl.draw* IS CALLED (via QuadBatch.flush).
//
// The renderer OBSERVES the sim. It reads SimState and writes nothing back —
// no pose, no camera value, no spring state ever reaches the state buffer, so
// animation quality can change daily without moving a determinism hash.
//
// M0 note: no art is baked yet, so the stage draws as procedural parallax
// bands derived from each layer's parallax/tint. The layer model, the camera
// and the draw order are the real ones; only the texture sampling is missing.
// =============================================================================

import type {
  CharacterSkin, CompiledChar, CompiledMove, FighterView, InstanceWriter, PlayerIx,
  PoseBuffer, PoseHint, Renderer, SimState, StageDef, StateBuf,
} from '@/core/contracts';
import type { Material } from '@/gfx/batch';
import { AURA_DASH_MIN, AURA_SCALE, AnimId, Bone, MoveId, S } from '@/core/contracts';
import { charOf } from '@/sim/state';
import { isAirborne } from '@/sim/collision';
import { px } from '@/core/fixed';
import { QuadBatch, rgbB, rgbG, rgbR, writeQuad } from '@/gfx/batch';
import { drawDebugBoxes, toggleDebugBoxes as flipDebugBoxes } from '@/gfx/debugdraw';
import { applyRest, createPoseBuffer, restPoseOf, setFacing, solve } from '@/gfx/skin/pose';
import { jiggle, resetJiggle, sample } from '@/gfx/skin/anim';
import { BASE_H, BASE_W, FightCamera, createCamera } from '@/gfx/camera';
import { drawAuraBar, drawHealthBar, drawRoundTimer, secondsFromFrames } from '@/ui/wiphala';

/** Slim, so the aura never competes with the health bar above it. */
const AURA_BAR_H = 16;
import { backdropSpecOf, createStageBackdrop } from '@/gfx/stage';
import type { StageBackdrop } from '@/gfx/stage';

/** Used when a fighter is idle and no move is driving the pose. */
const IDLE_HINT: PoseHint = {
  limb: 'body', reach: 0, height: 0, lean: 0, crouch: 0, accSwing: 0,
};

const HP_MAX = 1000;

/**
 * A hit whose hitstun is AT OR ABOVE this many frames plays the HEAVY standing
 * reaction; everything below it plays the light one.
 *
 * The sim stores no hit "severity" and must not gain one — the state buffer is
 * hashed and rolled back — but it does not need to. On the frame a hit lands,
 * `hitstun` is set and `stateFrame` is reset to 0, and thereafter the two tick
 * together inside the hitstop gate, so
 *
 *     hitstun + stateFrame
 *
 * is CONSTANT for the whole reaction and hands presentation the original
 * hitstun back on any frame of it, hitstop freeze included.
 *
 * The numbers, measured against the real sim (scripts/check-rules.ts pins them):
 * that sum reads 17 after a punch and 22 after a kick. Those are the printed
 * 16 / 21 plus the spent-hit-frame carry the sim adds on contact (STUN_CARRY in
 * src/sim/hits.ts) — the counter is always one longer than the frame data. A
 * counter-hit adds +6 / +8, giving 23 / 30. 19 sits alone in the gap between 17
 * and 22, so a jab is light, a kick is heavy, and a counter-hit jab correctly
 * promotes to heavy once counter-hit is switched on (`const counter = false` in
 * hits.ts today — the threshold is already right for it). Symmetrically, if
 * hitstun proration is ever turned on, a deep-combo kick can prorate under the
 * threshold and read light. That is the wanted answer, not a bug: a hit that no
 * longer stuns like a heavy one should not react like one.
 */
const HARD_HITSTUN_FRAMES = 19;

/** The hitstun this reaction STARTED with, recovered from the two counters the
 *  sim already stores. Only meaningful while the fighter is in a stun state. */
const reactionHitstun = (f: FighterView): number => f.hitstun + f.stateFrame;

/** Standing hit reaction. Heavy only when the hit is decidably heavy: anything
 *  that does not clear the threshold — including a reaction too short to tell
 *  the two apart — keeps the soft clip, so an ambiguous frame never escalates
 *  to the bigger animation. */
const hitStandAnim = (f: FighterView): AnimId =>
  reactionHitstun(f) >= HARD_HITSTUN_FRAMES ? AnimId.HIT_STAND_HARD : AnimId.HIT_STAND;

/** A clip, or — where one state covers two different-looking reactions — how to
 *  pick between them from the fighter. */
type StateAnim = AnimId | ((f: FighterView) => AnimId);

/**
 * Locomotion state -> animation clip. A move carries its own `anim`; this
 * covers everything else. A SPRITE skin blits the clip named here; a skeletal
 * skin ignores it and uses the solved pose.
 */
const STATE_ANIM: Readonly<Record<number, StateAnim>> = {
  [S.STAND]: AnimId.IDLE,
  [S.CROUCH]: AnimId.CROUCH,
  [S.WALK_F]: AnimId.WALK_F,
  [S.WALK_B]: AnimId.WALK_B,
  [S.DASH_F]: AnimId.DASH_F,
  [S.DASH_B]: AnimId.DASH_B,
  [S.JUMP_SQUAT]: AnimId.JUMP_SQUAT,
  [S.JUMP_RISE]: AnimId.JUMP_RISE,
  [S.JUMP_FALL]: AnimId.JUMP_FALL,
  [S.LANDING]: AnimId.LAND,
  [S.HITSTUN_STAND]: hitStandAnim,
  [S.HITSTUN_CROUCH]: AnimId.HIT_CROUCH,
  [S.HITSTUN_AIR]: AnimId.HIT_AIR,
  [S.BLOCKSTUN_STAND]: AnimId.BLOCK_STAND,
  [S.BLOCKSTUN_CROUCH]: AnimId.BLOCK_CROUCH,
  [S.BLOCKSTUN_AIR]: AnimId.BLOCK_AIR,
  [S.KNOCKDOWN]: AnimId.KNOCKDOWN,
  [S.WAKEUP]: AnimId.WAKEUP,
  // THE KO IS TWO POSES. `-ko` is the fighter in the air, thrown backwards by
  // the killing blow; `-fallen` is what it lands in. One state, and which
  // drawing it wears depends on whether the feet are still off the ground.
  [S.KO]: (f: FighterView): AnimId => (isAirborne(f) ? AnimId.KO : AnimId.KNOCKDOWN),
  [S.WIN_POSE]: AnimId.WIN,
  [S.INTRO]: AnimId.INTRO,
};

interface Side {
  readonly pose: PoseBuffer;
  skin: CharacterSkin | null;
  prevRootX: number;
  prevRootY: number;
  glint: number;
}

const makeSide = (): Side => ({
  pose: createPoseBuffer(), skin: null, prevRootX: 0, prevRootY: 0, glint: 0,
});

export class FightRenderer implements Renderer {
  readonly camera: FightCamera;

  private gl: WebGL2RenderingContext | null = null;
  private batch: QuadBatch | null = null;
  private readonly sides: readonly [Side, Side] = [makeSide(), makeSide()];
  private readonly mat = new Float32Array(9);
  private readonly hud = new Float32Array(9);

  private viewW = 1920;
  private viewH = 1080;
  private backdrop: StageBackdrop | null = null;
  /** Presentation-only stage art override; see `setStageDressing`. */
  private dressing: StageDef | null = null;
  private frontIx: PlayerIx = 0;
  private lastEpoch = -1;

  constructor(camera?: FightCamera) {
    this.camera = camera ?? createCamera();
  }

  async init(gl: WebGL2RenderingContext): Promise<void> {
    this.gl = gl;
    this.batch = new QuadBatch(gl);
    for (const s of this.sides) {
      if (s.skin !== null) await s.skin.load(gl);
    }
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.viewW = Math.max(1, Math.round(cssW * dpr));
    this.viewH = Math.max(1, Math.round(cssH * dpr));
  }

  /**
   * Draw `def`'s art instead of the stage `SimState` names, until cleared with
   * null. The fight scene sets it so a troupe can bring its own panorama to a
   * shared stage; the sim is never told, and the override differs in art alone.
   *
   * Dropping the backdrop here rather than comparing images every frame keeps
   * the draw loop allocation-free: this is called once when a fight is entered,
   * and the next `draw` rebuilds from whichever def is then current.
   */
  setStageDressing(def: StageDef | null): void {
    const had = this.dressing !== null;
    this.dressing = def;

    // Rebuild only when the ART actually changes. `stageForTroupe` hands back a
    // FRESH object on every fight entry, so comparing identity here would miss
    // every time and re-upload a 2 MB panorama per match — which showed as a
    // couple of seconds of black while the texture decoded.
    const want = def === null ? null : backdropSpecOf(def).image;
    const showing = this.backdrop?.spec.image ?? null;
    if (want !== null && want === showing) return;
    if (want === null && !had) return;

    this.backdrop?.dispose();
    this.backdrop = null;
  }

  setSkin(p: PlayerIx, skin: CharacterSkin): void {
    const side = this.sides[p];
    if (side.skin !== null && side.skin !== skin) side.skin.dispose();
    side.skin = skin;
    if (this.gl !== null) void skin.load(this.gl);
  }

  toggleDebugBoxes(): void {
    flipDebugBoxes();
  }

  draw(s: SimState, _prev: StateBuf, alpha: number, dtMs: number): void {
    const gl = this.gl;
    const batch = this.batch;
    if (gl === null || batch === null) return;

    // Art only: the camera bounds, walls and lighting below read exactly the
    // numbers they would have read without any dressing.
    const stage = this.dressing ?? s.defs.stages[s.g.stageId]!;

    if (this.backdrop === null || this.backdrop.stageId !== stage.id) {
      this.backdrop?.dispose();
      this.backdrop = createStageBackdrop(gl, stage);
    }

    // A round reset teleports both fighters: re-snap camera and drop accessory
    // momentum, or plumes swing in from wherever the fighter used to be.
    if (s.g.teleportEpoch !== this.lastEpoch) {
      this.lastEpoch = s.g.teleportEpoch;
      this.camera.reset();
      for (const side of this.sides) {
        resetJiggle(side.pose);
        side.prevRootX = 0;
        side.prevRootY = 0;
      }
    }

    this.camera.update(s, stage, dtMs);

    gl.viewport(0, 0, this.viewW, this.viewH);
    const amb = stage.ambientLight;
    gl.clearColor(amb[0]! * 0.18, amb[1]! * 0.2, amb[2]! * 0.28, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    batch.beginFrame();
    this.camera.viewMatrix(this.mat);
    batch.setViewProj(this.mat);

    this.drawStage(batch, stage);
    this.drawFighters(batch, s, alpha, dtMs);

    drawDebugBoxes(batch, s, {
      worldPerPixel: this.camera.worldPerPixel(this.viewW),
      origins: true,
    });

    this.drawHud(batch, s);
    batch.flush();
  }

  // --- overlay -------------------------------------------------------------

  /**
   * ONE ADDITIVE HOOK: paint OVER a finished frame, HUD included. Its first
   * caller is the round intro (src/ui/intro.ts, driven by game/scenes.ts).
   *
   * It TAKES the drawing instead of handing out the tools, because the two
   * things an overlay needs — the batch and the screen-space ortho — are
   * private here and must stay private: a caller given the batch could leave it
   * half-filled, on the wrong material, or with the view matrix still on screen
   * space when the next frame's world pass begins. So we set the HUD's fixed
   * 1920x1080 ortho (y UP, the same one `drawHud` uses), bind the flat
   * material, let `emit` push quads, flush, and restore the world matrix.
   *
   * CALL IT AFTER `draw` RETURNS: the batch has no depth test and no sort, so
   * push order is paint order and `emit` lands on top of everything. With no
   * batch (before `init`, after `dispose`) it is a no-op.
   *
   * Deliberately NOT on the `Renderer` contract — contracts.ts is frozen and
   * shared with the headless harness. game/scenes.ts reaches it structurally.
   */
  drawOverlay(emit: (out: InstanceWriter) => void): void {
    const batch = this.batch;
    if (batch === null) return;
    orthoInto(this.hud, 0, BASE_W, 0, BASE_H);
    batch.setViewProj(this.hud);
    batch.use(batch.solidMaterial);
    emit(batch);
    batch.flush();
    batch.setViewProj(this.mat);
  }

  // --- stage ---------------------------------------------------------------

  private drawStage(batch: QuadBatch, stage: StageDef): void {
    // The painted panorama, when it has loaded. The procedural bands below are
    // the fallback for a missing or undecodable image — the game must always run.
    const bd = this.backdrop;
    if (bd !== null && bd.draw(batch, this.camera.x)) {
      batch.flush();
      return;
    }

    batch.use(batch.solidMaterial);

    const cam = this.camera;
    const halfW = BASE_W / (2 * cam.zoom);
    const left = cam.x - halfW;
    const amb = stage.ambientLight;

    // Sky gradient: a few wide bands, darkest at the top. Thin high-altitude
    // dawn — value stays high, but red lags blue.
    const bands = 10;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const y = -200 + t * (stage.ceiling + 400);
      const h = (stage.ceiling + 400) / bands + 2;
      const k = 0.24 + t * 0.5;
      const r = amb[0]! * k * 0.9 + 0.04;
      const g = amb[1]! * k * 0.86;
      const b = amb[2]! * k;
      const i0 = batch.push();
      writeInto(i0, left - 200, y, halfW * 2 + 400, h, r, g, b, 1, -900 + i);
    }

    // Parallax silhouette bands, one per layer. Far layers barely move.
    for (let li = 0; li < stage.layers.length; li++) {
      const L = stage.layers[li]!;
      if (L.reflect !== undefined && L.reflect > 0) continue;
      const shift = (cam.x - stage.width * 0.5) * (1 - L.parallax);
      const tint = L.tint ?? amb;
      const depth = 0.22 + L.parallax * 0.5;
      const y = L.yOffset;
      const h = L.parallax >= 1 ? 190 : 120 + L.parallax * 210;
      const i0 = batch.push();
      writeInto(
        i0, left - 300 + shift, L.parallax >= 1 ? -180 : y - h * 0.5,
        halfW * 2 + 600, h,
        tint[0]! * depth, tint[1]! * depth, tint[2]! * depth, 1,
        -800 + li * 10,
      );
    }

    // Ground plane + the ground line the fighters stand on.
    writeQuad(batch, left - 300, -260, halfW * 2 + 600, 260, 0x0a0912, 1, -700);
    writeQuad(batch, left - 300, -3, halfW * 2 + 600, 4, stage.rimColor, 0.5, -690);

    // Walls, so the corner is legible.
    const wl = stage.wallPad;
    writeQuad(batch, wl - 6, 0, 6, 220, stage.rimColor, 0.22, -680);
    writeQuad(batch, stage.width - wl, 0, 6, 220, stage.rimColor, 0.22, -680);

    batch.flush();
  }

  // --- fighters ------------------------------------------------------------

  private drawFighters(batch: QuadBatch, s: SimState, alpha: number, dtMs: number): void {
    const f0 = s.fighter(0);
    const f1 = s.fighter(1);

    // Whoever is swinging draws in front; tie -> who landed the last hit ->
    // player index. Frozen while either is in hitstop so it never pops during
    // the visible freeze.
    if (f0.hitstop === 0 && f1.hitstop === 0) {
      const a0 = isSwinging(s, 0);
      const a1 = isSwinging(s, 1);
      this.frontIx = a0 !== a1 ? (a0 ? 0 : 1) : (s.g.lastHitBy === 1 ? 1 : 0);
    }
    const back: PlayerIx = this.frontIx === 0 ? 1 : 0;

    this.drawOne(batch, s, back, 0, alpha, dtMs);
    this.drawOne(batch, s, this.frontIx, 1000, alpha, dtMs);
  }

  private drawOne(
    batch: QuadBatch, s: SimState, p: PlayerIx, zBase: number, alpha: number, dtMs: number,
  ): void {
    const side = this.sides[p];
    const skin = side.skin;
    if (skin === null) return;

    const f = s.fighter(p);
    const char: CompiledChar = s.defs.chars[f.charId]!;
    const pose = side.pose;

    const move: CompiledMove | null =
      f.action === MoveId.NONE ? null : (char.moves[f.action] ?? null);

    const worldX = px(f.posX);
    const worldY = px(f.posY);

    applyRest(pose, restPoseOf(char.def.restPose, char.conceptSpace), f.facing);

    // Freeze the animation clock during hitstop — that IS the hit freeze on
    // screen. The camera, sparks and jiggle below keep running.
    const frozen = f.hitstop > 0;
    const blend = frozen ? 0 : alpha;

    if (move !== null) {
      sample(
        pose, char.def.restPose, null, move.poseHint,
        f.actionFrame, move.totalFrames,
        { startup: move.startup, activeFirst: move.activeFirst, activeLast: move.activeLast },
        blend,
      );
    } else {
      sample(
        pose, char.def.restPose, null, IDLE_HINT,
        f.stateFrame, 0, { startup: 0, activeFirst: -1, activeLast: -1 }, blend,
      );
    }
    setFacing(pose, f.facing);

    jiggle(pose, char.def.jiggle, side.prevRootX, worldX, side.prevRootY, worldY, dtMs);
    side.prevRootX = worldX;
    side.prevRootY = worldY;
    solve(pose);

    // Sequins sparkle when you move: advance glint by speed, not by time.
    side.glint = (side.glint + Math.abs(px(f.velX)) * 0.004 + 0.0015) % 1;

    // Hit flash: white for the first frames of hitstop, ramping out.
    const flash = frozen ? Math.min(1, f.hitstop / 9) * 0.85 : 0;
    // Defender vibration, render only — never touches position.
    const shake = frozen && f.hitstun > 0 ? ((f.hitstop & 1) === 0 ? 2.4 : -2.4) : 0;

    // A sprite skin blits (anim, frame); a skeletal skin ignores both and uses
    // the solved pose. One interface, so both paths coexist.
    const anim = move !== null ? move.anim : animOfState(f);
    const animFrame = move !== null ? f.actionFrame : f.stateFrame;

    batch.use(materialOf(skin, batch.solidMaterial));
    skin.emit(batch, pose, {
      anim,
      frame: animFrame,
      worldX, worldY,
      facing: f.facing,
      flash,
      tint: [1, 1, 1, 1],
      costume: p === 0 ? 0 : 1,
      zBase,
      glintPhase: side.glint,
      shakeX: shake,
      shakeY: 0,
      alpha: 1,
    });
    batch.flush();
  }

  // --- HUD -----------------------------------------------------------------

  private drawHud(batch: QuadBatch, s: SimState): void {
    // Screen space: a fixed 1920x1080 virtual viewport, independent of zoom.
    orthoInto(this.hud, 0, BASE_W, 0, BASE_H);
    batch.setViewProj(this.hud);
    batch.use(batch.solidMaterial);

    const pad = 64;
    const barW = 780;
    // The wiphala is ALWAYS 7 rows — that is the flag, not a tunable. So the
    // only way to make the squares bigger is a taller bar: 70 / 7 = 10px cells,
    // where 34 gave 4.9px and the weave read as fine stripes.
    const barH = 70;
    const y = BASE_H - 128;
    const stage = s.defs.stages[s.g.stageId]!;

    for (let p = 0 as PlayerIx; p <= 1; p = (p + 1) as PlayerIx) {
      const f = s.fighter(p);
      const hp = Math.max(0, Math.min(HP_MAX, f.hp));
      // The bar flares white for the length of the defender's hitstop, which is
      // the same freeze the fighters are in — so the flash and the impact are
      // the same event, not two things that happen to coincide.
      const flash = f.hitstop > 0 && f.hitstun > 0 ? Math.min(1, f.hitstop / 14) : 0;
      drawHealthBar(batch, {
        x: p === 0 ? pad : BASE_W - pad - barW,
        y,
        w: barW,
        h: barH,
        frac: hp / HP_MAX,
        leftSide: p === 0,
        z: 10,
        flash,
      });

      // AURA, beneath the health. Narrower and slimmer on purpose: it is the
      // secondary readout and must not compete with the bar the player reads
      // first. Its ceiling is the fighter's OWN stamina, so the bar is always
      // "how much of mine am I holding" rather than a shared scale.
      const maxAura = charOf(s, p).traits.stamina * AURA_SCALE;
      const auraW = Math.round(barW * 0.62);
      drawAuraBar(batch, {
        x: p === 0 ? pad : BASE_W - pad - auraW,
        y: y - AURA_BAR_H - 14,
        w: auraW,
        h: AURA_BAR_H,
        frac: maxAura > 0 ? f.aura / maxAura : 0,
        threshold: maxAura > 0 ? (AURA_DASH_MIN * AURA_SCALE) / maxAura : 1,
        leftSide: p === 0,
        z: 10,
      });
    }

    // The round clock: a whole wiphala badge whose border cells burn down.
    drawRoundTimer(batch, {
      cx: BASE_W * 0.5,
      cy: y + barH * 0.5,
      size: 132,
      seconds: secondsFromFrames(s.g.roundTimer),
      z: 10,
    });

    // Round pips, flanking the clock.
    const cx = BASE_W * 0.5;
    for (let i = 0; i < 2; i++) {
      const on = stage.rimColor;
      writeQuad(batch, cx - 96 - i * 30, y + barH * 0.5 - 11, 22, 22, s.g.p0Wins > i ? on : 0x3a3440, 1, 12);
      writeQuad(batch, cx + 74 + i * 30, y + barH * 0.5 - 11, 22, 22, s.g.p1Wins > i ? on : 0x3a3440, 1, 12);
    }

    batch.flush();
    batch.setViewProj(this.mat);
  }

  dispose(): void {
    this.backdrop?.dispose();
    this.backdrop = null;
    for (const s of this.sides) {
      if (s.skin !== null) s.skin.dispose();
      s.skin = null;
    }
    if (this.batch !== null) this.batch.dispose();
    this.batch = null;
    this.gl = null;
  }
}

// --- helpers ---------------------------------------------------------------

/** A skin carries its own program (the stick SDF). `material` is not on the
 *  CharacterSkin interface — it is an implementation detail each skin exposes —
 *  so bridge to it narrowly rather than widening the contract. */
const materialOf = (skin: CharacterSkin, fallback: Material): Material => {
  const m = (skin as unknown as { readonly material?: Material | null }).material;
  return m ?? fallback;
};

/** The clip a fighter's STATE asks for, with the severity entries resolved.
 *  Exported so the headless rules check can assert the derived clip against the
 *  real sim — this is the exact function drawOne uses, not a copy of it. */
export const animOfState = (f: FighterView): AnimId => {
  const e = STATE_ANIM[f.state];
  if (e === undefined) return AnimId.IDLE;
  return typeof e === 'function' ? e(f) : e;
};

const isSwinging = (s: SimState, p: PlayerIx): boolean => {
  const f = s.fighter(p);
  if (f.action === MoveId.NONE) return false;
  const m = s.defs.chars[f.charId]!.moves[f.action];
  if (m === null || m === undefined) return false;
  return f.actionFrame >= m.activeFirst && f.actionFrame <= m.activeLast;
};

/** writeSprite's body, inlined for the stage bands so colours stay float. */
const writeInto = (
  i: Float32Array,
  x: number, y: number, w: number, h: number,
  r: number, g: number, b: number, a: number, z: number,
): void => {
  i[0] = w; i[1] = 0; i[2] = 0; i[3] = h;
  i[4] = x; i[5] = y; i[6] = z; i[7] = 0;
  i[8] = 0; i[9] = 0; i[10] = 1; i[11] = 1;
  i[12] = r; i[13] = g; i[14] = b; i[15] = a;
  i[16] = 0; i[17] = 0; i[18] = 1; i[19] = 0;
  i[20] = 0; i[21] = 0; i[22] = 1; i[23] = 1;
};

const orthoInto = (
  out: Float32Array, left: number, right: number, bottom: number, top: number,
): void => {
  const rl = right - left || 1;
  const tb = top - bottom || 1;
  out[0] = 2 / rl; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = 2 / tb; out[5] = 0;
  out[6] = -(right + left) / rl; out[7] = -(top + bottom) / tb; out[8] = 1;
};

export const createRenderer = (camera?: FightCamera): FightRenderer => new FightRenderer(camera);

// Keep the colour helpers reachable for emitters that want them.
export { rgbR, rgbG, rgbB, Bone };

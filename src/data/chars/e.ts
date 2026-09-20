// =============================================================================
// SunForce — src/data/chars/e.ts
//
// Character E. **A COPY OF CHARACTER A**, by request: all six characters look
// alike and share one sprite sheet for now. Only the ids differ — CharId.E and
// the MoveId.E_* slots, which were reserved in the contract from the start.
//
// This is the intended shape, not a shortcut. Differentiation between A-F is
// FRAME DATA — reach, startup, active, recovery, walk speed, weight — not looks.
// Retune the numbers in this file and E becomes its own character without a
// single change anywhere else in the engine.
//
// See docs/FEEL-NUMBERS.md for the per-character targets, and CLAUDE.md for the
// art direction each slot is eventually meant to carry.
// =============================================================================

import {
  AnimId, B, Bone, CharId, G, Gd, MoveId, On, Rx, S, SfxId, SparkId,
  CTR_DAMAGE_PCT, CTR_HITSTOP_BONUS, CTR_HITSTUN_KICK, CTR_HITSTUN_PUNCH,
  HITSTOP_BLOCK_KICK, HITSTOP_BLOCK_PUNCH, HITSTOP_KICK, HITSTOP_PUNCH,
  HITSTUN_KICK, HITSTUN_PUNCH, BLOCKSTUN_KICK, BLOCKSTUN_PUNCH,
} from '@/core/contracts';
import type { CharDef, ConceptBox, ConceptSpace, MoveDef } from '@/core/contracts';

const CS: ConceptSpace = { w: 640, h: 960, originX: 302, groundY: 858, unitsPerPx: 0.5 };

// ---- shared standing boxes ---------------------------------------------------
const HURT_LEGS: ConceptBox  = [248, 470, 358, 858];   // world y   0..194
const HURT_TORSO: ConceptBox = [238, 272, 372, 472];   // world y 193..293
const HURT_HEAD: ConceptBox  = [262, 168, 348, 282];   // world y 288..345
const STAND_HURT: readonly ConceptBox[] = [HURT_LEGS, HURT_TORSO, HURT_HEAD];
const STAND_PUSH: ConceptBox = [226, 338, 378, 858];   // 76 wide x 260 tall

const STAND_MASK =
  (1 << S.STAND) | (1 << S.WALK_F) | (1 << S.WALK_B) | (1 << S.DASH_F) | (1 << S.ACTION);

// =============================================================================
// E_5P — "Jab". 5 startup / 3 active / 9 recovery = 17 total.
//   advHit   = hitstun    - (total - 1 - firstActive) = 16 - 11 =  +5
//   advBlock = blockstun  - (total - 1 - firstActive) = 11 - 11 =   0
//   Punch is the button that KEEPS your turn.
// =============================================================================
export const E_5P: MoveDef = {
  id: MoveId.E_5P,
  name: 'E 5P — Jab',
  group: G.PUNCH,
  input: { button: B.P },
  stateMask: STAND_MASK,
  totalFrames: 17,
  anim: AnimId.ATK_5P,
  poseHint: { limb: 'armF', reach: 92, height: 248, lean: 8, crouch: 0, accSwing: 6 },
  selfChain: 1,
  timeline: [
    // ---- startup 0-4 ---------------------------------------------------------
    { at: 0, hurt: STAND_HURT, pushbox: STAND_PUSH, velX: 0, friction: 0.86 },
    // f3: tiny forward weight shift — this is what gives a jab "step".
    { at: 3, velX: 0.8 },
    // ---- ACTIVE 5-7. The arm becomes a hurtbox: jabs are punishable. --------
    {
      at: 5,
      velX: 0,
      hurt: [HURT_LEGS, HURT_TORSO, HURT_HEAD, [318, 336, 470, 392]],
      hit: [{
        box: [352, 330, 486, 396],          // world x 25..92, y 231..264
        props: {
          damage: 50, guard: Gd.MID,
          hitstun: HITSTUN_PUNCH, blockstun: BLOCKSTUN_PUNCH,
          hitstop: HITSTOP_PUNCH, blockHitstop: HITSTOP_BLOCK_PUNCH,
          ctrBonusHitstun: CTR_HITSTUN_PUNCH, ctrBonusHitstop: CTR_HITSTOP_BONUS,
          ctrDamagePct: CTR_DAMAGE_PCT,
          kbX: 2.4, kbY: 0,
          blockPushX: 3.0,                  // > kbX: blockstrings push OUT
          selfPushBlock: 1.0, selfPushHit: 0,
          reaction: Rx.STAND, juggleLimit: 5, juggleCost: 1, hitId: 1,
          sfx: SfxId.HIT_LIGHT, blockSfx: SfxId.GUARD_LIGHT, spark: SparkId.IMPACT_S,
          shakeAmp: 5, shakeFrames: 7, chroma: 0,
        },
      }],
    },
    // ---- recovery 8-16 -------------------------------------------------------
    { at: 8, hurt: STAND_HURT, hit: [] },
  ],
  cancels: [
    // "cancels into that move on hit between frames 6 and 14"
    { window: [5, 14], on: On.HIT | On.BLOCK, into: G.PUNCH | G.KICK | G.SPECIAL },
    { window: [5, 14], on: On.HIT, into: G.JUMP | G.THROW },
  ],
};

// =============================================================================
// E_5K — "Zapateo". 9 startup / 4 active / 16 recovery = 29 total.
//   advHit   = 21 - 19 = +2      advBlock = 14 - 19 = -5
//   Kick is the button you GAMBLE with. Two buttons, real rock-paper-scissors.
// =============================================================================
export const E_5K: MoveDef = {
  id: MoveId.E_5K,
  name: 'E 5K — Zapateo',
  group: G.KICK,
  input: { button: B.K },
  stateMask: STAND_MASK,
  totalFrames: 29,
  anim: AnimId.ATK_5K,
  poseHint: { limb: 'legF', reach: 119, height: 194, lean: -6, crouch: 14, accSwing: 22 },
  selfChain: 0,
  timeline: [
    { at: 0, hurt: STAND_HURT, pushbox: STAND_PUSH, velX: 0, friction: 0.80, sfx: SfxId.WHIFF_HEAVY },
    // f5: the leg cocks and the knee pushes the hurtbox forward — a real risk window.
    { at: 5, hurt: [[248, 470, 386, 858], HURT_TORSO, HURT_HEAD], velX: 1.5 },
    // ---- ACTIVE 9-12 ---------------------------------------------------------
    {
      at: 9,
      velX: 1.0,
      hurt: [[248, 470, 358, 858], HURT_TORSO, HURT_HEAD, [330, 424, 524, 528]],
      hit: [{
        box: [358, 420, 540, 520],          // world x 28..119, y 169..219
        props: {
          damage: 100, guard: Gd.MID,
          hitstun: HITSTUN_KICK, blockstun: BLOCKSTUN_KICK,
          hitstop: HITSTOP_KICK, blockHitstop: HITSTOP_BLOCK_KICK,
          ctrBonusHitstun: CTR_HITSTUN_KICK, ctrBonusHitstop: CTR_HITSTOP_BONUS,
          ctrDamagePct: CTR_DAMAGE_PCT,
          kbX: 4.6, kbY: 0,
          blockPushX: 5.2,                  // > kbX
          selfPushBlock: 2.2, selfPushHit: 0,
          reaction: Rx.STAND, juggleLimit: 3, juggleCost: 2, hitId: 1,
          sfx: SfxId.HIT_HEAVY, blockSfx: SfxId.GUARD_HEAVY, spark: SparkId.IMPACT_L,
          shakeAmp: 12, shakeFrames: 11, chroma: 3.5,
        },
      }],
    },
    { at: 13, hurt: [[248, 470, 392, 858], HURT_TORSO, HURT_HEAD], hit: [], velX: 0 },
    { at: 19, hurt: STAND_HURT },
  ],
  cancels: [
    { window: [9, 22], on: On.HIT, into: G.SPECIAL | G.JUMP },
    { window: [9, 16], on: On.HIT | On.BLOCK, into: G.DASH },
  ],
};

export const CHAR_E: CharDef = {
  id: CharId.E,
  name: 'Diablo',
  dance: 'Diablada',
  hp: 1000,
  conceptSpace: CS,
  physics: {
    walkF: 4.0, walkB: 3.4,
    dashSpeed: 9.0, dashFrames: 20,
    backDashSpeed: 8.0, backDashFrames: 22,
    runDash: true,
    jumpSquat: 4, jumpVelY: 24.2, jumpVelXF: 5.0, jumpVelXB: 4.4,
    gravity: 1.10, airDrag: 1.0, groundFriction: 0.84,
    airJumps: 0, weightPct: 100, landingLag: 3,
  },
  standPush: STAND_PUSH,
  crouchPush: [222, 520, 382, 858],
  airPush: [234, 400, 370, 858],
  standHurt: STAND_HURT,
  crouchHurt: [[240, 560, 364, 858], [252, 430, 356, 562]],
  airHurt: [[246, 470, 358, 858], HURT_TORSO, HURT_HEAD],
  // Bone rest pose, CONCEPT pixels, measured off caporal.svg. Length BONE_COUNT.
  // Order matches the Bone enum: ROOT, HIP, SPINE_LOW, SPINE_UP, NECK, HEAD,
  // HEADWEAR, then the _B arm chain, the _F arm chain, _B legs, _F legs, ACC0-2.
  // B/F are assigned for facing = +1: the sheet's screen-LEFT limb (x < 302)
  // is the BACK limb.
  restPose: [
    [302, 858], [302, 470], [302, 400], [302, 300], [302, 268], [302, 220], [300, 136],
    [214, 320], [214, 320], [200, 450], [196, 548],
    [390, 320], [390, 320], [406, 450], [394, 544],
    [270, 466], [266, 650], [266, 830],
    [340, 466], [340, 650], [356, 830],
    [302, 320], [300, 136], [302, 470],
  ],
  // PRIORITY ORDER for move matching: the heavier button is checked first, so
  // when the throw macro lands (P+K within THROW_MACRO_SLOP frames) it is
  // matched before either single button can eat the press. Data, never
  // object-key order — a glob or an object's key order is not stable.
  moveOrder: [MoveId.E_5K, MoveId.E_5P],
  moves: [E_5P, E_5K],
  stick: {
    radii: [
      0, 13, 12, 14, 7, 17, 0,
      8, 8, 6, 5,
      8, 8, 6, 5,
      10, 8, 6,
      10, 8, 6,
      0, 0, 0,
    ],
    outline: 3,
    // Lifted verbatim from concept/caporal.svg's own #palette swatches.
    palette: { base: 0xa31627, accent: 0xc6973f, ink: 0x07060f, rim: 0xffd9a0 },
    // NO ACCESSORY PROXIES — plain stick figures, by request.
    //
    // The ACC0/ACC1/ACC2 BONES still exist in the skeleton and still carry
    // their jiggle springs; only the placeholder brim/puff/bells shapes are
    // gone. So the real costume art (concept/caporal.svg's `headwear`, `puffs`
    // and `bells` groups) still has bones to bind to when it is baked — we
    // just draw nothing on them for now.
    accessories: [],
  },
  jiggle: [
    { bone: Bone.ACC0, stiffness: 0.35, damping: 0.78, limit: 22 },
    { bone: Bone.ACC1, stiffness: 0.28, damping: 0.80, limit: 14 },
    { bone: Bone.ACC2, stiffness: 0.42, damping: 0.72, limit: 26 },
  ],
};

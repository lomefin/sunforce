// Headless acceptance test for the M0 game rules.
// The sim is pure over (state, inputs), so it runs fine with no browser at all.
import {
  AURA_COST_BLOCK, AURA_COST_DASH, AURA_COST_KICK, AURA_COST_PUNCH, AURA_DASH_MIN,
  AURA_SCALE, B, CharId, DOUBLE_TAP_FRAMES, KO_SLOWMO_FRAMES, MoveId, ROUNDS_TO_WIN,
  RoundState, S, StageId, WALL_PAD,
} from '../src/core/contracts';
import { winBannerText } from '../src/ui/intro';
import { createCpuSource } from '../src/input/cpu';
import { MATCH_END_HOLD_FRAMES } from '../src/game/match';
import { fx, px } from '../src/core/fixed';
import { charOf, createState } from '../src/sim/state';
import { hurtBoxesOf } from '../src/sim/collision';
import { step } from '../src/sim/step';
import { REGISTRY } from '../src/data/registry';
import { existsSync, readFileSync } from 'node:fs';
import { layoutText, measureText } from '../src/ui/font';
import { MODE_TEXT_BOXES } from '../src/ui/mode';
import {
  INTRO_BEAT_FRAMES, INTRO_FADE_FRAMES, INTRO_MIN_GO_AT_MS, IntroPhase,
  introPhaseAt, introPhaseFrames, introTimingFor,
} from '../src/ui/intro';
import {
  DEFAULT_GO_AT_MS, TROUPE_THEMES, stageForTroupe, themeForOpponent, themeOfTroupe,
} from '../src/data/troupes';

let failures = 0;
const check = (label: string, got: unknown, want: unknown): void => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${String(got)}, want ${String(want)}`);
};

/**
 * THE BASELINE FIGHTER. Traits are percentages of the authored numbers, so a
 * test of "the rule" has to be run by somebody rated 100 in the thing it is
 * testing — otherwise it measures that character's bonus instead. Virtud is
 * 100 punch, 100 kick, 100 weight, 100 stamina; her jump rating is the only one
 * that differs and no damage test touches it.
 *
 * Character A is NOT baseline any more: Caporal punches at 110.
 */
const BASELINE = CharId.F;

const fresh = (p0: CharId = CharId.A, p1: CharId = CharId.A) => {
  const s = createState(1234, p0, p1, StageId.STAGE_1, REGISTRY);
  // Stand them close enough that a 92-unit punch reaches.
  s.fighter(0).posX = fx(1780);
  s.fighter(1).posX = fx(1820);
  s.fighter(0).facing = 1;
  s.fighter(1).facing = -1;
  return s;
};

const runMove = (
  button: number, atk: CharId = CharId.A, def: CharId = CharId.A,
): { hp: number; maxStop: number; frames: number } => {
  const s = fresh(atk, def);
  let maxStop = 0;
  let hitFrame = -1;
  for (let i = 0; i < 40; i++) {
    // Press on frame 0 only — the buffer must carry it, not a held key.
    step(s, i === 0 ? button : 0, 0);
    const stop = Math.max(s.fighter(0).hitstop, s.fighter(1).hitstop);
    if (stop > maxStop) maxStop = stop;
    if (hitFrame < 0 && s.fighter(1).hp < 1000) hitFrame = i;
  }
  return { hp: s.fighter(1).hp, maxStop, frames: hitFrame };
};

console.log('--- SunForce M0 rules ---');
const s0 = fresh();
check('starting HP p0', s0.fighter(0).hp, 1000);
check('starting HP p1', s0.fighter(1).hp, 1000);

// THE RULE, measured by a baseline fighter: a punch is 50 and a kick is 100
// before any rating touches them.
const punch = runMove(B.P, BASELINE, BASELINE);
check('punch leaves HP', punch.hp, 950);
check('punch hitstop', punch.maxStop, 9);

const kick = runMove(B.K, BASELINE, BASELINE);
check('kick leaves HP', kick.hp, 900);
check('kick hitstop', kick.maxStop, 14);

// Ten kicks must KO from 1000. Each must be a SEPARATE confirm — let hitstun
// and the combo counter expire naturally between them, or proration (correctly)
// scales the later hits down and this never reaches zero.
{
  const s = fresh(BASELINE, BASELINE);
  let kos = 0;
  for (let rep = 0; rep < 12; rep++) {
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    for (let i = 0; i < 90; i++) step(s, i === 0 ? B.K : 0, 0);
    if (s.fighter(1).hp <= 0) { kos = rep + 1; break; }
  }
  check('kicks to KO', kos, 10);
  check('round awarded to p0', s.g.p0Wins, 1);
}

// A COMBO must prorate: three kicks inside one combo deal less than 300, and
// the FIRST hit is always full. That is the rule the user's "kick takes 100"
// has to survive.
{
  const s = fresh();
  for (let i = 0; i < 30; i++) step(s, i === 0 ? B.K : 0, 0);
  check('first hit is full', s.fighter(1).hp, 900);
}

// Determinism: identical inputs must produce an identical state buffer.
{
  const a = fresh(); const b = fresh();
  for (let i = 0; i < 200; i++) {
    const inp = i % 17 === 0 ? B.P : i % 23 === 0 ? B.K : i % 3 === 0 ? B.R : 0;
    step(a, inp, i % 11 === 0 ? B.P : 0);
    step(b, inp, i % 11 === 0 ? B.P : 0);
  }
  let same = true;
  for (let i = 0; i < a.buf.length; i++) if (a.buf[i] !== b.buf[i]) { same = false; break; }
  check('deterministic over 200 frames', same, true);
}

// Fighters must not tunnel through each other or leave the stage.
{
  const s = fresh();
  for (let i = 0; i < 300; i++) step(s, B.R, B.L);
  const gap = Math.abs(px(s.fighter(0).posX) - px(s.fighter(1).posX));
  check('pushboxes keep them apart', gap > 20, true);
  const inBounds = px(s.fighter(0).posX) > 80 && px(s.fighter(1).posX) < 3520;
  check('both inside stage walls', inBounds, true);
}

// THE JUMP ARC. docs/FEEL-NUMBERS.md locks 4f squat, vY 24.2, gravity 1.10,
// 45 frames airborne, a 278-unit apex and a 52-frame total cycle. Those numbers
// are asserted HERE, against the real sim, rather than re-derived from the
// formula — the formula is what the doc already is, and what would drift is the
// integration order in physics.ts (position before gravity: applying gravity
// first gives 44 frames and 254 units, a different game).
{
  const s = createState(7, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
  // Far apart: pushbox separation must not be part of what is being measured.
  s.fighter(0).posX = fx(900);
  s.fighter(1).posX = fx(2700);
  s.fighter(0).facing = 1;
  s.fighter(1).facing = -1;

  let squat = 0;
  let airborne = 0;
  let apex = 0;
  let busy = 0;
  let airPushW = -1;
  let airHurtIsAirSet = false;

  // Up for two frames only: the jump must survive the release, and the fighter
  // must not re-jump on landing off a stale press.
  for (let i = 1; i <= 90; i++) {
    step(s, i <= 2 ? B.U : 0, 0);
    const f = s.fighter(0);
    if (f.state === S.JUMP_SQUAT) squat++;
    if (f.posY > 0) airborne++;
    if (f.posY > apex) apex = f.posY;
    // "Busy" = every frame between leaving neutral and being free again.
    if (f.state !== S.STAND || f.landingLag > 0) busy++;
    if (i === 27) {
      // Apex frame: the AIR boxes must be the live ones. hurtBoxesOf returns
      // the character's own array by identity when no move is playing.
      airPushW = f.pushW;
      airHurtIsAirSet = hurtBoxesOf(s, 0) === charOf(s, 0).airHurt;
    }
  }

  const c = charOf(s, 0);
  check('jump squat is 4 frames', squat, 4);
  check('airborne 45 frames', airborne, 45);
  check('jump apex ~278u', Math.abs(px(apex) - 278) <= 2, true);
  check('total jump cycle 52 frames', busy, 52);
  check('lands back on the ground', s.fighter(0).posY, 0);
  check('actionable after the cycle', s.fighter(0).state, S.STAND);
  check('air pushbox while airborne', airPushW, c.airPush.w);
  check('air pushbox is not the standing one', c.airPush.w !== c.standPush.w, true);
  check('air hurtboxes while airborne', airHurtIsAirSet, true);
  check('back to the standing pushbox', s.fighter(0).pushW, c.standPush.w);
}

// The three jumps are three different jumps. jumpDir is latched in jump squat
// and resolved to an ABSOLUTE velocity exactly once, at launch, so the launch
// speed is checkable to the FX unit — 5.0 forward, 4.4 back, 0 neutral.
{
  const run = (dir: number): { launchVelX: number; travel: number } => {
    const s = createState(7, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1700);
    s.fighter(1).posX = fx(2700);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    const start = s.fighter(0).posX;
    let launchVelX = 0;
    for (let i = 1; i <= 60; i++) {
      step(s, i <= 2 ? B.U | dir : 0, 0);
      // Frame 5 is the launch: 4 squat frames, then the fighter leaves.
      if (i === 5) launchVelX = s.fighter(0).velX;
    }
    return { launchVelX, travel: px(s.fighter(0).posX - start) };
  };
  const c0 = charOf(createState(7, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY), 0);
  const fwd = run(B.R);
  const back = run(B.L);
  const up = run(0);
  check('forward jump launch speed', fwd.launchVelX, c0.jumpVelXF);
  check('back jump launch speed', back.launchVelX, -c0.jumpVelXB);
  check('neutral jump launch speed', up.launchVelX, 0);
  check('neutral jump goes straight up', up.travel, 0);
  check('forward jump ends forward', fwd.travel > 0, true);
  check('back jump ends back', back.travel < 0, true);
  // 5.0 forward beats 4.4 back, so a forward jump commits further than a
  // retreating one. That asymmetry is the whole risk of jumping in.
  check('forward jump commits further', fwd.travel > -back.travel, true);
}

// Jump squat is THROWABLE AND PUNISHABLE, which is the only thing that stops
// jumping being a free answer to everything: it is a GROUND state, it is not in
// any move's stateMask, and a hit lands on it normally.
{
  const s = createState(7, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
  s.fighter(0).posX = fx(1780);
  s.fighter(1).posX = fx(1820);
  s.fighter(0).facing = 1;
  s.fighter(1).facing = -1;
  // p0 presses punch on frame 1 (5 frames of startup, first active on frame 6).
  // p1 asks to jump on frame 5, so its four squat frames are 5-8 and the punch
  // arrives inside them. The squat must eat it standing.
  let hitInSquat = false;
  for (let i = 1; i <= 10; i++) {
    const before = s.fighter(1).state;
    step(s, i === 1 ? B.P : 0, i === 5 ? B.U : 0);
    if (before === S.JUMP_SQUAT && s.fighter(1).hp < 1000) hitInSquat = true;
  }
  check('jump squat is punishable', hitInSquat, true);
  check('jump squat never left the ground', s.fighter(1).posY, 0);
}

// HIT REACTIONS — the soft/hard sprite is DERIVED, and this is what makes that
// legal. The sim stores no hit "severity" and must not gain one: the state
// buffer is hashed and rolled back. It does not need one either. On the frame a
// hit lands, `hitstun` is set and `stateFrame` is reset to 0, and from then on
// both tick together INSIDE the hitstop gate, so
//
//     hitstun + stateFrame
//
// is constant for the whole reaction and hands the renderer the original
// hitstun back on any frame of it, freeze included.
//
// The stored counter is the printed stun PLUS the spent-hit-frame carry the sim
// adds on contact (STUN_CARRY in src/sim/hits.ts), so the 16-frame punch reads
// 17 and the 21-frame kick reads 22 — one more than docs/FEEL-NUMBERS.md prints,
// on purpose. src/gfx/renderer.ts thresholds at 19, which sits alone in the gap.
// Break any link in that chain — the carry, the shared tick, the stateFrame
// reset — and every hit quietly plays the wrong sprite with nothing else to
// catch it. Hence these.
//
// The imports sit down here rather than at the top because this file is only
// ever APPENDED to; ESM hoists them, so the result is identical either way.
import { AnimId } from '../src/core/contracts';
import { animOfState } from '../src/gfx/renderer';

{
  interface Reaction {
    /** hitstun + stateFrame, sampled on the first frame of the reaction. */
    sum: number;
    /** Did that sum hold on every later frame? */
    constant: boolean;
    /** Was the defender in S.HITSTUN_STAND throughout? */
    standing: boolean;
    /** The clip the renderer derives, and whether it ever flickered. */
    clip: AnimId;
    clipStable: boolean;
    /** Frames the reaction was on screen. */
    frames: number;
  }

  // p1 never presses anything: every frame with hitstun left is reaction.
  const reactionOf = (button: number): Reaction => {
    const s = fresh();
    const r: Reaction = {
      sum: -1, constant: true, standing: true,
      clip: AnimId.NONE, clipStable: true, frames: 0,
    };
    for (let i = 0; i < 60; i++) {
      step(s, i === 0 ? button : 0, 0);
      const d = s.fighter(1);
      if (d.hitstun === 0) continue;
      const n = d.hitstun + d.stateFrame;
      const clip = animOfState(d);
      if (r.frames === 0) { r.sum = n; r.clip = clip; }
      if (n !== r.sum) r.constant = false;
      if (clip !== r.clip) r.clipStable = false;
      if (d.state !== S.HITSTUN_STAND) r.standing = false;
      r.frames++;
    }
    return r;
  };

  const soft = reactionOf(B.P);
  const hard = reactionOf(B.K);

  // PUNCH -> 50 damage, 16 printed frames of hitstun, the LIGHT reaction.
  check('punch reaction: hitstun+stateFrame is constant', soft.constant, true);
  check('punch reaction: recovers its hitstun', soft.sum, 17);
  check('punch reaction: defender is in HITSTUN_STAND', soft.standing, true);
  check('punch reaction: lasts hitstun + hitstop frames', soft.frames, 17 + 9);
  check('punch reaction: derives the SOFT clip', AnimId[soft.clip], 'HIT_STAND');
  check('punch reaction: same clip on every frame', soft.clipStable, true);

  // KICK -> 100 damage, 21 printed frames of hitstun, the HEAVY reaction.
  check('kick reaction: hitstun+stateFrame is constant', hard.constant, true);
  check('kick reaction: recovers its hitstun', hard.sum, 22);
  check('kick reaction: defender is in HITSTUN_STAND', hard.standing, true);
  check('kick reaction: lasts hitstun + hitstop frames', hard.frames, 22 + 14);
  check('kick reaction: derives the HARD clip', AnimId[hard.clip], 'HIT_STAND_HARD');
  check('kick reaction: same clip on every frame', hard.clipStable, true);

  // The point of the whole exercise: the two must not collapse onto one sprite,
  // and 19 must sit strictly between them or the threshold is decorative.
  check('soft and hard are different clips', soft.clip !== hard.clip, true);
  check('19 separates light from heavy', soft.sum < 19 && hard.sum >= 19, true);
}

// =============================================================================
// UI TEXT FITS ITS BOX
// -----------------------------------------------------------------------------
// The mode screen shipped two blurbs written as one line at size 20: 947px and
// 929px of glyphs inside a 700px card with a 96px gap between the pair, so each
// one printed ~120px of itself across its neighbour. Nothing caught it but a
// screenshot, because `drawText` takes a size and an anchor and has no idea how
// wide the panel behind it is.
//
// `drawTextBox` fixes that by taking the width as an argument, and these checks
// make the fit a BUILD-TIME fact. They are pure arithmetic over the same font
// metrics the renderer draws with — no GL, no canvas, no browser.
{
  // The primitive first: the box must actually bind, or the screen check below
  // is measuring a promise nobody keeps.
  const wrapped = layoutText('THE OPPONENT IS THE CPU ITS FIGHTER DRAWN AT RANDOM', {
    size: 20, maxWidth: 632, maxLines: 2,
  });
  check('wrap: long blurb fits two lines', wrapped.lines.length, 2);
  check('wrap: no line exceeds the box', wrapped.width <= 632, true);
  check('wrap: nothing had to be sacrificed', wrapped.clipped, false);
  check('wrap: every word survives',
    wrapped.lines.join(' '), 'THE OPPONENT IS THE CPU ITS FIGHTER DRAWN AT RANDOM');

  // Authored spacing is the author's too: a run of spaces used as a column
  // separator must survive a line that never needed wrapping in the first place.
  const spaced = layoutText('MOVE WASD     CONFIRM R', { size: 20, maxWidth: 900 });
  check('wrap: a fitting line keeps its spacing', spaced.lines[0], 'MOVE WASD     CONFIRM R');

  // An authored break is the author's, not the wrapper's.
  const authored = layoutText('BOTH PADS ARE LIVE\nEACH SIDE PICKS ITS OWN FIGHTER', {
    size: 20, maxWidth: 632, maxLines: 2,
  });
  check('wrap: honours an authored newline', authored.lines[0], 'BOTH PADS ARE LIVE');

  // One line, no room to wrap: the size must come down rather than spill.
  const shrunk = layoutText('A VERY LONG SINGLE LINE OF TEXT INDEED', { size: 40, maxWidth: 300 });
  check('fit: one-line text shrinks to fit', shrunk.width <= 300, true);
  check('fit: shrinking is reported', shrunk.clipped, true);
  check('fit: still one line', shrunk.lines.length, 1);

  // A single word wider than the box has nowhere to break; it must still obey.
  const broken = layoutText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { size: 30, maxWidth: 120, maxLines: 3, minSize: 30 });
  check('fit: an unbreakable word is broken anyway', broken.width <= 120, true);

  // And the real screen: every run of text the mode selector draws, measured
  // against the panel it is drawn into. `clipped` means the box had to win.
  let worst = '';
  let worstSlack = Infinity;
  for (const t of MODE_TEXT_BOXES) {
    const L = layoutText(t.text, t.box);
    if (L.clipped) { check(`mode screen: "${t.what}" fits its box`, 'clipped', 'fits'); continue; }
    const slack = t.box.maxWidth - L.width;
    if (slack < worstSlack) { worstSlack = slack; worst = t.what; }
  }
  const clipped = MODE_TEXT_BOXES.filter((t) => layoutText(t.text, t.box).clipped).length;
  check('mode screen: no text is shrunk or truncated', clipped, 0);
  console.log(`      tightest fit is "${worst}", ${worstSlack.toFixed(1)}px of slack`);

  // The regression itself, stated as the number that broke it: the old one-line
  // blurb against the card it had to live in. If this ever stops being true the
  // font metrics changed underneath the layout.
  const wasWide = measureText('THE OPPONENT IS THE CPU, ITS FIGHTER DRAWN AT RANDOM', { size: 20 });
  check('regression: the old blurb really was wider than its card', wasWide > 700, true);
}

// =============================================================================
// THE TROUPE THEME, AND THE DOWNBEAT THE COUNTDOWN LANDS ON
// -----------------------------------------------------------------------------
// The fight's music is chosen by the troupe PLAYER TWO belongs to, and each
// track says when the word GO should appear on it. Both are pure lookups, so
// both are checkable with no audio stack and no browser.
{
  const SIM_HZ_MS = 1000 / 60;
  // Rounded: a frame is 1000/60 ms, which is not representable in binary, so
  // 480 frames — exactly eight seconds — multiplies out to 8000.000000000001.
  // The timeline is authored in whole frames and every target here is whole ms,
  // and one frame of error is 16.7 ms, so rounding cannot hide a real mistake.
  const msOf = (frames: number): number => Math.round(frames * SIM_HZ_MS);

  // Every character resolves to a track, and the six map onto exactly three.
  const ids = [CharId.A, CharId.B, CharId.C, CharId.D, CharId.E, CharId.F]
    .map((id) => themeForOpponent(REGISTRY, id));
  check('troupes: every character has a track', ids.every((t) => t !== null), true);
  check('troupes: six characters, three tracks',
    new Set(ids.map((t) => t?.musicId)).size, 3);
  check('troupes: A and B share the caporal track',
    ids[0]?.musicId === ids[1]?.musicId && ids[0]?.musicId === 'stage-caporal', true);
  check('troupes: C and D share the tinku track',
    ids[2]?.musicId === ids[3]?.musicId && ids[2]?.musicId === 'stage-tinku', true);
  check('troupes: E and F share the diablada track',
    ids[4]?.musicId === ids[5]?.musicId && ids[4]?.musicId === 'stage-diablada', true);

  // It is PLAYER TWO's troupe that picks the track, not player one's. Reading
  // the wrong index is the one bug this whole feature can have.
  check('troupes: the track follows player two',
    themeForOpponent(REGISTRY, CharId.E)?.musicId, 'stage-diablada');
  check('troupes: ...and not player one',
    themeForOpponent(REGISTRY, CharId.A)?.musicId, 'stage-caporal');

  // data/troupes.ts hard-codes 3000 as its default and promises it equals the
  // shortest timeline ui/intro.ts can produce. If the fade or a beat is ever
  // retimed, this is what says so.
  check('intro: the data default matches the intro floor',
    DEFAULT_GO_AT_MS, INTRO_MIN_GO_AT_MS);

  // The default timeline is EXACTLY what shipped before per-track timing: a
  // 750 ms fade, three beats, GO at 3.0 s, 3.5 s in total.
  const base = introTimingFor(DEFAULT_GO_AT_MS);
  check('intro: default has no hold', base.holdFrames, 0);
  check('intro: default GO lands at 3000 ms', msOf(base.goFrame), 3000);
  check('intro: default runs 210 frames', base.totalFrames, 210);

  // The diablada track: GO six seconds in, to the frame.
  const dia = introTimingFor(6000);
  check('intro: diablada GO lands at 6000 ms', msOf(dia.goFrame), 6000);
  check('intro: the extra time is all hold', dia.holdFrames, dia.goFrame - base.goFrame);
  check('intro: the fade is untouched by a later downbeat',
    introPhaseFrames(IntroPhase.FADE, dia), INTRO_FADE_FRAMES);
  check('intro: the beats keep their rhythm',
    introPhaseFrames(IntroPhase.THREE, dia), INTRO_BEAT_FRAMES);

  // Phases in order across the stretched timeline. The hold draws nothing, so
  // a player sees the stage and hears the track with the screen otherwise clear.
  check('intro: frame 0 is the fade', IntroPhase[introPhaseAt(0, dia)], 'FADE');
  check('intro: after the fade comes the hold',
    IntroPhase[introPhaseAt(INTRO_FADE_FRAMES, dia)], 'HOLD');
  check('intro: the count starts after the hold',
    IntroPhase[introPhaseAt(dia.countStart, dia)], 'THREE');
  check('intro: GO is on its own frame', IntroPhase[introPhaseAt(dia.goFrame, dia)], 'GO');
  check('intro: the frame before GO is still counting',
    IntroPhase[introPhaseAt(dia.goFrame - 1, dia)], 'ONE');
  check('intro: the fight is handed over at the end',
    IntroPhase[introPhaseAt(dia.totalFrames, dia)], 'DONE');

  // A track asking for an IMPOSSIBLY early downbeat is clamped, never rushed:
  // the fade and the three beats are the game's rhythm, not the recording's.
  check('intro: an early downbeat clamps to the floor',
    introTimingFor(0).totalFrames, base.totalFrames);

  // THE BACKDROP IS DRESSING, AND ONLY DRESSING. A troupe may bring its own
  // panorama to a shared stage, but it must not be able to move a wall: if
  // `stageForTroupe` ever touched geometry, a fight would desync from its own
  // replay while looking perfectly fine on screen.
  const stage1 = REGISTRY.stages[StageId.STAGE_1]!;
  const diaTheme = themeForOpponent(REGISTRY, CharId.E);
  const capTheme = themeForOpponent(REGISTRY, CharId.A);
  const dressed = stageForTroupe(stage1, diaTheme);
  const plain = stageForTroupe(stage1, capTheme);

  check('stage dressing: diablada brings its own backdrop',
    dressed.layers[0]?.texture, 'stages/stage-diablada.png');

  // A declared backdrop that is not on disk is a black screen with a countdown
  // over it, and nothing else in the build would say so. `npm run sheets`
  // stages assets/backgrounds/*.png into public/art/stages/.
  // Skipped rather than failed on a tree where `npm run sheets` has never run:
  // public/art is generated and gitignored, so a fresh clone legitimately has
  // none of it, and a red check there would be noise rather than a defect.
  if (!existsSync('public/art/stages')) {
    console.log('SKIP  stage dressing: public/art not built — run `npm run sheets`');
  } else {
    const missingArt = TROUPE_THEMES
      .filter((t) => t.backdrop !== undefined)
      .filter((t) => !existsSync(`public/art/${t.backdrop}`))
      .map((t) => `${t.troupe} -> ${t.backdrop}`);
    check('stage dressing: every declared backdrop is built', missingArt.join(', '), '');
  }
  check('stage dressing: caporal resolves to the stage\'s own art',
    plain.layers[0]?.texture, stage1.layers[0]?.texture);
  check('stage dressing: null theme is identity', stageForTroupe(stage1, null), stage1);
  check('stage dressing: the stage1 def is never mutated',
    stage1.layers[0]?.texture, 'stages/stage-caporal.png');

  const sameGeometry = dressed.width === stage1.width
    && dressed.wallPad === stage1.wallPad
    && dressed.ceiling === stage1.ceiling
    && dressed.startX[0] === stage1.startX[0]
    && dressed.startX[1] === stage1.startX[1]
    && dressed.id === stage1.id
    && dressed.layers.length === stage1.layers.length;
  check('stage dressing: geometry is untouched', sameGeometry, true);

  // Only the texture differs on the swapped layer — parallax, scale and offset
  // are the stage's, so the panorama sits exactly where the old one sat.
  const L0 = stage1.layers[0]!;
  const D0 = dressed.layers[0]!;
  check('stage dressing: the layer keeps its parallax and scale',
    D0.parallax === L0.parallax && D0.scale === L0.scale, true);

  // THE GROUND LINE. Each painting puts its ground somewhere different, and the
  // only thing that moves is the quad's centre — gfx/stage.ts derives the
  // effective ground fraction back out of exactly that number. A fighter
  // standing above the painted floor is the bug this pins down.
  const tinkuTheme = themeForOpponent(REGISTRY, CharId.C);
  const tinkuStage = stageForTroupe(stage1, tinkuTheme);
  check('ground: the tinku panorama is raised to meet the floor',
    (tinkuStage.layers[0]?.yOffset ?? 0) - L0.yOffset, 98);
  check('ground: caporal is not shifted at all',
    plain.layers[0]?.yOffset, L0.yOffset);

  // The camera needs 900 units of art above the ground line and 170 below, so a
  // shift that looks right but starves the view is still wrong.
  const BG_HEIGHT = 1400;
  const okCoverage = TROUPE_THEMES.every((t) => {
    const gv = (L0.yOffset + (t.backdropShiftY ?? 0) + BG_HEIGHT * 0.5) / BG_HEIGHT;
    return gv * BG_HEIGHT >= 900 && (1 - gv) * BG_HEIGHT >= 170;
  });
  check('ground: every panorama still covers the camera', okCoverage, true);

  // THE HEADLINE NUMBERS, one per track: each track's GO must land exactly where
  // its recording says, and nowhere near where another's does.
  check('intro: caporal GO lands at 8000 ms',
    msOf(introTimingFor(themeOfTroupe('Caporal')?.goAtMs ?? 0).goFrame), 8000);
  check('intro: tinku GO lands at the default 3000 ms',
    msOf(introTimingFor(themeOfTroupe('Tinku')?.goAtMs ?? 0).goFrame), 3000);

  // ...and in general: a declared downbeat is honoured to the millisecond,
  // unless it is below the floor, in which case it clamps there.
  const honoured = TROUPE_THEMES.every(
    (t) => msOf(introTimingFor(t.goAtMs).goFrame) === Math.max(INTRO_MIN_GO_AT_MS, t.goAtMs),
  );
  check('intro: every declared downbeat is honoured exactly', honoured, true);

  // Every registered track must be timeable — no negative or fractional holds.
  const sane = TROUPE_THEMES.every((t) => {
    const timing = introTimingFor(t.goAtMs);
    return timing.holdFrames >= 0 && Number.isInteger(timing.holdFrames)
      && timing.goFrame < timing.totalFrames;
  });
  check('intro: every troupe track has a sane timeline', sane, true);
}

// =============================================================================
// THE JUMP TABLE — one rating, six arcs
// -----------------------------------------------------------------------------
// `jump` scales LAUNCH VELOCITY, so apex goes with its square and air time
// linearly: one number moves both "how high" and "how long". `movement` scales
// the horizontal speed carried into the air, which is why the Tinkus cover MORE
// ground than the baseline while jumping LOWER than it — the exact interaction
// a single "jump distance" number could not express.
//
// Measured through the real sim, because a jump is an integration and the
// fixed-point step is what decides the apex.
{
  const flight = (id: CharId, dir: number) => {
    const s = createState(99, id, CharId.A, StageId.STAGE_1, REGISTRY);
    const startX = px(s.fighter(0).posX);
    const hold = dir === 0 ? B.U : dir > 0 ? B.U | B.R : B.U | B.L;
    let apex = 0;
    let air = 0;
    let launched = false;
    for (let i = 0; i < 260; i++) {
      step(s, i < 6 ? hold : 0, 0);
      const y = px(s.fighter(0).posY);
      if (y > 0) { launched = true; air++; if (y > apex) apex = y; }
      else if (launched) break;
    }
    return { apex: Math.round(apex), air, travel: Math.round(Math.abs(px(s.fighter(0).posX) - startX)) };
  };

  const up = [CharId.A, CharId.B, CharId.C, CharId.D, CharId.E, CharId.F].map((id) => flight(id, 0));
  const fwd = [CharId.A, CharId.B, CharId.C, CharId.D, CharId.E, CharId.F].map((id) => flight(id, 1));
  const [a, b, c, d, e, f] = up as [typeof up[0], typeof up[0], typeof up[0], typeof up[0], typeof up[0], typeof up[0]];

  // The two Caporales are the baseline the rest is measured against.
  check('jump: A and B are the baseline arc', `${a.apex}/${a.air}`, '279/45');
  check('jump: the two Caporales are identical', `${b.apex}/${b.air}`, `${a.apex}/${a.air}`);

  // Rated 95: lower and shorter, and the two Tinkus match each other.
  check('jump: the Tinkus jump lower than baseline', `${c.apex}/${c.air}`, '252/42');
  check('jump: the two Tinkus are identical', `${d.apex}/${d.air}`, `${c.apex}/${c.air}`);

  // Rated 90 on both jump AND movement: the shortest hop on the roster.
  check('jump: Diablo has the lowest jump', `${e.apex}/${e.air}`, '227/40');
  check('jump: Virtud has the highest', `${f.apex}/${f.air}`, '415/59');

  check('jump: the order is Virtud > Caporal > Tinku > Diablo',
    f.apex > a.apex && a.apex > c.apex && c.apex > e.apex, true);

  // THE INTERACTION worth pinning: a Tinku jumps LOWER than a Caporal and still
  // travels FURTHER, because movement 110 scales the speed carried into the air.
  check('jump: a Tinku covers more ground despite the lower arc',
    fwd[2]!.travel > fwd[0]!.travel && c.apex < a.apex, true);
  check('jump: Diablo covers the least ground',
    fwd[4]!.travel < Math.min(...fwd.map((v) => v.travel).filter((v) => v !== fwd[4]!.travel)), true);

  // No flight, no glide, no second jump — Virtud has one jump, just a bigger one.
  check('jump: Virtud still has no air jump', REGISTRY.chars[CharId.F]!.airJumps, 0);

  // A higher jump that clips the ceiling is not a higher jump: her whole
  // 378-unit body has to fit under it at the apex.
  const ceiling = REGISTRY.stages[StageId.STAGE_1]!.ceiling;
  check('jump: the highest apex still clears the ceiling', f.apex + 378 < ceiling, true);
}

// =============================================================================
// THE IDLE BREATH
// -----------------------------------------------------------------------------
// A rest pose is never still. `tools/build-sheets.py` turns the NUMBERED
// neutrals (<costume>-neutral-1 .. -N) into a looping IDLE clip; a costume with
// only the bare drawing keeps its single standing pose. The failure this
// catches is the silent one: the builder emitting a one-frame IDLE even though
// the drawings are there, which is exactly what it used to do.
{
  const SHEETS = ['a', 'b', 'c', 'd', 'e', 'f'];
  if (!existsSync('public/art/a.sheet.json')) {
    console.log('SKIP  idle: sheets not built — run `npm run sheets`');
  } else {
    let looping = 0;
    let bad = '';
    for (const slot of SHEETS) {
      const sheet = JSON.parse(readFileSync(`public/art/${slot}.sheet.json`, 'utf8')) as {
        clips: Record<string, { loopAt: number; frames: { dur: number }[] }>;
      };
      const idle = sheet.clips.IDLE;
      if (idle === undefined) { bad += `${slot}:no-IDLE `; continue; }
      // Every IDLE must loop, whether it is one drawing or five.
      if (idle.loopAt !== 0) bad += `${slot}:loopAt=${idle.loopAt} `;
      // However many drawings, one full breath is the same length — so adding a
      // pose makes each shorter rather than slowing the character down.
      const cycle = idle.frames.reduce((n, f) => n + f.dur, 0);
      if (cycle !== 40) bad += `${slot}:cycle=${cycle} `;
      if (idle.frames.length > 1) looping++;
    }
    check('idle: every IDLE clip loops on a 40-frame breath', bad.trim(), '');
    // The two Tinkus are the costumes with numbered neutrals drawn today.
    check('idle: the costumes with numbered neutrals actually animate',
      looping >= 2, true);
  }
}

// =============================================================================
// TRAITS — ratings as percentages of the authored numbers
// -----------------------------------------------------------------------------
// The rule is unchanged: a punch is authored 50 and a kick 100. A rating is a
// bonus ON TOP of that base, folded in once at compile time, so Tinku Supay's
// 90 punch is 50 * 0.90 = 45 and the sim never sees a trait at all.
{
  const duel = (atk: CharId, def: CharId, btn: number) => {
    const s = createState(1234, atk, def, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    const x0 = px(s.fighter(1).posX);
    let slide = 0;
    for (let i = 0; i < 60; i++) {
      step(s, i === 0 ? btn : 0, 0);
      const d = Math.abs(px(s.fighter(1).posX) - x0);
      if (d > slide) slide = d;
    }
    return { dmg: 1000 - s.fighter(1).hp, slide: Math.round(slide) };
  };

  // The user's own worked example.
  check('traits: Tinku Supay punches for 50 * 0.90', duel(CharId.D, BASELINE, B.P).dmg, 45);
  check('traits: Caporal punches for 50 * 1.10', duel(CharId.A, BASELINE, B.P).dmg, 55);
  check('traits: a baseline punch is still exactly 50', duel(BASELINE, BASELINE, B.P).dmg, 50);
  check('traits: a baseline kick is still exactly 100', duel(BASELINE, BASELINE, B.K).dmg, 100);
  check('traits: Diablo kicks for 100 * 1.10', duel(CharId.E, BASELINE, B.K).dmg, 110);
  check('traits: Macho Tinku kicks for 100 * 0.90', duel(CharId.C, BASELINE, B.K).dmg, 90);

  // THE SCENARIO, stated as the asymmetry it is meant to produce: the Diablo
  // takes more off a Tinku than the Tinku takes back, and shoves it further.
  const diabloHits = duel(CharId.E, CharId.C, B.K);
  const tinkuHits = duel(CharId.C, CharId.E, B.K);
  check('traits: Diablo draws more HP from a Tinku than it draws back',
    diabloHits.dmg > tinkuHits.dmg, true);
  check('traits: ...and the Tinku slides further than the Diablo does',
    diabloHits.slide > tinkuHits.slide, true);

  // Weight is mass: knockback RECEIVED goes as 100/weight.
  check('traits: Diablo is the hardest to move', REGISTRY.chars[CharId.E]!.weightPct, 83);
  check('traits: a Tinku is the easiest', REGISTRY.chars[CharId.C]!.weightPct, 111);
  check('traits: a baseline fighter is unscaled', REGISTRY.chars[BASELINE]!.weightPct, 100);

  // Movement scales walk speed; the Tinkus are the quick ones.
  check('traits: Tinkus walk faster than baseline',
    REGISTRY.chars[CharId.C]!.walkF > REGISTRY.chars[BASELINE]!.walkF, true);
  check('traits: Diablo walks slower',
    REGISTRY.chars[CharId.E]!.walkF < REGISTRY.chars[BASELINE]!.walkF, true);

  // Stamina is the aura CEILING and nothing else — it no longer shortens moves,
  // because aura owns the cadence now and one rating must not pay twice.
  const total = (id: CharId, mv: MoveId): number => REGISTRY.chars[id]!.moves[mv]!.totalFrames;
  check('traits: stamina does not alter move length any more',
    total(CharId.A, MoveId.A_5K), total(CharId.E, MoveId.E_5K));
}

// =============================================================================
// THE CLASH — two strikes on the same frame
// -----------------------------------------------------------------------------
// Neither fighter takes damage; both are shoved apart, and the lighter one goes
// further because the shove is divided by mass exactly as knockback is.
{
  const clash = (p0: CharId, p1: CharId) => {
    const s = createState(1234, p0, p1, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    for (let i = 0; i < 10; i++) step(s, i === 0 ? B.K : 0, i === 0 ? B.K : 0);
    const v0 = s.fighter(0).velX;
    const v1 = s.fighter(1).velX;
    const a = px(s.fighter(0).posX);
    const b = px(s.fighter(1).posX);
    for (let i = 0; i < 80; i++) step(s, 0, 0);
    return {
      hp0: s.fighter(0).hp, hp1: s.fighter(1).hp, v0, v1,
      d0: Math.round(Math.abs(px(s.fighter(0).posX) - a)),
      d1: Math.round(Math.abs(px(s.fighter(1).posX) - b)),
    };
  };

  const even = clash(BASELINE, BASELINE);
  check('clash: neither fighter takes damage', `${even.hp0}/${even.hp1}`, '1000/1000');
  check('clash: both are shoved', even.d0 > 0 && even.d1 > 0, true);
  // Mirror symmetry: equal weights must travel EXACTLY the same distance, or
  // the clash has a left/right bias and P1 and P2 are not playing one game.
  check('clash: equal weights go exactly the same distance', even.d0, even.d1);
  check('clash: ...in opposite directions', Math.sign(even.v0) !== Math.sign(even.v1), true);

  const uneven = clash(CharId.E, CharId.C);
  check('clash: no damage across a weight mismatch either',
    `${uneven.hp0}/${uneven.hp1}`, '1000/1000');
  check('clash: the lighter fighter is shoved further', uneven.d1 > uneven.d0, true);
  // 4.0 units scaled by each side's own weightPct: 83% and 111%.
  check('clash: the shove is divided by mass', `${Math.abs(uneven.v0)}/${Math.abs(uneven.v1)}`, '849/1136');

  // A clash leaves nobody in stun: neither of them won, so neither is punished.
  const s2 = createState(1234, CharId.E, CharId.C, StageId.STAGE_1, REGISTRY);
  s2.fighter(0).posX = fx(1780);
  s2.fighter(1).posX = fx(1820);
  s2.fighter(0).facing = 1;
  s2.fighter(1).facing = -1;
  for (let i = 0; i < 10; i++) step(s2, i === 0 ? B.K : 0, i === 0 ? B.K : 0);
  check('clash: neither fighter is left in hitstun',
    s2.fighter(0).hitstun + s2.fighter(1).hitstun, 0);
  check('clash: both are interrupted out of their attack',
    s2.fighter(0).action + s2.fighter(1).action, MoveId.NONE + MoveId.NONE);
}

// =============================================================================
// A CORNERED FIGHTER MUST STILL BE ON SCREEN
// -----------------------------------------------------------------------------
// The camera clamps its view to [0, STAGE_WIDTH], so a fighter pinned at the
// wall is drawn exactly WALL_PAD from the edge of the screen — and a sprite is
// much wider than the pushbox it hangs off. At WALL_PAD 90 the widest frame in
// the roster had 140 units of itself outside the view, which reads in game as
// the character disappearing into the edge.
{
  if (!existsSync('public/art/a.sheet.json')) {
    console.log('SKIP  corner: sheets not built — run `npm run sheets`');
  } else {
    let widest = 0;
    let where = '';
    for (const slot of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const sheet = JSON.parse(readFileSync(`public/art/${slot}.sheet.json`, 'utf8')) as {
        unitsPerPx: number;
        clips: Record<string, { frames: { uv: number[]; origin: number[] }[] }>;
      };
      for (const [clip, c] of Object.entries(sheet.clips)) {
        for (const fr of c.frames) {
          const w = fr.uv[2]! * sheet.unitsPerPx;
          const ox = fr.origin[0]! * sheet.unitsPerPx;
          const half = Math.max(ox, w - ox);
          if (half > widest) { widest = half; where = `${slot}.${clip}`; }
        }
      }
    }
    check('corner: the widest sprite still fits inside the wall',
      Math.round(widest) <= WALL_PAD, true);
    console.log(`      widest half-extent is ${Math.round(widest)}u (${where}) against WALL_PAD ${WALL_PAD}`);
  }
}

// =============================================================================
// AURA — the live half of stamina
// -----------------------------------------------------------------------------
// Stamina is the ceiling; aura is what you are holding. Attacking spends it,
// guarding spends less, dashing spends a lot, and it trickles back at
// `stamina / 100` points a second — which is why it is counted in ticks rather
// than points, so that rate is an exact integer per frame.
{
  const pts = (ticks: number): number => ticks / AURA_SCALE;
  const arena = (p0: CharId, p1: CharId) => {
    const s = createState(1234, p0, p1, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    return s;
  };

  // Everyone starts a round full, and full is their own ceiling.
  const s0 = arena(CharId.A, CharId.E);
  check('aura: a round starts at full', pts(s0.fighter(0).aura), 105);
  check('aura: ...and full is the stamina rating', pts(s0.fighter(1).aura), 90);

  // Spending, measured on the ONE frame the move starts. Starting mid-pool
  // matters: regen is clipped at the ceiling, so a fighter who is already full
  // gains nothing and a naive "add the regen back" would over-count it.
  const spend = (id: CharId, btn: number): number => {
    const s = arena(id, BASELINE);
    const f = s.fighter(0);
    const stamina = REGISTRY.chars[id]!.traits.stamina;
    f.aura = 50 * AURA_SCALE;
    let prev = f.aura;
    for (let i = 0; i < 30; i++) {
      step(s, i === 0 ? btn : 0, 0);
      if (f.action !== MoveId.NONE) return pts(prev - f.aura + stamina);
      prev = f.aura;
    }
    return -1;
  };
  check('aura: a punch costs 3', spend(BASELINE, B.P), AURA_COST_PUNCH);
  check('aura: a kick costs 5', spend(BASELINE, B.K), AURA_COST_KICK);

  // Guarding costs, but LESS than swinging — that is the whole rule.
  check('aura: a block is cheaper than a punch', AURA_COST_BLOCK < AURA_COST_PUNCH, true);
  {
    const s = arena(BASELINE, BASELINE);
    const d = s.fighter(1);
    const stamina = REGISTRY.chars[BASELINE]!.traits.stamina;
    d.aura = 50 * AURA_SCALE;
    let prev = d.aura;
    let cost = -1;
    // P2 holds guard while P1 swings; measure the frame the guard connects.
    for (let i = 0; i < 30; i++) {
      step(s, i === 0 ? B.K : 0, B.G);
      if (d.blockstun > 0) { cost = pts(prev - d.aura + stamina); break; }
      prev = d.aura;
    }
    check('aura: blocking a hit costs exactly 1', cost, AURA_COST_BLOCK);
    check('aura: ...and the block still prevented the damage', d.hp, 1000);
  }

  // REGEN, exact. `stamina` ticks a frame means the 10 points a dash costs come
  // back in (100/stamina) * 10 seconds — 9.52s for a Caporal.
  {
    const s = arena(CharId.A, CharId.A);
    const f = s.fighter(0);
    f.aura = 95 * AURA_SCALE;                       // one dash down from 105
    let frames = 0;
    while (pts(f.aura) < 105 && frames < 2000) { step(s, 0, 0); frames++; }
    check('aura: 10 points come back in 9.5 seconds', Math.round((frames / 60) * 10) / 10, 9.5);
    check('aura: and it stops at the ceiling', pts(f.aura), 105);
  }

  // THE DASH. Two gates, and both of them matter.
  const dashes = (id: CharId): number => {
    const s = arena(id, BASELINE);
    const f = s.fighter(0);
    let n = 0;
    for (let rep = 0; rep < 6; rep++) {
      // Two taps of BACK, one frame apart, then let the dash finish.
      step(s, B.L, 0);
      step(s, 0, 0);
      step(s, B.L, 0);
      if (f.state === S.DASH_F || f.state === S.DASH_B) n++;
      for (let i = 0; i < 30; i++) step(s, 0, 0);
    }
    return n;
  };
  check('aura: Caporal can dash twice before running dry', dashes(CharId.A), 2);
  check('aura: a Tinku can too', dashes(CharId.C), 2);
  // Diablo fails BOTH gates: movement 90 is under the threshold, and his
  // ceiling of 90 is not strictly above AURA_DASH_MIN either.
  check('aura: Diablo can never dash', dashes(CharId.E), 0);
  check('aura: ...because he is too slow to qualify',
    REGISTRY.chars[CharId.E]!.traits.movement < 100, true);
  check('aura: ...and his ceiling is not above the floor either',
    REGISTRY.chars[CharId.E]!.traits.stamina > AURA_DASH_MIN, false);
  check('aura: a dash costs 10', AURA_COST_DASH, 10);

  // AN EXHAUSTED FIGHTER WAITS — and the press is NOT eaten. The buffer keeps
  // holding it, so the kick comes out the moment the aura arrives rather than
  // reading as a dropped button.
  {
    const s = arena(BASELINE, BASELINE);
    const f = s.fighter(0);
    f.aura = 1 * AURA_SCALE;                        // can afford nothing
    const before = f.aura;
    step(s, B.K, 0);
    check('aura: too tired to kick, so nothing comes out', f.action, MoveId.NONE);
    // Not a point poorer: a refused move must not quietly charge for itself.
    check('aura: ...and no aura was spent trying', f.aura >= before, true);
    // The press was NOT CONSUMED either: still inside its buffer window, it
    // fires the moment the pool can pay. (The window is INPUT_LENIENCY frames,
    // not forever — a long wait expires like any other buffered input.)
    f.aura = 50 * AURA_SCALE;
    step(s, 0, 0);
    check('aura: the unconsumed press fires as soon as it can be paid for',
      f.action !== MoveId.NONE, true);
  }
}

// =============================================================================
// THE KO — flying backwards, then down
// -----------------------------------------------------------------------------
// The losing fighter is thrown backwards and up as it dies and lands in the KO
// pose, with the whole sequence played at KO_TIMESCALE_PCT by the loop. The
// slow motion is presentation — the SIM runs its normal frames — so everything
// here is measured in sim frames.
{
  const die = (loser: CharId) => {
    const s = createState(7, CharId.E, loser, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    s.fighter(1).hp = 40;                      // one kick from gone
    const d = s.fighter(1);
    let koAt = -1;
    let apex = 0;
    let air = 0;
    let landedAt = -1;
    let roundEnd = -1;
    for (let i = 0; i < 200; i++) {
      step(s, i === 0 ? B.K : 0, 0);
      if (koAt < 0 && d.state === S.KO) koAt = i;
      if (koAt >= 0) {
        const y = px(d.posY);
        if (y > apex) apex = y;
        if (y > 0) air++;
        else if (landedAt < 0 && air > 0) landedAt = i - koAt;
      }
      if (roundEnd < 0 && s.g.roundState === RoundState.ROUND_END) roundEnd = i;
    }
    return { koAt, apex: Math.round(apex), air, landedAt, roundEnd };
  };

  const tinku = die(CharId.C);
  const virtud = die(CharId.F);
  const diablo = die(CharId.E);

  // S.KO WAS UNREACHABLE before this: `g.roundState` flips to KO on the frame
  // the killing hit lands, and the fighter ladder returned early on anything
  // but FIGHT — so the state existed and nothing could ever enter it. This is
  // the check that says it is wired at all.
  // (Checked at the MOMENT it happens: by frame 200 the round has ended and
  // reset, so the fighter is standing again and a final-state read says STAND.)
  check('ko: the loser actually reaches the KO state', virtud.koAt >= 0, true);
  check('ko: ...and does so once hitstop has played out', virtud.koAt > 0, true);

  // It is a LAUNCH, not a slump: up, and backwards.
  check('ko: the loser is thrown into the air', virtud.apex > 0, true);
  check('ko: ...and comes back down', virtud.landedAt > 0, true);

  // Weight decides how far: mass resists the same throw, so the heavy barely
  // leaves the floor and the light one is flung.
  check('ko: a Tinku flies higher than Virtud', tinku.apex > virtud.apex, true);
  check('ko: ...and Virtud higher than Diablo', virtud.apex > diablo.apex, true);
  check('ko: Diablo goes down heavily', diablo.apex < tinku.apex * 0.7, true);

  // THE SEQUENCE HAS TO FIT. If the round ended while the body was still in
  // the air the KO would read as a cut, not a finish.
  check('ko: the loser lands before the round ends',
    virtud.koAt + virtud.landedAt < virtud.roundEnd, true);
  check('ko: the slowest of the three still lands in time',
    Math.max(tinku.landedAt, virtud.landedAt, diablo.landedAt) < KO_SLOWMO_FRAMES, true);
}

// =============================================================================
// THE DASH WINDOW, THE BANNERS, AND A CPU THAT BREATHES
// =============================================================================
{
  // THE DOUBLE TAP. The declared window is not the window you get: the counter
  // is decremented by the same per-frame timer pass that counts it, so the
  // usable gap is shorter at both ends. This measures the REAL range, because
  // the declared 12 worked out to about 10 and the dash would not come out.
  const dashAt = (gap: number): boolean => {
    const s = createState(3, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
    const f = s.fighter(0);
    step(s, B.L, 0);
    for (let i = 0; i < gap; i++) step(s, 0, 0);
    step(s, B.L, 0);
    return f.state === S.DASH_F || f.state === S.DASH_B;
  };
  check('dash: a quick double tap dashes', dashAt(1), true);
  check('dash: a lazy double tap still dashes', dashAt(10), true);
  check('dash: and one most of the way out does too', dashAt(13), true);
  check('dash: but a slow one does not', dashAt(DOUBLE_TAP_FRAMES + 4), false);

  // It has to be worth the aura: a dash must cover meaningfully more ground
  // than simply walking for the same time, or it is 10 points for nothing.
  const cover = (dash: boolean): number => {
    const s = createState(3, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
    const f = s.fighter(0);
    const x0 = px(f.posX);
    if (dash) { step(s, B.L, 0); step(s, 0, 0); step(s, B.L, 0); for (let i = 0; i < 25; i++) step(s, 0, 0); }
    else for (let i = 0; i < 28; i++) step(s, B.L, 0);
    return Math.abs(px(f.posX) - x0);
  };
  check('dash: covers well over twice a walk', cover(true) > cover(false) * 2, true);

  // ...and it has to READ as a dash, not as a brisk step. Measured on the DASH
  // STATE ALONE, so the taps that triggered it are not counted: a dash that
  // moves an eighth of the screen is a move nobody can see happen.
  const dashOnly = (id: CharId): number => {
    const s = createState(3, id, CharId.A, StageId.STAGE_1, REGISTRY);
    const f = s.fighter(0);
    step(s, B.R, 0); step(s, 0, 0); step(s, B.R, 0);
    let x0 = px(f.posX);
    let started = false;
    for (let i = 0; i < 60; i++) {
      const dashing = f.state === S.DASH_F || f.state === S.DASH_B;
      if (dashing && !started) { started = true; x0 = px(f.posX); }
      if (started && !dashing) break;
      step(s, 0, 0);
    }
    return Math.round(Math.abs(px(f.posX) - x0));
  };
  // The view is 1477 units across at full zoom, so 300 is a fifth of the screen.
  check('dash: the dash state alone covers real ground', dashOnly(CharId.A) > 300, true);
  check('dash: a Tinku goes further still', dashOnly(CharId.C) > dashOnly(CharId.A), true);

  // THE BANNERS. Quechua, and the number is the PLAYER, not the round.
  check('banner: the win banner speaks Quechua', winBannerText(1), 'PUKLLAQ 1 LLALLIN');
  check('banner: ...and names player two', winBannerText(2), 'PUKLLAQ 2 LLALLIN');

  // A CPU THAT BREATHES. Aura is a pool now, so a CPU that keeps swinging just
  // has its attacks refused and stands there mashing into a wall. It should
  // disengage after it lands something and never bottom out.
  const press = (id: CharId) => {
    const s = createState(99, CharId.A, id, StageId.STAGE_1, REGISTRY);
    const cpu = createCpuSource(s, { charId: id, player: 1, seed: 4242, level: 60 });
    const f = s.fighter(1);
    let min = Infinity;
    let dry = 0;
    for (let i = 0; i < 1800; i++) {
      step(s, 0, cpu.poll(i));
      const a = f.aura / AURA_SCALE;
      if (a < min) min = a;
      if (a < AURA_COST_KICK) dry++;
    }
    return { min, dry };
  };
  for (const [name, id] of [['Caporal', CharId.A], ['Macho Tinku', CharId.C], ['Diablo', CharId.E]] as const) {
    const r = press(id);
    check(`cpu: ${name} never runs its aura dry`, r.dry, 0);
    check(`cpu: ${name} keeps a working reserve`, r.min > AURA_COST_KICK * 2, true);
  }
}

// =============================================================================
// THE WINNER CELEBRATES
// -----------------------------------------------------------------------------
// S.WIN_POSE was dead code in exactly the way S.KO was: `AnimId.WIN` was mapped
// in the renderer and nothing in the sim ever entered the state, because by the
// time a round is won `g.roundState` has left FIGHT and the fighter ladder
// returns early on anything else.
{
  const finish = (winner: CharId, loser: CharId) => {
    const s = createState(7, winner, loser, StageId.STAGE_1, REGISTRY);
    s.fighter(0).posX = fx(1780);
    s.fighter(1).posX = fx(1820);
    s.fighter(0).facing = 1;
    s.fighter(1).facing = -1;
    s.fighter(1).hp = 40;
    let winAt = -1;
    let loserCelebrated = false;
    for (let i = 0; i < 120; i++) {
      step(s, i === 0 ? B.K : 0, 0);
      if (winAt < 0 && s.fighter(0).state === S.WIN_POSE) winAt = i;
      if (s.fighter(1).state === S.WIN_POSE) loserCelebrated = true;
    }
    return { winAt, loserCelebrated };
  };

  const r = finish(CharId.A, CharId.C);
  check('win: the winner reaches the win pose', r.winAt >= 0, true);
  check('win: the loser never does', r.loserCelebrated, false);

  // A DOUBLE KO is nobody's win. Equal HP means neither qualifies, which is the
  // right answer rather than an arbitrary slot-order tiebreak.
  {
    const s = createState(7, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
    s.fighter(0).hp = 0;
    s.fighter(1).hp = 0;
    let anyone = false;
    for (let i = 0; i < 90; i++) {
      step(s, 0, 0);
      if (s.fighter(0).state === S.WIN_POSE || s.fighter(1).state === S.WIN_POSE) anyone = true;
    }
    check('win: a double KO has no winner to celebrate', anyone, false);
  }

  // A ROUND WIN HOLDS ONE POSE; A MATCH WIN DANCES. The clip is the same; what
  // differs is whether its frame counter advances, so the check is that the
  // scene stays up long enough for the second pose to be reached at all.
  check('win: the match hold outlasts the celebration',
    MATCH_END_HOLD_FRAMES > 96, true);
  // ...and still leaves before the sim resets the result out from under it.
  // 420 is MATCH_END_FRAMES, private to sim/step.ts.
  check('win: ...but still leaves before the sim resets it',
    MATCH_END_HOLD_FRAMES < 420, true);

  // THE TWO SHAPES OF CELEBRATION, read off the built sheets: a Caporal strikes
  // a pose and settles into a second, a Tinku keeps swapping between them.
  if (!existsSync('public/art/a.sheet.json')) {
    console.log('SKIP  win: sheets not built — run `npm run sheets`');
  } else {
    const winClip = (slot: string) => {
      const d = JSON.parse(readFileSync(`public/art/${slot}.sheet.json`, 'utf8')) as
        { clips: Record<string, { loopAt: number; frames: { dur: number }[] }> };
      return d.clips.WIN!;
    };
    const cap = winClip('a');
    const tin = winClip('d');
    check('win: a Caporal holds its final pose', cap.loopAt, -1);
    check('win: ...after a beat on the first', cap.frames[0]!.dur < cap.frames[1]!.dur, true);
    check('win: a Tinku loops between its poses', tin.loopAt, 0);
    check('win: ...with the two evenly weighted', tin.frames[0]!.dur, tin.frames[1]!.dur);

    // THE TWO DIABLADAS DO NOT CELEBRATE ALIKE, which is why WIN_STYLE lets a
    // costume override its own troupe: Virtud strikes a pose and holds it,
    // Diablo keeps moving. A troupe-only table could not express that.
    check('win: Virtud holds her pose', winClip('f').loopAt, -1);
    check('win: Diablo keeps moving', winClip('e').loopAt, 0);
    check('win: ...overriding what his troupe does',
      winClip('e').loopAt !== winClip('f').loopAt, true);
  }
}

// =============================================================================
// ROUNDS 2 AND 3 OPEN INSIDE THE SIM
// -----------------------------------------------------------------------------
// The fight scene is entered ONCE per match; `startNextRound` runs inside the
// simulation. So the countdown in `enter()` is seen exactly once, and "ROUND 2"
// never appeared — the scene has to watch `g.roundNo` to know a round opened.
// This asserts the signal it watches actually moves.
{
  const s = createState(11, CharId.E, CharId.C, StageId.STAGE_1, REGISTRY);
  const seen: number[] = [s.g.roundNo];
  let armed = false;
  let matchOverAt = -1;
  for (let i = 0; i < 4000; i++) {
    if (s.g.roundState === RoundState.FIGHT) {
      s.fighter(0).posX = fx(1780);
      s.fighter(1).posX = fx(1820);
      s.fighter(0).facing = 1;
      s.fighter(1).facing = -1;
      if (!armed) { s.fighter(1).hp = 60; armed = true; }   // one kick from gone
    } else armed = false;
    step(s, i % 30 === 0 ? B.K : 0, 0);
    if (s.g.roundNo !== seen[seen.length - 1]) seen.push(s.g.roundNo);
    if (s.g.matchOver === 1) { matchOverAt = i; break; }
  }
  check('rounds: the round number starts at 1', seen[0], 1);
  check('rounds: a second round opens', seen.includes(2), true);
  check('rounds: ...and the scene can see it as a change', seen.length > 1, true);
  check('rounds: the match ends once someone takes two', matchOverAt >= 0, true);
  check('rounds: ...to the winner', s.g.p0Wins, ROUNDS_TO_WIN);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

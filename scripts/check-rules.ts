// Headless acceptance test for the M0 game rules.
// The sim is pure over (state, inputs), so it runs fine with no browser at all.
import { B, CharId, S, StageId } from '../src/core/contracts';
import { fx, px } from '../src/core/fixed';
import { charOf, createState } from '../src/sim/state';
import { hurtBoxesOf } from '../src/sim/collision';
import { step } from '../src/sim/step';
import { REGISTRY } from '../src/data/registry';
import { existsSync } from 'node:fs';
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

const fresh = () => {
  const s = createState(1234, CharId.A, CharId.A, StageId.STAGE_1, REGISTRY);
  // Stand them close enough that a 92-unit punch reaches.
  s.fighter(0).posX = fx(1780);
  s.fighter(1).posX = fx(1820);
  s.fighter(0).facing = 1;
  s.fighter(1).facing = -1;
  return s;
};

const runMove = (button: number): { hp: number; maxStop: number; frames: number } => {
  const s = fresh();
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

const punch = runMove(B.P);
check('punch leaves HP', punch.hp, 950);
check('punch hitstop', punch.maxStop, 9);

const kick = runMove(B.K);
check('kick leaves HP', kick.hp, 900);
check('kick hitstop', kick.maxStop, 14);

// Ten kicks must KO from 1000. Each must be a SEPARATE confirm — let hitstun
// and the combo counter expire naturally between them, or proration (correctly)
// scales the later hits down and this never reaches zero.
{
  const s = fresh();
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
  const missingArt = TROUPE_THEMES
    .filter((t) => t.backdrop !== undefined)
    .filter((t) => !existsSync(`public/art/${t.backdrop}`))
    .map((t) => `${t.troupe} -> ${t.backdrop}`);
  check('stage dressing: every declared backdrop is built', missingArt.join(', '), '');
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
    D0.parallax === L0.parallax && D0.scale === L0.scale && D0.yOffset === L0.yOffset, true);

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

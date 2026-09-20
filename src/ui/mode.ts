// =============================================================================
// SunForce — src/ui/mode.ts
// The PLAYER-COUNT screen: 1 PLAYER or 2 PLAYERS, and nothing else. It is the
// step BEFORE character select, so it owns no roster, no MatchConfig and no
// randomness — it answers exactly one question and hands the answer up.
//
// Same shape as src/ui/select.ts on purpose: a controller with `update`,
// `draw` and `reset`, no Scene import, no GL beyond the batch it is handed.
// The scene layer owns enter/tick/exit and core/loop.ts owns the transition.
//
// VISUAL LANGUAGE. The bands, the palette, the title sizes and the footer hint
// are select.ts's, copied rather than imported because select.ts exports the
// screen and not its constants — the two files are meant to look like one game,
// so if a band moves there it moves here. The only new idea is the pair of big
// side-by-side cards: this is a CHOICE, not a list, so each option is a slab
// the width of a portrait panel with its consequence written under it.
//
// INPUT. Either pad drives it. In 1P the second controller does not exist, so
// P1 must work alone; accepting both costs one extra call and means a player
// who picked up the wrong pad is not stuck on this screen.
//
//   LEFT / RIGHT   point AT a card — spatial, so they clamp, never wrap.
//   UP / DOWN      toggle between the two — an axis with no layout to obey.
//   PUNCH          confirms; `chosen` goes non-null and stays there.
//   GUARD          is NOT ours. This controller ignores it completely, so the
//                  scene is free to read the guard edge itself and cancel back
//                  to the fight in progress — the same way '[' opened us. A
//                  cancel must not be a mode, so there is no state for it here.
//
// Edges are derived from held + prev inside `update`, exactly like the select
// screen, so the scene keeps passing the same four masks it already has. Two
// options need no auto-repeat: every move is an edge, so a tap is one move.
// =============================================================================

import { B } from '@/core/contracts';
import type { ButtonMask, InstanceWriter } from '@/core/contracts';
import { writeQuad } from '@/gfx/batch';
import type { QuadBatch } from '@/gfx/batch';
import { drawTextBox } from '@/ui/font';
import type { BoxOpts } from '@/ui/font';

// -----------------------------------------------------------------------------
// PUBLIC SHAPE
// -----------------------------------------------------------------------------

export type PlayerCount = 1 | 2;

export interface ModeController {
  /** null until the choice is confirmed. Latches: it never goes back to null
   *  on its own, so a scene that misses a frame still sees the answer. */
  readonly chosen: PlayerCount | null;
  /** Same shape as SelectController: derives edges from held + prev itself. */
  update(in0: ButtonMask, in1: ButtonMask, prev0: ButtonMask, prev1: ButtonMask): void;
  /** Screen space, 1920x1080 virtual viewport, y UP. Caller has set the ortho. */
  draw(out: QuadBatch, frame: number): void;
  reset(): void;
}

// -----------------------------------------------------------------------------
// LAYOUT. Every number is derived from the two bands and the card pair, so
// moving a band moves the cards with it instead of stranding them.
// -----------------------------------------------------------------------------

const SCREEN_W = 1920;
const SCREEN_H = 1080;

/** The two bands select.ts boxes its screen with. Identical here. */
const BAND_FOOT_TOP = 212;
const BAND_HEAD_BOTTOM = 918;

const CARD_W = 700;
const CARD_H = 440;
const CARD_GAP = 96;
const CARDS_W = CARD_W * 2 + CARD_GAP;
const CARD_X0 = (SCREEN_W - CARDS_W) * 0.5;
const CARD_Y = (BAND_FOOT_TOP + BAND_HEAD_BOTTOM) * 0.5 - CARD_H * 0.5;

/** Left edge of card `i`. Two cards today; the arithmetic does not care. */
const cardX = (i: number): number => CARD_X0 + i * (CARD_W + CARD_GAP);

/** Baselines inside a card, measured UP from its bottom edge. Read the card
 *  bottom-up and the stack is: tag strip, blurb block, label, numeral plate.
 *  The gaps between them are 12-16px by construction; if you move one of these
 *  numbers, check the four gaps in the comment beside BLURB_LINES. */
const TAG_Y = 14;
const TAG_H = 44;
/** FIRST line of the blurb; the block grows DOWNWARD from here (y is UP). */
const BLURB_Y = 96;
const LABEL_Y = 132;
const NUMERAL_Y = 208;
const NUMERAL_SIZE = 190;

// TEXT WIDTH IS A CONSTRAINT, NOT A HOPE.
// Every string on this screen is drawn through `drawTextBox`, which is handed
// the width it has to live inside. The blurbs are why: written as one line at
// size 20 they measured 947px and 929px inside a 700px card, so each spilled
// ~120px per side across a 96px gap and printed itself over its neighbour.
// Hand-tuning a size against a string you cannot measure is not a layout.
const BLURB_SIZE = 20;
const BLURB_PAD = 34;
/** Two lines at size 20 with 6px leading: baselines at 96 and 70, so the block
 *  spans y 70..116. Tag top is 58 (12 clear); label baseline is 132 (16 clear). */
const BLURB_LINES = 2;
const BLURB_LEAD = 6;
/** Inner widths. A card is CARD_W wide; nothing inside it may touch the edge. */
const LABEL_W = CARD_W - 80;
const BLURB_W = CARD_W - BLURB_PAD * 2;
const TAG_INNER_W = CARD_W - 28 - 24;
/** Screen-wide runs keep a margin, so the title survives a longer word later. */
const SAFE_W = SCREEN_W - 160;
/** The recess the numeral stands in: from just under the label to over its cap. */
const PLATE_Y = NUMERAL_Y - 18;
const PLATE_H = NUMERAL_SIZE + 46;

const COL_BACKDROP = 0x0a0812;
const COL_BAND = 0x171130;
const COL_PANEL = 0x1d1830;
const COL_PANEL_HI = 0x2e2649;
const COL_PLATE = 0x120e22;
const COL_INK = 0xf6efdc;
const COL_DIM = 0x8d84a6;
const COL_DEAD = 0x4a4460;
const COL_SHADOW = 0x090713;
/** P1 gold and P2 blue, the same pair the select screen tags cursors with. The
 *  1 PLAYER card wears gold because the human is always P1; the 2 PLAYERS card
 *  wears blue because blue is the pad that only exists in that mode. */
const P_COL: readonly [number, number] = [0xffc23c, 0x49c6ff];

// -----------------------------------------------------------------------------
// THE TEXT BOXES. One definition per run of text, holding everything that
// affects LAYOUT — size, tracking, align, and the width it has to live inside.
// Colour, alpha and z are passed at the call site, because none of them can
// move a glyph. The draw path and `MODE_TEXT_BOXES` below spread these SAME
// objects, so the headless test cannot drift away from the screen it checks.
// -----------------------------------------------------------------------------

const BOX_MARK: BoxOpts = { size: 22, tracking: 12, align: 'center', maxWidth: SAFE_W };
const BOX_TITLE: BoxOpts = { size: 52, align: 'center', maxWidth: SAFE_W };
const BOX_SUB: BoxOpts = { size: 24, tracking: 6, align: 'center', maxWidth: SAFE_W };
const BOX_FOOT: BoxOpts = { size: 28, tracking: 6, align: 'center', maxWidth: SAFE_W };
const BOX_HINT: BoxOpts = { size: 20, align: 'center', maxWidth: SAFE_W };

const BOX_NUMERAL: BoxOpts = { size: NUMERAL_SIZE, align: 'center', maxWidth: CARD_W - 40 };
const BOX_LABEL: BoxOpts = { size: 46, tracking: 10, align: 'center', maxWidth: LABEL_W };
const BOX_TAG: BoxOpts = { size: 24, tracking: 8, align: 'center', maxWidth: TAG_INNER_W };
const BOX_BLURB: BoxOpts = {
  size: BLURB_SIZE, align: 'center',
  maxWidth: BLURB_W, maxLines: BLURB_LINES, leading: BLURB_LEAD,
};

/** The screen's fixed prose, in one place so a string appears exactly once. */
const TEXT = {
  mark: 'SUNFORCE',
  title: 'HOW MANY PLAYERS',
  sub: 'BEST OF THREE - FIRST TO TWO ROUNDS TAKES THE MATCH',
  browsing: 'CHOOSE A MODE TO REACH THE FIGHTER SELECT',
  hint: 'MOVE WASD OR ARROWS     CONFIRM R OR I     BACK G OR P',
} as const;

/** What the footer says once a mode is locked in. */
const takenLine = (n: PlayerCount): string =>
  `${n} ${n === 1 ? 'PLAYER' : 'PLAYERS'} - PICK YOUR FIGHTER`;

/** Draw order inside the one screen-space pass. Select.ts's keys, same gaps. */
const Z = {
  BG: -20, BAND: -18, PANEL: 0, PLATE: 4, FILL: 8,
  LETTER: 12, BORDER: 16, TAG: 20, TEXT: 24,
} as const;

// -----------------------------------------------------------------------------
// THE TWO OPTIONS. One row per card: everything the screen says about a mode
// lives here, so adding a third mode later is a row and not a redesign.
// -----------------------------------------------------------------------------

interface Option {
  readonly count: PlayerCount;
  readonly numeral: string;
  readonly label: string;
  /** What this mode actually does, under the label. '\n' is an authored line
   *  break — the box wraps anyway, but wrapping it by hand puts the break at a
   *  clause instead of wherever the greedy pass happens to run out of room. */
  readonly blurb: string;
  /** The bottom strip: who is on which pad. */
  readonly tag: string;
}

const OPTIONS: readonly Option[] = [
  {
    count: 1,
    numeral: '1',
    label: 'PLAYER',
    blurb: 'THE OPPONENT IS THE CPU\nITS FIGHTER DRAWN AT RANDOM',
    tag: 'YOU  VS  CPU',
  },
  {
    count: 2,
    numeral: '2',
    label: 'PLAYERS',
    blurb: 'BOTH PADS ARE LIVE\nEACH SIDE PICKS ITS OWN FIGHTER',
    tag: 'P1  VS  P2',
  },
];

/** The card index for a player count, and its inverse. Two rows, no search. */
const indexOf = (n: PlayerCount): number => (n === 2 ? 1 : 0);
const countAt = (i: number): PlayerCount => OPTIONS[i]?.count ?? 1;

// -----------------------------------------------------------------------------
// SMALL GEOMETRY HELPERS. Four quads beat a texture; five slabs beat a mesh.
// -----------------------------------------------------------------------------

const strokeRect = (
  out: InstanceWriter, x: number, y: number, w: number, h: number,
  t: number, color: number, alpha: number, z: number,
): void => {
  writeQuad(out, x, y, w, t, color, alpha, z);
  writeQuad(out, x, y + h - t, w, t, color, alpha, z);
  writeQuad(out, x, y + t, t, h - 2 * t, color, alpha, z);
  writeQuad(out, x + w - t, y + t, t, h - 2 * t, color, alpha, z);
};

/** A solid triangle from stacked slabs. `dir` is +1 for a right-pointing tip. */
const chevron = (
  out: InstanceWriter, cx: number, cy: number, size: number, dir: number,
  color: number, alpha: number, z: number,
): void => {
  const steps = 5;
  const unit = size / steps;
  for (let i = 0; i < steps; i++) {
    const h = size * ((steps - i) / steps);
    const x = dir > 0 ? cx + i * unit : cx - (i + 1) * unit;
    writeQuad(out, x, cy - h * 0.5, unit + 1, h, color, alpha, z);
  }
};

// -----------------------------------------------------------------------------
// THE CONTROLLER
// -----------------------------------------------------------------------------

class Mode implements ModeController {
  private ix: number;
  private pick: PlayerCount | null = null;
  /** Frame the pick landed on, for the confirm flash. -1 while browsing. */
  private picked = -1;
  private frame = 0;

  constructor(private readonly initial: PlayerCount) {
    this.ix = indexOf(initial);
  }

  get chosen(): PlayerCount | null {
    return this.pick;
  }

  reset(): void {
    this.ix = indexOf(this.initial);
    this.pick = null;
    this.picked = -1;
  }

  /**
   * Both pads, in order. Once `pick` is set the screen is deaf: the scene is
   * mid-transition and a second PUNCH must not change the answer under it.
   */
  update(in0: ButtonMask, in1: ButtonMask, prev0: ButtonMask, prev1: ButtonMask): void {
    if (this.pick !== null) return;
    this.pad(in0 & ~prev0);
    this.pad(in1 & ~prev1);
  }

  /**
   * One pad's EDGE bits. GUARD is deliberately absent — see the header: cancel
   * belongs to the scene, which still holds the fight this screen is over.
   */
  private pad(edge: ButtonMask): void {
    if (this.pick !== null) return;
    if ((edge & B.L) !== 0) this.ix = 0;
    if ((edge & B.R) !== 0) this.ix = OPTIONS.length - 1;
    if ((edge & (B.U | B.D)) !== 0) this.ix = this.ix === 0 ? OPTIONS.length - 1 : 0;
    if ((edge & B.P) !== 0) {
      this.pick = countAt(this.ix);
      this.picked = this.frame;
    }
  }

  // --- drawing ---------------------------------------------------------------

  draw(out: QuadBatch, frame: number): void {
    // Solids only on this screen, but the batch may arrive with a portrait's
    // material still bound from whatever drew last. One `use`, one draw call.
    out.use(out.solidMaterial);
    this.frame = frame;

    const pulse = 0.5 + 0.5 * Math.sin(frame * 0.17);
    // The confirm flash: a fast white-hot decay on the card that was taken, so
    // the press is visible even if the scene leaves on the very next frame.
    const flash = this.picked < 0 ? 0 : Math.max(0, 1 - (frame - this.picked) / 18);

    writeQuad(out, 0, 0, SCREEN_W, SCREEN_H, COL_BACKDROP, 1, Z.BG);
    writeQuad(out, 0, BAND_HEAD_BOTTOM, SCREEN_W, SCREEN_H - BAND_HEAD_BOTTOM, COL_BAND, 1, Z.BAND);
    writeQuad(out, 0, BAND_HEAD_BOTTOM - 3, SCREEN_W, 3, P_COL[0]!, 0.55, Z.BAND + 1);
    writeQuad(out, 0, 0, SCREEN_W, BAND_FOOT_TOP, COL_BAND, 1, Z.BAND);
    writeQuad(out, 0, BAND_FOOT_TOP, SCREEN_W, 3, P_COL[1]!, 0.45, Z.BAND + 1);

    drawTextBox(out, TEXT.mark, SCREEN_W * 0.5, 1022, { ...BOX_MARK, color: COL_DIM, z: Z.TEXT });
    drawTextBox(out, TEXT.title, SCREEN_W * 0.5, 950, { ...BOX_TITLE, color: COL_INK, z: Z.TEXT });
    drawTextBox(out, TEXT.sub, SCREEN_W * 0.5, 858, { ...BOX_SUB, color: COL_DIM, z: Z.TEXT });

    for (let i = 0; i < OPTIONS.length; i++) this.drawCard(out, i, pulse, flash);
    this.drawFooter(out);
  }

  /** One option, whole. Highlighted and not are different objects, not shades. */
  private drawCard(out: InstanceWriter, i: number, pulse: number, flash: number): void {
    const opt = OPTIONS[i];
    if (opt === undefined) return;
    const x = cardX(i);
    const y = CARD_Y;
    const cx = x + CARD_W * 0.5;
    const on = this.ix === i;
    const took = this.pick !== null && this.pick === opt.count;
    const col = P_COL[i] ?? P_COL[0]!;
    const ink = on ? COL_INK : COL_DEAD;

    writeQuad(out, x - 4, y - 4, CARD_W + 8, CARD_H + 8, COL_SHADOW, 1, Z.PANEL);
    writeQuad(out, x, y, CARD_W, CARD_H, on ? COL_PANEL_HI : COL_PANEL, 1, Z.PANEL + 1);
    writeQuad(out, x + 20, y + PLATE_Y, CARD_W - 40, PLATE_H, COL_PLATE, 1, Z.PLATE);

    // The highlight wash, and over it the flash of the card that was taken.
    if (on) writeQuad(out, x, y, CARD_W, CARD_H, col, 0.12, Z.FILL);
    if (took && flash > 0) writeQuad(out, x, y, CARD_W, CARD_H, col, 0.5 * flash, Z.FILL + 1);

    drawTextBox(out, opt.numeral, cx, y + NUMERAL_Y, {
      ...BOX_NUMERAL, color: on ? COL_INK : 0xcdc4b0, alpha: on ? 1 : 0.5, z: Z.LETTER,
    });
    drawTextBox(out, opt.label, cx, y + LABEL_Y, { ...BOX_LABEL, color: ink, z: Z.TEXT });
    drawTextBox(out, opt.blurb, cx, y + BLURB_Y, {
      ...BOX_BLURB, color: on ? COL_DIM : COL_DEAD, z: Z.TEXT,
    });

    // The bottom strip says who holds what. Solid under the highlight, hollow
    // under the other, so the pair reads at a glance from across the room.
    if (on) {
      writeQuad(out, x + 14, y + TAG_Y, CARD_W - 28, TAG_H, col, 0.95, Z.TAG);
      drawTextBox(out, opt.tag, cx, y + TAG_Y + 13, { ...BOX_TAG, color: COL_PLATE, z: Z.TEXT });
    } else {
      strokeRect(out, x + 14, y + TAG_Y, CARD_W - 28, TAG_H, 2, COL_DEAD, 1, Z.TAG);
      drawTextBox(out, opt.tag, cx, y + TAG_Y + 13, { ...BOX_TAG, color: COL_DEAD, z: Z.TEXT });
    }

    if (!on) {
      strokeRect(out, x, y, CARD_W, CARD_H, 2, COL_DEAD, 0.8, Z.BORDER);
      return;
    }

    // Highlighted: a heavy ring standing OFF the card, and a chevron on each
    // side pointing in. Locked on confirm; breathing while it is still a choice.
    const o = 10;
    const alpha = took ? 1 : 0.45 + 0.55 * pulse;
    strokeRect(out, x - o, y - o, CARD_W + o * 2, CARD_H + o * 2, 8, col, alpha, Z.BORDER);
    const armY = y + PLATE_Y + PLATE_H * 0.5;
    chevron(out, x - o - 26, armY, 30, 1, col, alpha, Z.TEXT);
    chevron(out, x + CARD_W + o + 26, armY, 30, -1, col, alpha, Z.TEXT);
  }

  /** The footer band: what the pads do, and what this screen is waiting for. */
  private drawFooter(out: InstanceWriter): void {
    const taken = this.pick !== null;
    const col = taken ? (P_COL[indexOf(this.pick ?? 1)] ?? COL_INK) : COL_INK;
    const line = taken ? takenLine(this.pick ?? 1) : TEXT.browsing;

    writeQuad(out, SCREEN_W * 0.5 - 300, 148, 600, 3, taken ? col : COL_DEAD, 0.8, Z.PLATE);
    drawTextBox(out, line, SCREEN_W * 0.5, 104, {
      ...BOX_FOOT, color: taken ? col : COL_DIM, z: Z.TEXT,
    });
    drawTextBox(out, TEXT.hint, SCREEN_W * 0.5, 38, { ...BOX_HINT, color: COL_DIM, z: Z.TEXT });
  }
}

/**
 * Every run of text this screen draws, paired with the box it must fit inside.
 * Exported for scripts/check-rules.ts, which asserts that not one of them comes
 * back `clipped` — i.e. that no label had to be shrunk or truncated to obey its
 * panel. It walks the SAME BoxOpts objects `draw` spreads, so the test measures
 * the screen rather than a copy of it that can rot.
 *
 * This exists because the blurbs shipped 247px wider than their card and only a
 * screenshot caught it. A string is now a thing the build can check.
 */
export const MODE_TEXT_BOXES: readonly { readonly what: string; readonly text: string; readonly box: BoxOpts }[] = [
  { what: 'wordmark', text: TEXT.mark, box: BOX_MARK },
  { what: 'title', text: TEXT.title, box: BOX_TITLE },
  { what: 'subtitle', text: TEXT.sub, box: BOX_SUB },
  { what: 'footer browsing', text: TEXT.browsing, box: BOX_FOOT },
  { what: 'footer 1P', text: takenLine(1), box: BOX_FOOT },
  { what: 'footer 2P', text: takenLine(2), box: BOX_FOOT },
  { what: 'control hint', text: TEXT.hint, box: BOX_HINT },
  ...OPTIONS.flatMap((o) => [
    { what: `${o.count}P numeral`, text: o.numeral, box: BOX_NUMERAL },
    { what: `${o.count}P label`, text: o.label, box: BOX_LABEL },
    { what: `${o.count}P blurb`, text: o.blurb, box: BOX_BLURB },
    { what: `${o.count}P tag`, text: o.tag, box: BOX_TAG },
  ]),
];

/**
 * A fresh mode screen. `initial` is the mode to arrive highlighted on — the
 * scene passes back whatever was played last, so returning from a match lands
 * the cursor where the player left it. Defaults to 1 PLAYER: the left card,
 * and the only mode that works with one pad on the desk.
 */
export const createModeSelect = (initial: PlayerCount = 1): ModeController =>
  new Mode(initial === 2 ? 2 : 1);

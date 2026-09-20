// =============================================================================
// SunForce — src/ui/select.ts
// The character-select SCREEN: model, input and drawing. Nothing else — the
// scene layer owns enter/tick/exit and core/loop.ts owns the transition, so
// this file never imports a Scene and never builds one.
//
// Two cursors over ONE roster. Both players may sit on the same slot; a mirror
// match is legal. Directions are ABSOLUTE here — a menu has no facing — so LEFT
// is left on the grid for both players, always.
//
// PORTRAITS. Two per costume, staged by tools/build-sheets.py:
//
//   art/portraits/<costume>-selector.png   the grid cell's thumbnail
//   art/portraits/<costume>-selected.png   the tall panel on that player's side
//   art/roster.json                        { "a": "male-caporal", ... }
//
// roster.json maps a SLOT LETTER to a costume, because the slot is what this
// screen knows and the costume is what the files are named after. Two slots may
// share a costume, so textures are cached by URL and a shared costume is one
// upload and one draw run. NOTHING here names a costume or a roster size: the
// grid is derived from SELECTABLE_CHARS and the art from roster.json, so a
// seventh character grows this screen with no edit in this file.
//
// The art is a bonus, never a dependency. Until a portrait lands — and forever
// if it never does — the cell draws the big letter it always drew and the panel
// draws the same letter large. A missing file cannot blank a cell: gfx/texture
// resolves null and every read of it is a `?? null`.
//
// DRAWING IS THREE PASSES, not one, because a texture needs its own material
// bound and the batch flushes whenever that changes:
//
//   1. every solid the portraits sit ON  (backdrop, cell bodies, recesses)
//   2. the portraits, grouped by texture (one run per costume, not per cell)
//   3. every solid that must read OVER them (letters, borders, cursors, text)
//
// That is one draw call per distinct portrait plus two, instead of one per cell.
// =============================================================================

import { B, CharId } from '@/core/contracts';
import type {
  ButtonMask, DefRegistry, InstanceWriter, MatchConfig,
} from '@/core/contracts';
import { devWarn } from '@/core/assert';
import {
  MATERIAL_KEY, makeMaterial, rgbB, rgbG, rgbR, writeQuad, writeSprite,
} from '@/gfx/batch';
import type { Material, QuadBatch } from '@/gfx/batch';
import { acquireTexture, assetUrl } from '@/gfx/texture';
import type { Texture2D } from '@/gfx/texture';
import {
  DEFAULT_CHAR, DEFAULT_STAGE, SELECTABLE_CHARS, SELECTABLE_STAGES,
  charById, cycleChar, stageById,
} from '@/data/registry';
import { drawText, measureText } from '@/ui/font';

// -----------------------------------------------------------------------------
// PUBLIC SHAPE. The scene layer drives this; it holds no scene state, and the
// only GL it touches is the batch it is handed and the context it loads its
// portraits into.
// -----------------------------------------------------------------------------

export interface SelectModel {
  readonly cursor: readonly [number, number];   // per player, index into the roster
  readonly locked: readonly [boolean, boolean];
  readonly stageIx: number;
  readonly done: boolean;                       // both players locked
}

export interface SelectController {
  readonly model: SelectModel;
  /** Called once per sim tick with this frame's and last frame's masks. */
  update(in0: ButtonMask, in1: ButtonMask, prev0: ButtonMask, prev1: ButtonMask): void;
  /**
   * Screen space, 1920x1080 virtual viewport, y UP. Caller has set the ortho.
   * Takes the BATCH and not a bare InstanceWriter because the portraits bind
   * their own material; a QuadBatch is an InstanceWriter, so nothing else
   * changes. The caller's flush at the end of the frame still draws the tail.
   */
  draw(out: QuadBatch, frame: number): void;
  /**
   * Starts the portrait loads. Fire and forget — the screen draws correctly
   * before, during and after it, and forever if it never resolves. Idempotent
   * and cheap to call twice: the work happens once per GL context. The first
   * `draw` starts it too, so a caller that forgets loses a frame, not the art.
   */
  loadPortraits(gl: WebGL2RenderingContext): Promise<void>;
  /** The chosen match once both players have locked in, else null. */
  result(base: MatchConfig): MatchConfig | null;
  reset(): void;
}

// -----------------------------------------------------------------------------
// TUNING. Repeat timings are in SIM FRAMES, because update() runs on the sim
// tick: the first move comes from the EDGE, never from the repeat, so a tap is
// always exactly one slot no matter how the frame lands.
// -----------------------------------------------------------------------------

const FIRST_REPEAT = 16;
const REPEAT_RATE = 6;

const SCREEN_W = 1920;
const SCREEN_H = 1080;

const MAX_COLS = 3;
const CELL_W = 300;
const CELL_H = 250;
const CELL_GAP = 24;
const GRID_TOP = 812;
/** No name strip. The roster's names ARE its letters, and the user does not
 *  want them written inside the boxes — the portrait is the whole cell and the
 *  cursor border is what identifies it. Kept as 0 so the geometry below still
 *  reads as "everything above the strip". */
const NAME_H = 0;

/** Slot count is the roster's, so the layout is one derivation, not a constant. */
const ROSTER = SELECTABLE_CHARS;
const COLS = Math.max(1, Math.min(MAX_COLS, ROSTER.length));
const ROWS = Math.max(1, Math.ceil(ROSTER.length / COLS));
const GRID_W = COLS * CELL_W + (COLS - 1) * CELL_GAP;
const GRID_X = (SCREEN_W - GRID_W) * 0.5;
/** Bottom edge of the LAST row. The panels span from here to GRID_TOP. */
export const GRID_BOTTOM = GRID_TOP - (ROWS - 1) * (CELL_H + CELL_GAP) - CELL_H;

/** The cell thumbnail: everything above the name strip, minus a hairline inset. */
const THUMB_PAD = 4;
const THUMB_W = CELL_W - THUMB_PAD * 2;
const THUMB_H = CELL_H - NAME_H - THUMB_PAD * 2;

// The player panel is the empty column between the screen edge and the grid,
// spanning BOTH rows. Every number below is derived from the grid, so a fourth
// column or a third row moves the panel instead of breaking it.
const PANEL_MARGIN = 20;
/** Clearance to the grid — tighter than a cell gap, because nothing sits here. */
const PANEL_GAP = 16;
/** The two bands the screen is boxed by. The panel fills what is left BETWEEN
 *  them, not just the grid's own height — that is where the extra size comes
 *  from, and deriving it means moving a band moves the art with it. */
const BAND_FOOT_TOP = 212;
const BAND_HEAD_BOTTOM = 918;
const PANEL_INSET = 12;
const PANEL_X = PANEL_MARGIN;
const PANEL_W = GRID_X - PANEL_GAP - PANEL_MARGIN;
const PANEL_Y = BAND_FOOT_TOP + PANEL_INSET;
const PANEL_H = BAND_HEAD_BOTTOM - PANEL_INSET - PANEL_Y;
/** Narrower than this and the grid has eaten the column: no panel at all,
 *  rather than a sliver. The corner nameplate still says who is on what. */
const PANEL_MIN_W = 140;
const PANEL_FITS = PANEL_W >= PANEL_MIN_W;
/** NO FRAME. The portrait is the panel: no recess, no border, no tag bar, no
 *  caption. Whose panel it is and whether they are locked is already said by
 *  the bottom nameplate, so a frame was only shrinking the art to repeat it. */
const PANEL_FRAME = 0;
const PANEL_ART_W = PANEL_W;
const PANEL_ART_H = PANEL_H;

/** P1's panel hugs the left edge; P2's is its mirror about the screen centre. */
const panelX = (p: 0 | 1): number => (p === 0 ? PANEL_X : SCREEN_W - PANEL_X - PANEL_W);

const COL_BACKDROP = 0x0a0812;
const COL_BAND = 0x171130;
const COL_PANEL = 0x1d1830;
const COL_PANEL_HI = 0x2e2649;
const COL_PLATE = 0x120e22;
const COL_INK = 0xf6efdc;
const COL_DIM = 0x8d84a6;
const COL_DEAD = 0x4a4460;
const COL_SHADOW = 0x090713;
export const COL_SCRIM = 0x0b0916;
/** Portrait tints, multiplied into the art. Full white is the art untouched. */
const ART_HOT = 0xffffff;
const ART_COLD = 0x6f6a86;
const ART_BROWSING = 0xcfc9df;
const P_COL: readonly [number, number] = [0xffc23c, 0x49c6ff];

/** Draw order inside the one screen-space pass. */
const Z = {
  BG: -20, BAND: -18, PANEL: 0, PLATE: 4, ART: 6, FILL: 8,
  LETTER: 12, BORDER: 16, TAG: 20, TEXT: 24,
} as const;

// -----------------------------------------------------------------------------
// SMALL GEOMETRY HELPERS
// -----------------------------------------------------------------------------

const wrapIx = (i: number, n: number): number => (n <= 0 ? 0 : ((i % n) + n) % n);

/** Bottom-left corner of a slot, y UP. Row 0 is the TOP row. */
const cellX = (ix: number): number => GRID_X + (ix % COLS) * (CELL_W + CELL_GAP);
const cellY = (ix: number): number =>
  GRID_TOP - Math.floor(ix / COLS) * (CELL_H + CELL_GAP) - CELL_H;

/** The CharId letter. A=0..F=5, which is exactly what the slot shows. */
const letterOf = (id: CharId): string => String.fromCharCode(65 + (id % 26));

/** Four quads, because an outline is cheaper than a texture. */
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
// PORTRAITS: roster.json -> two textures per slot, loaded once per GL context.
// -----------------------------------------------------------------------------

type PortraitKind = 'selector' | 'selected';

const ROSTER_FILE = 'art/roster.json';
const PORTRAIT_DIR = 'art/portraits';

/** roster.json's key for a slot: the CharId's own name, lower case ("a".."f"). */
const slotKey = (id: CharId): string => (CharId[id] ?? letterOf(id)).toLowerCase();

const portraitUrl = (costume: string, kind: PortraitKind): string =>
  assetUrl(`${PORTRAIT_DIR}/${costume}-${kind}.png`);

/**
 * slot letter -> costume. Resolves NULL for a missing, unreadable or malformed
 * file — never throws, never rejects, exactly like gfx/texture — and drops any
 * entry that is not a non-empty string rather than trusting the whole map.
 */
const fetchRoster = async (url: string): Promise<ReadonlyMap<string, string> | null> => {
  let raw: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[sunforce] ui/select: no roster at ${url} (${res.status}) — letters only`);
      return null;
    }
    raw = await res.json();
  } catch (e) {
    console.warn(`[sunforce] ui/select: no roster at ${url} (${String(e)}) — letters only`);
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    devWarn(`ui/select: ${url} is not a slot -> costume object — letters only`);
    return null;
  }
  const map = new Map<string, string>();
  for (const [slot, costume] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof costume === 'string' && costume !== '') map.set(slot.toLowerCase(), costume);
  }
  return map;
};

/**
 * Every portrait for the whole roster. Keyed by URL, so two slots on one
 * costume are one fetch, one decode and one upload — and one draw run later.
 */
class Portraits {
  /** Slot -> [selector URL, selected URL]. Empty until roster.json lands. */
  private readonly urls = new Map<CharId, readonly [string, string]>();
  /** URL -> the uploaded texture. A URL that failed is simply never added. */
  private readonly tex = new Map<string, Texture2D>();
  private job: Promise<void> | null = null;

  /** Idempotent: the first call does the work, every later one awaits it. */
  load(gl: WebGL2RenderingContext): Promise<void> {
    const running = this.job;
    if (running !== null) return running;
    const job = this.run(gl);
    this.job = job;
    return job;
  }

  private async run(gl: WebGL2RenderingContext): Promise<void> {
    const roster = await fetchRoster(assetUrl(ROSTER_FILE));
    if (roster === null) return;

    const jobs = new Map<string, Promise<Texture2D | null>>();
    for (const id of ROSTER) {
      const costume = roster.get(slotKey(id));
      if (costume === undefined) {
        devWarn(`ui/select: roster has no costume for slot ${slotKey(id)} — that slot keeps its letter`);
        continue;
      }
      const pair = [portraitUrl(costume, 'selector'), portraitUrl(costume, 'selected')] as const;
      this.urls.set(id, pair);
      for (const url of pair) if (!jobs.has(url)) jobs.set(url, acquireTexture(gl, url));
    }

    // Adopted one at a time: a portrait appears the moment ITS file decodes,
    // so one slow costume does not hold the other five off the screen.
    const all: Promise<void>[] = [];
    for (const [url, job] of jobs) {
      all.push(job.then((t) => { if (t !== null) this.tex.set(url, t); }));
    }
    await Promise.all(all);
  }

  /** The texture for a slot, or null while it loads and if it never arrives. */
  of(id: CharId, kind: PortraitKind): Texture2D | null {
    const pair = this.urls.get(id);
    if (pair === undefined) return null;
    return this.tex.get(kind === 'selector' ? pair[0] : pair[1]) ?? null;
  }
}

/**
 * One store per GL CONTEXT, not per visit. The select screen is opened and
 * closed over and over from the '[' key, and re-fetching four megabytes of
 * portrait each time would stutter the screen it decorates — so the store
 * outlives the controller, every URL is acquired exactly once, and the context
 * owns the lifetime. That is also why nothing here calls releaseTexture: a
 * balanced release would need a hook the scene layer does not have, and the
 * refcount must not creep up one per visit.
 */
const STORES = new WeakMap<WebGL2RenderingContext, Portraits>();

const portraitsFor = (gl: WebGL2RenderingContext): Portraits => {
  const found = STORES.get(gl);
  if (found !== undefined) return found;
  const made = new Portraits();
  STORES.set(gl, made);
  return made;
};

/**
 * Warm every select-screen portrait WITHOUT constructing a select screen.
 *
 * main.ts calls this in the background once the fight is running. The store is
 * per GL context and `load` is idempotent, so the select screen's own lazy load
 * later finds the work already done — or already in flight — and never fetches
 * twice. Never throws: a missing roster or PNG just leaves the letters.
 */
export const preloadPortraits = (gl: WebGL2RenderingContext): Promise<void> =>
  portraitsFor(gl).load(gl);

/** How much of a VERTICAL overflow is cut off the top. 0 keeps the image's very
 *  top row; 0.5 would centre the crop and behead a standing figure. */
const CROP_BIAS = 0.1;

/**
 * One portrait quad, COVER-cropped into (x, y, w, h): the rect is filled edge
 * to edge at the image's own aspect and the excess is CROPPED, never stretched.
 * Horizontal overflow is centred; vertical overflow is biased UP, so what a
 * wide box loses is boots and not a head.
 *
 * writeSprite puts (u0, v0) on the quad's BOTTOM-left corner while the image's
 * bottom row is v = 1, so v runs downward here — the same convention
 * gfx/stage.ts uses for the backdrop. Mirroring is the u pair swapped and
 * nothing else: no second file, no negative width.
 */
const drawPortrait = (
  out: InstanceWriter, tex: Texture2D,
  x: number, y: number, w: number, h: number,
  tint: number, alpha: number, z: number, mirror: boolean,
): void => {
  if (w <= 0 || h <= 0) return;
  const dest = w / h;
  const src = tex.aspect;
  const wide = src > dest;
  const uSpan = wide ? dest / src : 1;
  const vSpan = wide ? 1 : src / dest;
  const uL = (1 - uSpan) * 0.5;
  const uR = uL + uSpan;
  const vTop = (1 - vSpan) * CROP_BIAS;
  const vBot = vTop + vSpan;
  writeSprite(
    out, x, y, w, h,
    mirror ? uR : uL, vBot, mirror ? uL : uR, vTop,
    rgbR(tint), rgbG(tint), rgbB(tint), alpha, z,
  );
};

// -----------------------------------------------------------------------------
// INPUT: per-axis auto-repeat. One of these per player per axis.
// -----------------------------------------------------------------------------

interface Axis { dir: number; frames: number }

const axisOf = (m: ButtonMask, neg: number, pos: number): number =>
  ((m & pos) !== 0 ? 1 : 0) - ((m & neg) !== 0 ? 1 : 0);

/**
 * -1 / 0 / +1 for THIS frame. The edge fires immediately; holding the same
 * direction fires again after FIRST_REPEAT frames and every REPEAT_RATE after
 * that. Changing direction without a fresh edge (releasing RIGHT while LEFT is
 * still down) only re-arms — it never scrolls, so a fumbled press cannot run.
 */
const axisStep = (
  a: Axis, held: ButtonMask, prev: ButtonMask, neg: number, pos: number,
): number => {
  const edge = axisOf(held & ~prev, neg, pos);
  if (edge !== 0) { a.dir = edge; a.frames = 0; return edge; }
  const dir = axisOf(held, neg, pos);
  if (dir === 0 || dir !== a.dir) { a.dir = dir; a.frames = 0; return 0; }
  a.frames += 1;
  if (a.frames < FIRST_REPEAT) return 0;
  return (a.frames - FIRST_REPEAT) % REPEAT_RATE === 0 ? dir : 0;
};

// -----------------------------------------------------------------------------
// THE CONTROLLER
// -----------------------------------------------------------------------------

class Select implements SelectController {
  private readonly cur: [number, number] = [0, 0];
  private readonly lock: [boolean, boolean] = [false, false];
  /** [p0 horizontal, p0 vertical, p1 horizontal, p1 vertical]. */
  private readonly rep: readonly Axis[] = [
    { dir: 0, frames: 0 }, { dir: 0, frames: 0 },
    { dir: 0, frames: 0 }, { dir: 0, frames: 0 },
  ];
  private stageIx = 0;

  /** Null until the first loadPortraits; every read of it falls back to letters. */
  private art: Portraits | null = null;
  private loading = false;
  /** One material per texture. Rebuilt if the batch — and so the program — changed. */
  private readonly materials = new Map<Texture2D, Material>();
  /** Which cells are already in this frame's run. Preallocated: no per-frame garbage. */
  private readonly grouped = new Uint8Array(ROSTER.length);

  constructor(private readonly reg: DefRegistry, private readonly base: MatchConfig) {
    this.reset();
  }

  get model(): SelectModel {
    return {
      cursor: [this.cur[0], this.cur[1]],
      locked: [this.lock[0], this.lock[1]],
      stageIx: this.stageIx,
      done: this.lock[0] && this.lock[1],
    };
  }

  reset(): void {
    this.cur[0] = this.indexOfChar(this.base.chars[0]);
    this.cur[1] = this.indexOfChar(this.base.chars[1]);
    this.lock[0] = false;
    this.lock[1] = false;
    const st = SELECTABLE_STAGES.indexOf(this.base.stage);
    this.stageIx = st < 0 ? 0 : st;
    for (const a of this.rep) { a.dir = 0; a.frames = 0; }
  }

  update(in0: ButtonMask, in1: ButtonMask, prev0: ButtonMask, prev1: ButtonMask): void {
    this.player(0, in0, prev0);
    this.player(1, in1, prev1);
  }

  result(base: MatchConfig): MatchConfig | null {
    if (!this.lock[0] || !this.lock[1]) return null;
    return {
      ...base,
      chars: [this.charAt(0), this.charAt(1)] as const,
      stage: SELECTABLE_STAGES[this.stageIx] ?? DEFAULT_STAGE,
    };
  }

  loadPortraits(gl: WebGL2RenderingContext): Promise<void> {
    const store = portraitsFor(gl);
    this.art = store;
    this.loading = true;
    return store.load(gl);
  }

  // --- input ---------------------------------------------------------------

  private player(p: 0 | 1, held: ButtonMask, prev: ButtonMask): void {
    const edge = held & ~prev;

    // GUARD un-locks. Return: the same frame must not re-lock on a stale PUNCH.
    if ((edge & B.G) !== 0 && this.lock[p]) {
      this.lock[p] = false;
      return;
    }

    // Both axes tick every frame, locked or not, so the repeat state never goes
    // stale under a held stick.
    const h = axisStep(this.rep[p * 2]!, held, prev, B.L, B.R);
    const v = axisStep(this.rep[p * 2 + 1]!, held, prev, B.U, B.D);

    if (this.lock[p]) {
      // A locked player's stick drives the STAGE. With one stage on the roster
      // that is a no-op by arithmetic, not by a special case.
      if (h !== 0) this.stageIx = wrapIx(this.stageIx + h, SELECTABLE_STAGES.length);
      return;
    }

    if (h !== 0) this.cur[p] = this.moveCursor(this.cur[p], h);
    // DOWN is +1 on the vertical axis and row 0 is the top row, so a row is
    // exactly COLS slots forward. Wrapping through the roster means the cursor
    // can never land on an empty cell of a ragged last row.
    if (v !== 0) this.cur[p] = this.moveCursor(this.cur[p], v * COLS);
    if ((edge & B.P) !== 0) this.lock[p] = true;
  }

  /** Cursor arithmetic goes through cycleChar so the roster has ONE owner. */
  private moveCursor(ix: number, delta: number): number {
    const id = ROSTER[ix] ?? DEFAULT_CHAR;
    return this.indexOfChar(cycleChar(id, delta));
  }

  private indexOfChar(id: CharId): number {
    const at = ROSTER.indexOf(id);
    return at < 0 ? 0 : at;
  }

  private charAt(p: 0 | 1): CharId {
    return ROSTER[this.cur[p]] ?? DEFAULT_CHAR;
  }

  private nameOf(ix: number): string {
    return charById(this.reg, ROSTER[ix] ?? DEFAULT_CHAR).name.toUpperCase();
  }

  // --- portraits -------------------------------------------------------------

  /** A cell's thumbnail, or null: the caller then draws the letter instead. */
  private thumbOf(ix: number): Texture2D | null {
    return this.art?.of(ROSTER[ix] ?? DEFAULT_CHAR, 'selector') ?? null;
  }

  /** The panel portrait for whoever this player is ON — hovered, or locked. */
  private panelOf(p: 0 | 1): Texture2D | null {
    return this.art?.of(this.charAt(p), 'selected') ?? null;
  }

  private materialFor(batch: QuadBatch, tex: Texture2D): Material {
    const found = this.materials.get(tex);
    if (found !== undefined && found.program === batch.solid) return found;
    const made = makeMaterial(MATERIAL_KEY.HUD, batch.solid, {
      albedo: tex.texture, blend: 'alpha',
    });
    this.materials.set(tex, made);
    return made;
  }

  // --- drawing -------------------------------------------------------------

  draw(out: QuadBatch, frame: number): void {
    // The scene may fire this at enter(); if it does not, the first frame does.
    if (!this.loading) void this.loadPortraits(out.gl);
    const pulse = 0.5 + 0.5 * Math.sin(frame * 0.17);

    // --- PASS 1: every solid the portraits sit ON. One material, one call. ---
    out.use(out.solidMaterial);

    writeQuad(out, 0, 0, SCREEN_W, SCREEN_H, COL_BACKDROP, 1, Z.BG);
    writeQuad(out, 0, 918, SCREEN_W, SCREEN_H - 918, COL_BAND, 1, Z.BAND);
    writeQuad(out, 0, 915, SCREEN_W, 3, P_COL[0]!, 0.55, Z.BAND + 1);
    writeQuad(out, 0, 0, SCREEN_W, 212, COL_BAND, 1, Z.BAND);
    writeQuad(out, 0, 212, SCREEN_W, 3, P_COL[1]!, 0.45, Z.BAND + 1);

    for (let ix = 0; ix < ROSTER.length; ix++) this.drawSlotBack(out, ix);
    this.drawPanelBack(out, 0);
    this.drawPanelBack(out, 1);

    // --- PASS 2: the portraits, one run per texture. ------------------------
    this.drawThumbs(out);
    this.drawPanelArt(out, 0);
    this.drawPanelArt(out, 1);

    // --- PASS 3: every solid that must read OVER the art. -------------------
    out.use(out.solidMaterial);

    drawText(out, 'SUNFORCE', SCREEN_W * 0.5, 1022, {
      size: 22, color: COL_DIM, align: 'center', z: Z.TEXT, tracking: 12,
    });
    drawText(out, 'SELECT YOUR FIGHTER', SCREEN_W * 0.5, 950, {
      size: 52, color: COL_INK, align: 'center', z: Z.TEXT,
    });

    for (let ix = 0; ix < ROSTER.length; ix++) this.drawSlotFront(out, ix);
    this.drawMark(out, 0, pulse);
    this.drawMark(out, 1, pulse);

    this.drawPanelFront(out, 0, pulse);
    this.drawPanelFront(out, 1, pulse);
    this.drawPlate(out, 0);
    this.drawPlate(out, 1);
    this.drawStage(out);

    drawText(out,
      'MOVE WASD OR ARROWS     CONFIRM R OR I     CANCEL G OR P',
      SCREEN_W * 0.5, 38, { size: 20, color: COL_DIM, align: 'center', z: Z.TEXT });
  }

  /** A cell's body and the recess its art — or its letter — sits in. */
  private drawSlotBack(out: InstanceWriter, ix: number): void {
    const x = cellX(ix);
    const y = cellY(ix);
    const hot = this.cur[0] === ix || this.cur[1] === ix;

    writeQuad(out, x - 3, y - 3, CELL_W + 6, CELL_H + 6, COL_SHADOW, 1, Z.PANEL);
    writeQuad(out, x, y, CELL_W, CELL_H, hot ? COL_PANEL_HI : COL_PANEL, 1, Z.PANEL + 1);
    // With art the recess is the whole cell above the strip; without it, the
    // small plate the big glyph has always stood on.
    if (this.thumbOf(ix) === null) {
      writeQuad(out, x + 26, y + 70, CELL_W - 52, CELL_H - 110, COL_PLATE, 1, Z.PLATE);
    } else {
      writeQuad(out, x + THUMB_PAD, y + THUMB_PAD, THUMB_W, THUMB_H, COL_PLATE, 1, Z.PLATE);
    }
  }

  /**
   * Every cell thumbnail, GROUPED BY TEXTURE. Two slots sharing a costume share
   * one run, so six cells cost one draw call per distinct portrait — not six.
   */
  private drawThumbs(out: QuadBatch): void {
    const done = this.grouped;
    done.fill(0);
    for (let ix = 0; ix < ROSTER.length; ix++) {
      if (done[ix] === 1) continue;
      const tex = this.thumbOf(ix);
      if (tex === null) { done[ix] = 1; continue; }
      out.use(this.materialFor(out, tex));
      for (let j = ix; j < ROSTER.length; j++) {
        if (done[j] === 1 || this.thumbOf(j) !== tex) continue;
        done[j] = 1;
        const hot = this.cur[0] === j || this.cur[1] === j;
        drawPortrait(
          out, tex, cellX(j) + THUMB_PAD, cellY(j) + THUMB_PAD, THUMB_W, THUMB_H,
          hot ? ART_HOT : ART_COLD, 1, Z.ART, false,
        );
      }
    }
  }

  /** With art, nothing is written in the box at all — just the edge that keeps
   *  the opaque portrait from bleeding into the panel. The letter survives ONLY
   *  as the fallback for a costume with no portrait yet. */
  private drawSlotFront(out: InstanceWriter, ix: number): void {
    const x = cellX(ix);
    const y = cellY(ix);
    const hot = this.cur[0] === ix || this.cur[1] === ix;

    if (this.thumbOf(ix) === null) {
      drawText(out, letterOf(ROSTER[ix] ?? DEFAULT_CHAR), x + CELL_W * 0.5, y + CELL_H * 0.34, {
        size: 140, color: hot ? COL_INK : 0xcdc4b0, align: 'center', z: Z.LETTER,
      });
      return;
    }
    strokeRect(out, x + THUMB_PAD, y + THUMB_PAD, THUMB_W, THUMB_H, 2, COL_SHADOW, 0.9, Z.BORDER);
  }

  /** One player's cursor: a pulsing ring while hovering, a filled slab locked. */
  private drawMark(out: InstanceWriter, p: 0 | 1, pulse: number): void {
    const ix = this.cur[p];
    const x = cellX(ix);
    const y = cellY(ix);
    const col = P_COL[p]!;
    // P1 rings the slot from outside, P2 hugs its edge, so a shared slot still
    // shows both. Same offsets whether or not the slot IS shared.
    const o = p === 0 ? 8 : 0;
    const shared = this.cur[1 - p] === ix;
    const halfW = shared ? CELL_W * 0.5 : CELL_W;
    const halfX = shared && p === 1 ? x + CELL_W * 0.5 : x;

    if (this.lock[p]) {
      writeQuad(out, halfX, y, halfW, CELL_H, col, 0.22, Z.FILL);
      strokeRect(out, x - o, y - o, CELL_W + o * 2, CELL_H + o * 2, 8, col, 1, Z.BORDER + p);
      writeQuad(out, halfX, y, halfW, 40, col, 0.95, Z.TAG);
      drawText(out, p === 0 ? 'P1' : 'P2', halfX + halfW * 0.5, y + 11, {
        size: 24, color: COL_PLATE, align: 'center', z: Z.TEXT,
      });
      return;
    }

    strokeRect(out, x - o, y - o, CELL_W + o * 2, CELL_H + o * 2, 4, col,
      0.35 + 0.55 * pulse, Z.BORDER + p);
    const tw = 84;
    const tx = p === 0 ? x + 12 : x + CELL_W - tw - 12;
    writeQuad(out, tx, y + CELL_H - 46, tw, 34, col, 0.9, Z.TAG);
    drawText(out, p === 0 ? 'P1' : 'P2', tx + tw * 0.5, y + CELL_H - 38, {
      size: 22, color: COL_PLATE, align: 'center', z: Z.TEXT,
    });
  }

  /** Nothing sits behind the portrait now — it is drawn edge to edge. Kept as
   *  the hook the letter fallback still needs when a costume has no art. */
  private drawPanelBack(out: InstanceWriter, p: 0 | 1): void {
    if (!PANEL_FITS || this.panelOf(p) !== null) return;
    writeQuad(out, panelX(p), PANEL_Y, PANEL_W, PANEL_H, COL_PLATE, 1, Z.PLATE);
  }

  /**
   * The chosen fighter, filling the whole column. P2's is MIRRORED, so both
   * face the centre of the screen — the reason the panels are on opposite
   * sides at all.
   */
  private drawPanelArt(out: QuadBatch, p: 0 | 1): void {
    if (!PANEL_FITS) return;
    const tex = this.panelOf(p);
    if (tex === null) return;
    out.use(this.materialFor(out, tex));
    drawPortrait(
      out, tex, panelX(p) + PANEL_FRAME, PANEL_Y + PANEL_FRAME, PANEL_ART_W, PANEL_ART_H,
      this.lock[p] ? ART_HOT : ART_BROWSING, 1, Z.ART, p === 1,
    );
  }

  /**
   * What reads over the portrait: the tag, the caption, the border. LOCKED is a
   * different object from BROWSING — solid tag, colour wash, heavy frame —
   * because "I am looking at this one" and "this one is mine" must not look
   * alike for even a frame.
   */
  private drawPanelFront(out: InstanceWriter, p: 0 | 1, pulse: number): void {
    if (!PANEL_FITS) return;
    const col = P_COL[p]!;
    const x = panelX(p);
    const locked = this.lock[p];

    // No art yet, and maybe never: the letter, large. The panel is never empty.
    if (this.panelOf(p) === null) {
      drawText(out, letterOf(this.charAt(p)), x + PANEL_W * 0.5, PANEL_Y + PANEL_H * 0.42, {
        size: 190, color: locked ? COL_INK : COL_DEAD, align: 'center', z: Z.LETTER,
      });
      return;
    }

    // LOCKED vs BROWSING still has to read instantly, but with the frame gone it
    // is carried by the art itself: a colour wash when locked, and a slow pulse
    // of the player's colour along the INNER edge only — a seam against the
    // grid, not a box around the portrait.
    if (locked) {
      writeQuad(out, x, PANEL_Y, PANEL_W, PANEL_H, col, 0.14, Z.FILL);
    }
    const seamW = locked ? 5 : 3;
    const seamX = p === 0 ? x + PANEL_W - seamW : x;
    writeQuad(out, seamX, PANEL_Y, seamW, PANEL_H, col,
      locked ? 1 : 0.3 + 0.35 * pulse, Z.BORDER + p);
  }

  /** The bottom-corner nameplate: who this player is on, and whether they are in. */
  private drawPlate(out: InstanceWriter, p: 0 | 1): void {
    const col = P_COL[p]!;
    const left = p === 0;
    const x = left ? 96 : SCREEN_W - 96;
    const align = left ? 'left' : 'right';

    writeQuad(out, left ? 64 : SCREEN_W - 72, 60, 8, 130, col, 1, Z.PLATE);
    drawText(out, left ? 'P1' : 'P2', x, 150, {
      size: 32, color: col, align, z: Z.TEXT, tracking: 8,
    });
    drawText(out, this.nameOf(this.cur[p]), x, 104, {
      size: 30, color: COL_INK, align, z: Z.TEXT,
    });
    drawText(out, this.lock[p] ? 'READY' : 'CHOOSING', x, 66, {
      size: 20, color: this.lock[p] ? col : COL_DIM, align, z: Z.TEXT,
    });
  }

  /** Stage strip. One stage today: it renders, and the arrows read as dead. */
  private drawStage(out: InstanceWriter): void {
    const id = SELECTABLE_STAGES[this.stageIx] ?? DEFAULT_STAGE;
    const label = stageById(this.reg, id).name.toUpperCase();
    const opts = { size: 28, color: COL_INK, align: 'center', z: Z.TEXT } as const;
    const w = measureText(label, opts) + 96;
    const cx = SCREEN_W * 0.5;
    const live = SELECTABLE_STAGES.length > 1;

    drawText(out, 'STAGE', cx, 166, { size: 20, color: COL_DIM, align: 'center', z: Z.TEXT });
    writeQuad(out, cx - w * 0.5, 92, w, 56, COL_PANEL_HI, 1, Z.PANEL + 1);
    strokeRect(out, cx - w * 0.5, 92, w, 56, 2, live ? COL_DIM : COL_DEAD, 1, Z.PLATE);
    drawText(out, label, cx, 110, opts);
    chevron(out, cx - w * 0.5 - 18, 120, 24, -1, live ? COL_INK : COL_DEAD, 1, Z.TEXT);
    chevron(out, cx + w * 0.5 + 18, 120, 24, 1, live ? COL_INK : COL_DEAD, 1, Z.TEXT);
  }
}

export const createSelect = (registry: DefRegistry, base: MatchConfig): SelectController =>
  new Select(registry, base);

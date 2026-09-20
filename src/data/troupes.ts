// =============================================================================
// SunForce — src/data/troupes.ts
// WHAT THE FIGHT WEARS: the track, the backdrop, and when "GO" lands.
//
// None of it is a property of the stage. All of it is a property of the TROUPE
// PLAYER TWO BELONGS TO: face a Diablada and you fight to a Diablada track, in
// front of a Diablada panorama. Six characters, three troupes.
//
// A troupe with no backdrop of its own keeps the stage's, so this is additive
// rather than a fork of the stage system. All three name one today, and
// Caporal's happens to be what STAGE_1 already wore.
//
// WHY PLAYER TWO AND NOT PLAYER ONE
//   Player one is the one being answered. In 1P the CPU opponent is drawn at
//   random, so the track is a surprise chosen by the draw; in 2P it is chosen
//   by whoever picked second. Either way the music describes WHO YOU ARE UP
//   AGAINST, which is the thing a fighting game's stage theme is for.
//
// THE NAMES ARE AN EXCEPTION, AND A DELIBERATE ONE
//   CLAUDE.md says identifiers stay sequential — stages are STAGE_1..STAGE_6
//   and their music is stage-1.mp3. These ids break that rule on purpose,
//   because they are NOT stage ids: no `StageId` maps to them and no stage
//   declares them. They are troupe ids, and a troupe's name is real the same
//   way a character's is. The files the user drops in are named to match:
//
//     public/audio/music/stage-caporal.<ext>
//     public/audio/music/stage-tinku.<ext>
//     public/audio/music/stage-diablada.<ext>
//
//   `StageDef.musicId` still exists and still works; it is simply the FALLBACK
//   now, used when a character's troupe has no track of its own.
//
// GO-TIME IS A PROPERTY OF THE RECORDING
//   Each track has its own downbeat, so each says when the countdown should
//   hand over. `goAtMs` is measured from the first frame of the intro — which
//   is also when the track starts — so "6000" means the word GO appears six
//   seconds into the music. ui/intro.ts turns that into a hold before the
//   count; it never speeds the count up or cuts the fade.
//
// PURE DATA. Nothing here reads SimState, allocates per frame, or is hashed.
// =============================================================================

import type { CharId, DefRegistry, StageDef } from '@/core/contracts';
import { charById } from '@/data/registry';

/** One troupe's fight music, and where its countdown lands. */
export interface TroupeTheme {
  /** Matched against `CharDef.dance`, case- and space-insensitively. */
  readonly troupe: string;
  /** `public/audio/music/<musicId>.<ext>` — convention, not configuration. */
  readonly musicId: string;
  /**
   * Milliseconds from the start of the intro (and of the track) to the frame
   * the word GO appears. Below the floor in ui/intro.ts it is clamped up: the
   * fade and the three counted beats cannot be compressed.
   */
  readonly goAtMs: number;
  /**
   * The panorama this troupe fights in front of, as a StageLayer texture path
   * (`stages/<file>.png`, resolved under public/art/). Absent means the stage
   * keeps whatever its own StageDef declares.
   *
   * All three troupes name one today. Caporal's IS the stage's own default —
   * stated here anyway so the table reads uniformly and a future stage cannot
   * silently take its panorama away.
   *
   * Only the ART changes. The geometry, the walls, the ceiling and the camera
   * bounds are the stage's and stay the stage's, so a backdrop swap can never
   * move a wall or desync anything: see `stageForTroupe`.
   */
  readonly backdrop?: string;
  /**
   * World units to RAISE this troupe's panorama, so its painted ground meets
   * the line the fighters actually stand on (world y = 0).
   *
   * Every painting puts its ground somewhere different. STAGE_1's layer is
   * placed for the Caporal pier deck, 0.73 of the way down that image; a
   * painting with a deeper foreground has its ground lower, which leaves the
   * fighters hanging in the air above it. Raising the quad by the difference
   * brings the two together.
   *
   * THE CONVERSION: the panorama is 1400 world units tall over 724 source
   * pixels, so one source pixel is 1.93 units and shifting by a fraction `f`
   * of the image is `f * 1400`. The camera needs 900 units of art above the
   * ground line and 170 below, which bounds the effective ground fraction to
   * roughly 0.64..0.88 — i.e. this shift to about -125..+210.
   */
  readonly backdropShiftY?: number;
}

/**
 * The default, and the value every track gets until someone times it: the
 * unmodified 750 ms fade plus 3 · 2 · 1 with no hold at all. Kept as a number
 * rather than imported from ui/intro.ts so that data does not depend on UI —
 * check-rules.ts asserts the two agree.
 */
export const DEFAULT_GO_AT_MS = 3000;

/**
 * The three troupes. Adding a fourth is a row here plus a file in
 * public/audio/music/; nothing else in the game needs to know.
 */
export const TROUPE_THEMES: readonly TroupeTheme[] = [
  // Eight seconds in — the longest opener of the three.
  {
    troupe: 'Caporal',
    musicId: 'stage-caporal',
    goAtMs: 8000,
    backdrop: 'stages/stage-caporal.png',
  },
  {
    troupe: 'Tinku',
    musicId: 'stage-tinku',
    goAtMs: DEFAULT_GO_AT_MS,
    backdrop: 'stages/stage-tinku.png',
    // The altiplano has a deep foreground: its ground sits at about 0.80 of the
    // way down the image against the pier's 0.73, so the fighters stood ~98
    // units above the dry grass. 1400 * (0.80 - 0.73).
    backdropShiftY: 98,
  },
  // Six seconds in: this recording opens long, and the countdown waits for it.
  {
    troupe: 'Diablada',
    musicId: 'stage-diablada',
    goAtMs: 6000,
    backdrop: 'stages/stage-diablada.png',
  },
];

/** Comparison key. A troupe is authored prose — trim it and fold the case. */
const key = (s: string): string => s.trim().toLowerCase();

const BY_TROUPE: ReadonlyMap<string, TroupeTheme> = new Map(
  TROUPE_THEMES.map((t) => [key(t.troupe), t]),
);

/**
 * The theme for a troupe, or `null` when nothing is registered for it. Null and
 * not a throw: a character whose troupe has no track should fall back to the
 * stage's own music, which is the caller's decision and not this file's.
 */
export const themeOfTroupe = (troupe: string): TroupeTheme | null =>
  BY_TROUPE.get(key(troupe)) ?? null;

/**
 * The theme a fight should play, given the character on the RIGHT-HAND side.
 * Returns null when that character's troupe has no track, so the caller keeps
 * whatever the stage declares.
 */
export const themeForOpponent = (reg: DefRegistry, p2: CharId): TroupeTheme | null =>
  themeOfTroupe(charById(reg, p2).def.dance);

/**
 * `base` wearing the troupe's backdrop, or `base` itself when the troupe has
 * none. ONLY the panorama layer's texture is replaced — every number the sim or
 * the camera reads (width, wallPad, ceiling, startX) is passed through
 * untouched, so this is dressing and nothing else.
 *
 * Returned as a plain object rather than mutated: StageDefs are shared, deeply
 * readonly module constants, and one fight must not repaint another's.
 */
export const stageForTroupe = (base: StageDef, theme: TroupeTheme | null): StageDef => {
  const art = theme?.backdrop;
  if (art === undefined || art === '') return base;
  const first = base.layers[0];
  if (first === undefined) return base;
  // `yOffset` is the panorama quad's centre, and gfx/stage.ts derives the
  // effective ground fraction straight back out of it — so moving the centre IS
  // moving the ground line. Nothing else about the layer changes.
  const shift = theme?.backdropShiftY ?? 0;
  const panorama = { ...first, texture: art, yOffset: first.yOffset + shift };
  return { ...base, layers: [panorama, ...base.layers.slice(1)] };
};

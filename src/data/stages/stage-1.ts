// =============================================================================
// SunForce — src/data/stages/stage-1.ts
// "Stage 1" — the Morro promenade at midday (Morro de Arica, Pacific coast).
//
// A StageDef is NOT compiled. Unlike CharDef it crosses no authoring seam: the
// sim reads width / wallPad / ceiling / startX straight out of this object and
// converts them to FX at the point of use (sim/state.ts: stageLeftFx and
// friends). Everything else in here is PRESENTATION and therefore float — the
// backdrop rig, the light, the particles. None of it is ever hashed.
//
// -----------------------------------------------------------------------------
// WHAT CHANGED, AND WHY
// -----------------------------------------------------------------------------
// This stage used to declare seven procedural parallax layers pointing at PNGs
// under stages/stage-1/layers/ that were never painted. They are gone. There is
// now ONE piece of real art — a painted panorama, 2172 x 724, opaque — and the
// whole rig is that single quad: palm promenade, headland, ocean to the right,
// tiled plaza across the foreground. The fighters stand ON the tiles.
//
// A panorama is not seven silhouettes. Everything a layer stack used to buy us
// (depth from differential motion) now comes out of the painting itself, so the
// only motion left to author is ONE parallax rate for the whole image.
//
// -----------------------------------------------------------------------------
// THE GEOMETRY
// -----------------------------------------------------------------------------
// The one measurement the art cannot tell us is where in the image the ground
// is. Sampling full-width row averages across the boundary:
//
//   rows 495-530  (v 0.68-0.73)  207,163,138   warm tan — the PIER DECK
//   row  533      (v 0.736)       84, 63, 68   sharp drop — the deck's fascia
//   rows 555+     (v 0.77+)       70,104,125   blue — open water
//
// This painting puts the walkable surface on a PIER, not on a deep plaza, so
// the deck band is shallow and the ground line has to sit inside it. GROUND_V
// = 0.73 (y ~ 529) stands the fighters on the deck just back from its lip; the
// strip the camera shows below their feet is then the pier's front face and
// the sea, which is what standing on a pier looks like.
//
// Height and width follow from that and from the source aspect, which is
// exactly 3:1 (2172 = 3 x 724), so BG_W comes out on a whole number.
//
// The camera (gfx/camera.ts) is what these have to satisfy. BASE_H 1080 at
// zoom 1, ZOOM_MIN 0.8, FLOOR_BLEED 170, ceiling 900. At zoom 0.8 halfH is 675
// and floorY (505) is ABOVE ceilY (225), so the clamp collapses to y = floorY:
// the view is [-170, 1180] — note the top goes well past `ceiling`, which is
// the real worst case and the one the quad has to cover. At zoom 1.3 the view
// is at worst [-170, 900]. So the quad must reach y >= 1180 and y <= -170:
// +1218 and -182 clear both, by 38 above and 12 below.
// =============================================================================

import { CEILING, STAGE_WIDTH, WALL_PAD, StageId } from '@/core/contracts';
import type { StageDef, StageLayer } from '@/core/contracts';

// -----------------------------------------------------------------------------
// THE BACKDROP — source art
// -----------------------------------------------------------------------------

// The stage's DEFAULT panorama is the Caporal one. The stage is still STAGE_1
// and its id is still sequential — but every fight is dressed by the troupe on
// the right (src/data/troupes.ts), and Caporal is the troupe that does not
// override anything, so its art is what the bare stage wears. Naming the file
// for the troupe rather than the stage keeps the three panoramas symmetric.

/** Art-root-relative, matching the sprite-sheet convention (public/art/…). */
const BACKDROP_TEX = 'stages/stage-caporal.png';

/** What the browser actually fetches. public/ is the web root. */
const BACKDROP_URL = '/art/stages/stage-caporal.png';

/** Source pixels. Measured, not guessed: 2172 x 724, exactly 3:1. */
const IMAGE_W = 2172;
const IMAGE_H = 724;

// -----------------------------------------------------------------------------
// THE BACKDROP — world placement
// -----------------------------------------------------------------------------

/**
 * Fraction from the TOP of the image down to the line the fighters stand on.
 *
 * MEASURED off the painting, not guessed. Sweeping rows down the source:
 *   y 495-530  warm tan, peaking 88/69/55 -> the PIER DECK, the walkable surface
 *   y 533      sharp drop to 33/25/27     -> the deck's edge shadow / fascia
 *   y 555+     turns blue                 -> open water
 * 0.73 (y ~ 529) puts the fighters on the deck just back from its lip, so the
 * band the camera shows below their feet is the pier's front face and then the
 * sea — which is what standing on a pier actually looks like.
 *
 * Coverage after the change (camera needs >= 900 above, >= 170 below):
 *   above  0.73 * 1400 = 1022   slack 122
 *   below  0.27 * 1400 =  378   slack 208
 */
const GROUND_V = 0.73;

/** World units the whole image spans vertically. */
const BG_H = 1400;

/** Aspect is preserved exactly: 1400 * (2172 / 724) = 1400 * 3 = 4200. */
const BG_W = (BG_H * IMAGE_W) / IMAGE_H;

/** Top and bottom edges in world space, with y = 0 on the ground line. */
const BG_TOP_Y = GROUND_V * BG_H;              // +1022, covers the 900 view top
const BG_BOTTOM_Y = -(1 - GROUND_V) * BG_H;    //  -378, covers the -170 floor bleed

/** Quad centre, which is what StageLayer.yOffset names. */
const BG_CENTRE_Y = (BG_TOP_Y + BG_BOTTOM_Y) * 0.5;   // +322

/** Centre of the play field; the backdrop is pinned here at camera centre. */
const STAGE_MID = STAGE_WIDTH * 0.5;                  // 1800

/**
 * Parallax. 0 = infinitely far (locked to the camera), 1 = the play plane.
 *
 * 0.35 is far enough that the headland reads as distance and close enough that
 * a full-stage walk still visibly moves it. Coverage, which is the part that
 * has to be checked rather than felt: the camera clamps x to
 * [halfW, 3600 - halfW] with halfW = 960 / zoom, so halfW is 1200 at zoom 0.8
 * and 738.5 at 1.3. At the right-hand clamp the view edge is 3600 and the
 * backdrop's right edge is
 *     1800 + (3600 - halfW - 1800) * 0.65 + BG_W / 2  =  5070 - 0.65 * halfW
 * giving 690 units of spare at zoom 0.8 and 990 at zoom 1.3, symmetric on the
 * left. BG_W would have to fall below 2820 before the edge showed.
 */
const BG_PARALLAX = 0.35;

/**
 * Where to centre the backdrop quad for a camera at `camX`.
 *
 * Pinning the centre at STAGE_MID and moving it by (1 - parallax) of the
 * camera's own displacement makes its APPARENT motion exactly `parallax` x the
 * camera's — which is the definition we want, and it keeps the image centred
 * on the stage centre when the camera is.
 */
export const backdropCentreX = (camX: number): number =>
  STAGE_MID + (camX - STAGE_MID) * (1 - BG_PARALLAX);

/**
 * Everything the renderer needs to draw the panorama, in one object so there is
 * a single place to read it from and a single place to change it.
 *
 * NOTE for the draw: the quad is fixed in world space vertically. The
 * PARALLAX_Y_FACTOR treatment that the layer stack used must NOT be applied to
 * it — top and bottom above are exact camera-coverage numbers with only 38 and
 * 12 units of slack, and any vertical drift eats that immediately.
 */
export const STAGE_1_BACKDROP = {
  texture: BACKDROP_TEX,
  url: BACKDROP_URL,
  imageW: IMAGE_W,
  imageH: IMAGE_H,
  /** Image v of world y = 0. */
  groundV: GROUND_V,
  worldW: BG_W,
  worldH: BG_H,
  topY: BG_TOP_Y,
  bottomY: BG_BOTTOM_Y,
  centreY: BG_CENTRE_Y,
  parallax: BG_PARALLAX,
  /** Backdrop centre when the camera is centred on the stage. */
  anchorX: STAGE_MID,
} as const;

/**
 * The panorama as a StageLayer, so any generic layer walk still finds it.
 *
 * `scale` here is world units per SOURCE PIXEL — 1400 / 724 — which is the only
 * reading of "art scale at the play plane" that survives a sheet whose pixel
 * size is not its world size. A renderer that would rather size the quad from
 * worldW/worldH should use STAGE_1_BACKDROP and ignore this; the two agree.
 * hazeAmount is 0 because the haze is painted in.
 */
const BACKDROP_LAYER: StageLayer = {
  texture: BACKDROP_TEX,
  parallax: BG_PARALLAX,
  yOffset: BG_CENTRE_Y,
  scale: BG_H / IMAGE_H,
  hazeAmount: 0,
};

const LAYERS: readonly StageLayer[] = [BACKDROP_LAYER];

// -----------------------------------------------------------------------------
// FALLBACK — what to draw when the PNG is missing or will not decode
// -----------------------------------------------------------------------------

/**
 * A missing image must never break the game, so the renderer keeps its flat
 * band path. What it does NOT have any more is seven tinted layers to derive
 * bands from, so the palette lives here instead: full-width row averages taken
 * off the actual painting, converted to world y through GROUND_V and BG_H.
 *
 * It is a crude read of the painting, which is the point — it is legible, it is
 * the right colours, the fighters still land on a warm plaza, and it costs one
 * quad per band. Ordered back to front (top band first).
 */
const band = (
  rowTop: number,
  rowBottom: number,
  tint: readonly [number, number, number],
): { topY: number; bottomY: number; tint: readonly [number, number, number] } => ({
  topY: (GROUND_V - rowTop / IMAGE_H) * BG_H,
  bottomY: (GROUND_V - rowBottom / IMAGE_H) * BG_H,
  tint,
});

/** Sampled rows -> world bands. Values are the measured sRGB / 255. */
export const STAGE_1_FALLBACK_BANDS = [
  band(0, 90, [0.22, 0.49, 0.82]),     //  57,125,208  deep zenith blue
  band(90, 200, [0.44, 0.58, 0.75]),   // 111,147,191  sky toward the horizon
  band(200, 330, [0.53, 0.53, 0.54]),  // 134,135,138  coastal haze, headland
  band(330, 450, [0.49, 0.46, 0.44]),  // 124,118,113  the Morro itself
  band(450, 545, [0.44, 0.41, 0.43]), // 111,104,109  promenade, palms
  band(545, 585, [0.39, 0.42, 0.49]),  //  99,107,124  water
  band(585, 625, [0.65, 0.54, 0.47]),  // 166,137,119  wet tile at the edge
  band(625, 680, [0.77, 0.56, 0.44]),  // 196,142,113  dry tile — the play plane
  band(680, IMAGE_H, [0.62, 0.49, 0.44]), // 159,125,111  tile in shadow, nearest
] as const;

// -----------------------------------------------------------------------------
// SPAWNS
// -----------------------------------------------------------------------------

/**
 * Spawn positions, world units. Symmetric about the centre of a 3600-unit
 * stage (1800) at ±180 — just under two fighter widths apart, close enough
 * that round start is already in poking range and neither player has to walk.
 */
const SPAWN_LEFT = 1620;
const SPAWN_RIGHT = 1980;

/**
 * "Stage 1".
 *
 * World X ∈ [0, 3600] with 90 units of wall pad each side, ceiling 900. The
 * bounds come from the shared constants rather than literals so the stage, the
 * sim and the validator cannot drift apart (ENGINE-DECISIONS §15).
 */
export const STAGE_1: StageDef = {
  id: StageId.STAGE_1,
  name: 'Stage 1',

  width: STAGE_WIDTH,
  wallPad: WALL_PAD,
  ceiling: CEILING,
  startX: [SPAWN_LEFT, SPAWN_RIGHT],

  layers: LAYERS,

  // ---------------------------------------------------------------------------
  // LIGHT. Re-derived from the painting, not from a brief — these three values
  // are what make a sprite sit IN the scene instead of on top of it, and the
  // old altiplano-dawn numbers (cold, dim, low amber rim) would read as a
  // cutout against bright coastal midday.
  //
  // Ambient is the fill a fighter standing on the plaza actually receives, so
  // it is a weighted sum of what surrounds them, measured off the image:
  //     0.45 x dry tile        (0.77, 0.56, 0.44)   they are right on it
  //     0.33 x horizon sky     (0.53, 0.53, 0.54)   the big flat source
  //     0.22 x zenith blue     (0.22, 0.49, 0.82)   overhead, and very blue
  //   = (0.57, 0.53, 0.56), lifted x1.33 for midday exposure.
  //
  // What comes out is nearly neutral, and that is the correct answer rather
  // than a boring one: the terracotta bounce off the tiles and the deep blue
  // overhead very nearly cancel. Red still finishes highest (the plaza), blue
  // second (the sky), green lowest — a pale warm cast with a cool lift in the
  // shadows, which is exactly what noon on a tiled seafront looks like.
  // ---------------------------------------------------------------------------
  ambientLight: [0.76, 0.71, 0.74],

  // The sun is high and a little to the right: sky luminance peaks around
  // x = 1450 of 2172 (v 0.67) and the tiles brighten toward the same side.
  // Unit length (0.28² + 0.96² = 1 exactly) so the renderer can use it raw —
  // and steep, ~74° above horizontal, which is what kills the long raking
  // shadow the old dawn rim implied.
  rimLightDir: [0.28, 0.96],

  // Midday sun through clean coastal air. The brightest 12% of the painting
  // averages (245, 241, 225) — but that is already sun PLUS blue sky fill, so
  // backing out roughly 0.18 of the zenith blue and renormalising to full value
  // gives (255, 238, 205). Warm, but only just: at noon the key is nearly
  // white, and a saturated amber rim here would read as a different time of day
  // than the sky behind it.
  rimColor: 0xffeecd,

  // CONVENTION, not configuration: public/audio/music/stage-1.{webm,ogg,m4a,mp3}.
  // The loader tries those in order; nothing here changes when a file appears.
  // loopStart/loopEnd are deliberately absent — we cannot know the loop points
  // of a file we have not heard, and undefined means "loop the whole buffer",
  // which is correct for every track until someone measures a better answer.
  musicId: 'stage-1',

  // public/audio/ambience/stage-1.*. Missing file = silence + one warning.
  ambienceId: 'stage-1',

  // Sea haze and fine sand blowing across the plaza, just behind the play
  // plane. The confetti that used to be here belonged to a carnival entrada
  // that is not in this painting; nothing in the frame motivates it, so it is
  // gone rather than left to contradict the art.
  particles: [{ kind: 'dust', count: 30, parallax: 0.95 }],
};

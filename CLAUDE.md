# SunForce

A 2D fighting game built around **Bolivian carnival dances** (Oruro / Altiplano).

## What it is

Spiritual reference: **Guilty Gear XX / Accent Core** — rich, hand-drawn-looking 2D art,
expressive animation, dramatic impact.

**Explicitly NOT:**
- not 2.5D and not 3D-rendered-to-look-2D (i.e. *not* the Guilty Gear Xrd approach)
- not 8-bit / pixel art — textures are meant to be **rich and detailed**

## Stack

TypeScript + WebGL2, Vite, browser. No game framework.

```
npm run dev        # vite dev server on :5173
npm run sheets     # rebuild sprite atlases from assets/movements/ (needs ImageMagick)
npm run verify     # typecheck + headless game-rule tests  <- run this before claiming done
npm run check      # headless rule tests only (scripts/check-rules.ts)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

`npm run check` runs the sim headlessly in node — no browser, no WebGL — because
`step(state, in0, in1)` is pure over a flat Int32Array. It asserts the game rules directly:
punch = 50, kick = 100, hitstop 9/14, ten kicks KO, first hit never prorated, determinism
over 200 frames, pushbox separation and wall clamping.

## Controls

| | Player 1 (left hand) | Player 2 (right hand) |
|---|---|---|
| Move | `W` `A` `S` `D` | Arrow keys |
| Punch (50) | `R` | `I` |
| Kick (100) | `T` | `O` |
| Guard | `G` | `P` |
| Taunt | `Q` | `L` |

**No numpad anywhere** — the bindings must work on a laptop / tenkeyless keyboard. Each
player's attacks sit under the hand already resting on their movement keys.

`F1` toggles the hit / hurt / push box overlay.

## Rules (fixed — do not "improve" these)

- 6 characters: `A B C D E F`
- Every character has **1000 HP**
- A connected **punch = 50** damage
- A connected **kick = 100** damage
- Flow: pick 2 characters → load a stage → fight. **No story mode.**
- Characters are **stick figures for now** — placeholders, deliberately

## Naming — sequential IDs, real names for display

**Identifiers stay sequential.** `CharId` is `A`..`F`, stages are `STAGE_1`..`STAGE_6`, music
is `stage-1.mp3`. Those are the stable keys: enums, filenames, `roster.json`, sheet names.
Never rename them — a character's display name changing must never move a file.

**Display names are real.** `CharDef.name` is what the UI shows:

| Slot | Name | Costume | Troupe |
|------|------|---------|--------|
| A | Caporal | male-caporal | Caporal |
| B | Machona | female-caporal | Caporal |
| C | Macho Tinku | male-tinku | Tinku |
| D | Tinku Supay | female-tinku | Tinku |
| E | Diablo | male-diablada | Diablada |
| F | Virtud | female-diablada | Diablada |

`CharDef.dance` is the troupe the character belongs to, which two characters can share.

**Stages stay sequential in the UI too** — "Stage 1", not a place name.

**Fight music is the one exception, and it is not a stage id.** The track is
chosen by the troupe, not the backdrop, so it is named for the troupe:
`stage-caporal`, `stage-tinku`, `stage-diablada`. No `StageId` maps to these and
no stage declares them — see `src/data/troupes.ts`. `StageDef.musicId`
(`stage-1`) is still sequential and is still the fallback.

## Uniform look — placeholders stay uniform

Two standing rules, both deliberate:

- **All six characters look alike.** Same stick skin, same proportions, same accessory
  proxies. They differ in *frame data* — reach, startup, recovery, walk speed, weight — not
  in appearance. Players are told apart by the P1/P2 colourway (`SkinDrawOpts.costume`),
  not by per-character silhouettes.
- **All six stages look alike.** One stage renderer, one parallax layer model, one lighting
  treatment. Stages differ by palette and time of day only, so they read as six places in
  one world.

Differentiate by *play*, not by *looks*, until the real art lands.

## Art direction reference

`assets/` holds reference photos of the Oruro / Arica carnival troupes; `concept/` holds the
early hand-authored vector sheets. The three troupes in the game are **Caporal**, **Tinku**
(a real ritual combat dance from Potosí — the reason it is the brawler) and **Diablada**.

Archetype intent, which the CPU strategies in `src/input/cpu.ts` express: A all-rounder,
B heavyweight, C rushdown, D aerial, E trickster, F charge.

**F is the one exception to identical physics.** Virtud is drawn with wings, so her
jump matches the silhouette: 412 units against the roster's 278, 58 airborne frames
against 45. Horizontal speed is unchanged — the extra distance is all air time. She
still has one jump and no flight; only `jumpVelY` and `gravity` differ. Note that D
remains the *aerial archetype* (the one whose CPU jumps constantly); F simply owns the
biggest leap.

## The one architectural rule that matters

The character renderer is **part/bone based**. Stick figures and the real vector costume art
are two *skins* implementing **one interface**. The body-part groups in `concept/*.svg` must be
bindable to bones later **without an engine rewrite**. Never hardcode stick-figure drawing into
the simulation or the renderer's core.

## Audio

Music is supplied by the user as files dropped into `public/audio/music/`, and
loading it is CONVENTION, not configuration: `<musicId>.<ext>`, with the loader
trying webm, ogg, m4a, mp3 in that order. A missing file is silence plus one
console warning — never a crash. Replacing a track is a file swap and nothing
else, which is why `select.mp3` can be changed without touching code.

**Fight music follows the troupe of the character on the RIGHT** — player two.
Six characters, three troupes, three tracks. `src/data/troupes.ts` is the whole
mapping, and it carries the backdrop too (see below).

**Each track says when "GO" lands on it.** `TroupeTheme.goAtMs` is measured from
the first frame of the intro, which is also when the track starts, so `6000`
means the word GO appears six seconds into the music. `ui/intro.ts` spends the
difference as a HOLD between the fade and the "3" — it never rushes the count or
shortens the fade, so a track can be given a later downbeat but never an earlier
one than `INTRO_MIN_GO_AT_MS` (3000 ms). The fight scene waits on the frame 0
for the track to actually start before counting, so the countdown and the
recording agree about where zero is.

## Stage dressing — the troupe brings its own

A `TroupeTheme` carries the music id, the GO time and optionally a **backdrop**.
The fight scene hands the dressed StageDef to `Renderer.setStageDressing`, which
is **presentation only**: only the panorama layer's texture is replaced, so the
width, wallPad, ceiling and startX the sim reads are the stage's own and can
never move. The sim is not told and no hash shifts.

Backdrops live in `assets/backgrounds/` and are staged by `npm run sheets`. All
of them must be **3:1** (2172x724 today) — the stage geometry assumes it.
`npm run check` asserts every declared backdrop is actually built, because a
missing one is a black screen with a countdown over it and nothing else warns.

## Art folders — what goes where

```
assets/movements/     fight frames   <costume>-<clip>[-<n>].png
assets/portraits/     select screen  <costume>-selector.png, <costume>-selected.png
assets/backgrounds/   stages         stage-<n>.png
```

`npm run sheets` reads all three and writes `public/art/`. Everything under `public/art/`
is **generated** — never edit it, and never hand-add a file there.

Portraits are staged separately and deliberately kept OUT of the sprite atlas: they are UI
art the fight never draws, and folding them in would add megabytes to a texture loaded every
match. A portrait left in `assets/movements/` still ships, but the builder says so.

The build reports, every run: skipped malformed filenames, costumes no roster slot wears,
costumes with portraits but no fight frames, and a per-costume coverage table of which
clips have real drawings versus which are substituted. Read it — that report is the list of
art still to draw.

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

**Guard already has a key** — `G` for P1, `P` for P2 — and holding BACK also
guards (`sim/hits.ts` derives `blockHeld` from either). Blocking is fully
implemented; it is simply not advertised anywhere on the fight screen.

`F1` toggles the hit / hurt / push box overlay.

## Rules (fixed — do not "improve" these)

- 6 characters: `A B C D E F`
- Every character has **1000 HP**
- A connected **punch = 50** damage — the BASE, before the attacker's rating
- A connected **kick = 100** damage — likewise

Damage is authored 50 / 100 and stays that way: `HitProps.damage` is still the
literal union `50 | 100` and the helpers in `chars/common.ts` still re-pin it
after any override. A character's `punch` / `kick` rating is a **bonus on top of
that base**, folded in once by `data/compile.ts` — Tinku Supay's 90 punch is
`50 * 0.90 = 45`. A 100-rated fighter deals exactly 50 and 100, which is what
`npm run check` measures the rule with.
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

## Traits — one rating per axis, 100 = baseline, 80..120 = the band

`CharDef.traits` carries six ratings and `data/compile.ts` folds them into the
compiled numbers **once, at build time**. The sim never sees a trait, and a
roster rated all-100 compiles to exactly the authored numbers.

| | movement | jump | punch | kick | weight | stamina |
|---|---|---|---|---|---|---|
| A Caporal | 100 | 100 | **110** | 100 | 100 | **105** |
| B Machona | 100 | 100 | 100 | **110** | 100 | **105** |
| C Macho Tinku | **110** | **95** | **95** | **90** | **90** | **105** |
| D Tinku Supay | **110** | **95** | **90** | **95** | **90** | **105** |
| E Diablo | **90** | **90** | **110** | **110** | **120** | **90** |
| F Virtud | 100 | **114** | 100 | 100 | 100 | 100 |

- **movement** scales walk, dash and the horizontal speed carried into a jump.
- **jump** scales LAUNCH VELOCITY, so apex goes with its square and air time
  linearly. Floatiness is `PhysicsDef.gravity`, authored per character and
  deliberately separate — Virtud is the only one who uses both knobs.
- **weight** is mass: knockback received scales as `100/weight`, so 120 slides
  0.83x and 90 slides 1.11x. It is also what a clash divides by.
- **stamina** is the CEILING of the aura pool, and nothing else. It does not
  shorten moves — aura owns the cadence of hits, and one rating must not pay
  twice.

Ratings are percentages on plain integers, so they **round** rather than
truncate — `50 * 95%` is 48, not 47. The `|0` rule exists to keep mirrored
POSITIONS symmetric and no rating is a position.

## Aura — the live half of stamina

**Stamina** is the base condition: a rating, static, the ceiling. **Aura** is
what a fighter is holding right now. Everyone starts a round at full aura equal
to their stamina, and spends it acting — aura is what decides whether the next
hit comes out or you have to wait a moment.

| action | cost |
|---|---|
| punch | 3 |
| kick | 5 |
| blocking a hit | 1 |
| dash | 10 |

Blocking is deliberately the cheapest: the patient option should not exhaust you
faster than swinging does.

**Aura is stored in TICKS, not points** — `AURA_SCALE = 6000` of them per point.
Recovery is `stamina / 100` points per second, which per frame is `stamina/6000`
— not an integer, and it would drift if rounded every tick. Counting in
1/6000ths makes regen exactly `stamina` ticks per frame: integer, exact,
identical everywhere. Caporal's 105 gives 1.05 points a second, so a dash's 10
points return in `(100/105) × 10 = 9.5s`.

A refused attack does **not** consume the press, so it still fires within its
normal buffer window once the pool can pay. It is a buffer, not a promise: past
`INPUT_LENIENCY` the press expires like any other.

## The dash (the "slide")

Double-tap forward or back. Gated twice, and both gates are the point:

- `movement >= 100` — a slow character never gets the option. **Diablo cannot
  dash at all.**
- `aura > 90`, strictly — and it costs 10, so Caporal's 105 affords two
  (105 → 95 → 85) before the third is refused.

It is **cancellable into an attack**, which is the reason to spend aura closing
distance: a dash is a way to get a hit out, not a way to jog.

The HUD shows aura as a slim gold bar under the health, with a notch at the dash
threshold — so the gate is something you can see rather than discover by
pressing.

## The KO

The losing fighter is **thrown backwards and up** as it dies, lands in the KO
pose, and the whole sequence plays at `KO_TIMESCALE_PCT` (30%) for
`KO_SLOWMO_FRAMES` (60 sim frames, so about 3.3 seconds of wall clock).

The slow motion is **presentation, not simulation**: `setTimeScalePct` scales
the loop's accumulator, so the sim runs its normal frames in its normal order
and stays bit-identical. Everything a test measures about a KO is in sim frames.

The launch is scaled by the victim's own weight exactly as knockback is — a
Tinku reaches a 135-unit apex over 31 frames, Diablo only 77 over 23. The
killing blow **cancels the remaining hitstun** rather than waiting it out: a
corpse does not finish its flinch, and the whole arc has to land inside
`KO_SLOWMO_FRAMES` or the round ends mid-flight.

Art is `<costume>-ko.png`, built into a held (never looped) `KO` clip. A costume
without one falls back to its heaviest hit reaction.

## The clash

Two strikes landing on the **same frame** cancel: neither fighter takes damage
or stun, both are interrupted out of their attack, and both are shoved apart by
`CLASH_PUSH` scaled by their own weight — so the lighter one goes further. A
blocked strike is not a clash; guarding is a decision with its own outcome.

Direction is each fighter's own facing, reversed. Comparing the two positions
would be a slot-order tiebreak in disguise and would break at exactly equal x.

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

**Every painting puts its ground somewhere different.** STAGE_1's layer is placed
for the Caporal pier deck, 0.73 of the way down that image; a painting with a
deeper foreground leaves the fighters hanging above it. `TroupeTheme.backdropShiftY`
raises the panorama by that difference, in world units — the panorama is 1400 units
over 724 source pixels, so a fraction `f` of the image is `f * 1400`. The camera
needs 900 units of art above the ground line and 170 below, which bounds the shift
to about -125..+210 and is asserted in `npm run check`.

To measure a new one: draw a line at 0.73 of the image height, see where it falls
against the floor a fighter should stand on, and convert the gap.

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

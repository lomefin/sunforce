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

## Naming — sequential, always

Identifiers are **sequential and neutral**. Do not invent proper names for things.

- characters: `A B C D E F` (`CharId.A` … `CharId.F`)
- stages: `stage-1` … `stage-6` (`StageId.STAGE_1` … `StageId.STAGE_6`)
- stage music: `public/audio/music/stage-1.webm` … `stage-6.webm`

The dance references below are **art direction only** — they inform how a character moves and
what its costume will eventually look like. They are not identifiers and must not appear as
names in the UI, in enums, in filenames, or in stage titles.

## Sprite pipeline

SunForce renders like Guilty Gear XX: **one image per animation frame, blitted as a single
quad. No bones at runtime.**

Drop PNGs into `assets/movements/` and run `npm run sheets`. Naming IS the interface:

```
<costume>-<clip>.png          male-caporal-neutral.png
<costume>-<clip>-<n>.png      female-caporal-walk-2.png
```

Recognised clips: `neutral`, `punch`, `kick`, `walk-1..n`, `jump-1..n`. The builder packs an
atlas per costume into `public/art/<costume>.png` and writes one `SpriteSheet` JSON per roster
slot. `tools/build-sheets.py` maps slots to costumes (`ROSTER`).

### The two alignment rules — the only hard part
- **Grounded frames anchor on the sole**, so feet sit exactly on the world ground line.
- **Airborne frames anchor on the head**, offset down by that costume's standing height,
  because tucked feet have no ground contact to measure. This puts `origin.y` *below* the
  bitmap, which is correct — never clamp it into the frame, or every jump drops to the floor.

Each costume's `unitsPerPx` is derived from its own neutral height so every character is
exactly 378 world units tall regardless of how its art was drawn.

A missing or broken sheet falls back to the procedural stick skin, so the game always runs.

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

## Art direction reference (not identifiers)

`assets/` holds reference photos of six dance troupes; `concept/` holds hand-authored vector
character sheets (640×960) already split into named body-part groups — `legs`, `torso`,
`arms`, `head`, `headwear`, `puffs`, `bells`, `footwear`.

| Slot | Reference dance | Read of the dance | Archetype |
|------|-----------------|-------------------|-----------|
| A | Caporal | commanding high-step, heavy boots, bells | rushdown, strong kicks |
| B | Morenada | slow heavy stomp, huge ornate shell | heavyweight / armour |
| C | Tinku | *an actual ritual combat dance* | brawler, fast punches |
| D | Tobas | enormous leaps, long limbs | aerial / mobility |
| E | Waka Waka | wide spinning skirt, sweeping motion | trickster, 50/50 |
| F | Waka Waka Toro | bull frame at the waist, charging | charge / rush |

## The one architectural rule that matters

The character renderer is **part/bone based**. Stick figures and the real vector costume art
are two *skins* implementing **one interface**. The body-part groups in `concept/*.svg` must be
bindable to bones later **without an engine rewrite**. Never hardcode stick-figure drawing into
the simulation or the renderer's core.

## Audio

Stage music is supplied by the user later as audio files dropped into `public/audio/`.
Keep the music bus loading data-driven and tolerant of missing files.

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

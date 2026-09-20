# SunForce — CHARACTER SPEC (technical)

**Scope: the engineering contract for one character.** What the engine *requires*, what it
*derives*, and what *breaks* when a rule is violated. Nothing here is art direction — no opinion
about how a character should look, move or read. Art direction lives in `CLAUDE.md`; feel numbers
live in `docs/FEEL-NUMBERS.md`.

Every number below was read out of the source at the file and symbol quoted next to it. Anything
that is measured rather than written down says how it was measured. Anything not built says so.

---

## 0. The three constants a character cannot negotiate

| Constant | Value | Enforced by |
|---|---|---|
| HP | `1000` | `CharDef.hp: 1000` — a *literal type* in `src/core/contracts.ts`. Any other number fails `tsc`. |
| Punch / kick damage | `50` / `100` | `HitProps.damage: 50 \| 100` — literal union, same file. `scripts/check-rules.ts` re-asserts it against the live sim (`punch leaves HP: 950`, `kick leaves HP: 900`). |
| On-screen height | `378` world units | `FIGHTER_HEIGHT = 378` (contracts.ts §16). Reached two different ways — see §3. |

Also fixed: `ConceptSpace.w: 640` and `ConceptSpace.h: 960` are literal types. **There is no other
authoring canvas size.**

---

## 1. THE STANCE LIST

`AnimId` (`src/core/contracts.ts` §2) is the complete list of clips the engine can ask for. There
are two ways a clip gets chosen, in `FightRenderer.drawOne` (`src/gfx/renderer.ts`):

```ts
const anim      = move !== null ? move.anim      : animOfState(f);
const animFrame = move !== null ? f.actionFrame  : f.stateFrame;
```

So: **if a move is running, the move's `anim` field wins and the index is `actionFrame`.
Otherwise the fighter's `S.*` state picks the clip through `STATE_ANIM` and the index is
`stateFrame`.** A sprite skin blits `(anim, frame)`; the stick skin ignores both.

### 1a. Index ranges — measured, not assumed

The "sim frames" column is the range of `frame` values the renderer actually hands the skin. It was
measured by driving the real sim headlessly and calling the renderer's own `animOfState` plus the
same `move.anim / actionFrame` expression (probe script; `npm run check` pins the same numbers for
the two hit reactions). Two things fall out that are easy to get wrong:

* **Move clips start at index 0.** `advanceAction` in `src/sim/fighter.ts` does
  `if (f.stateFrame > 0) f.actionFrame++`, so action frame 0 is displayed.
* **Locomotion clips start at index 1.** `setState` zeroes `stateFrame`, `advanceAction`
  increments it at the end of the same step, and `core/loop.ts` steps before it draws — so for
  `IDLE`, `WALK_*`, `JUMP_*` and `LAND` **image 0 is never on screen**. Author them as if index 1
  is the first frame, or give the first image `dur: 2`.
* **Stun clips start at index 0.** `hits.commit` assigns `def.stateFrame = 0` *after* the
  per-fighter advance in the frame order, so `HIT_*` and `BLOCK_*` do show their image 0. (Both
  measured; that asymmetry is real, not a rounding artefact.)

### 1b. State-driven clips (`STATE_ANIM`, `src/gfx/renderer.ts`)

| Clip | Sim state | Sim frames handed to the skin | Status |
|---|---|---|---|
| `IDLE` | `S.STAND` | `1 … ∞` — **must loop** (`loopAt >= 0`) | **REQUIRED.** It is also the fallback for every other clip. |
| `WALK_F` | `S.WALK_F` | `1 … ∞` — **must loop** | required in practice |
| `WALK_B` | `S.WALK_B` | `1 … ∞` — **must loop** | required in practice |
| `JUMP_SQUAT` | `S.JUMP_SQUAT` | `1 … 4` for A (`PhysicsDef.jumpSquat = 4`) | required |
| `JUMP_RISE` | `S.JUMP_RISE` | `1 … 23` (measured, character A) | required |
| `JUMP_FALL` | `S.JUMP_FALL` | `1 … 23` (measured, character A) | required |
| `LAND` | `S.LANDING` | `1 … 2` (measured; `landingLag = 3`, one frame is spent in `JUMP_FALL` with `FF.JUST_LANDED`) | required |
| `HIT_STAND` | `S.HITSTUN_STAND` with `hitstun + stateFrame < 19` | `0 … 16` — **17 frames** | required |
| `HIT_STAND_HARD` | `S.HITSTUN_STAND` with `hitstun + stateFrame >= 19` | `0 … 21` — **22 frames** | required |
| `HIT_AIR` | `S.HITSTUN_AIR` (any hit on an airborne defender) | `0 … 16` punch / `0 … 21` kick | required |
| `BLOCK_STAND` | `S.BLOCKSTUN_STAND` | `0 … 11` punch, `0 … 14` kick (both measured) | required |
| `BLOCK_AIR` | `S.BLOCKSTUN_AIR` | `0 … 14` kick (measured; hold back in the air) | required |
| `KO` | `S.KO` | `1 … ∞` | **NOT REACHED BY A REAL KILL** — see below |
| `CROUCH` | `S.CROUCH` | — | **NOT DRIVEN** — see §7 |
| `DASH_F` / `DASH_B` | `S.DASH_F` / `S.DASH_B` | — | **NOT DRIVEN** |
| `HIT_CROUCH` | `S.HITSTUN_CROUCH` | — | **NOT DRIVEN** |
| `BLOCK_CROUCH` | `S.BLOCKSTUN_CROUCH` | — | **NOT DRIVEN** |
| `KNOCKDOWN` / `WAKEUP` | `S.KNOCKDOWN` / `S.WAKEUP` | — | **NOT DRIVEN** |
| `WIN` / `INTRO` | `S.WIN_POSE` / `S.INTRO` | — | **NOT DRIVEN** |

**`KO` is dead code today — do not draw it.** `resolveTransitions` (`src/sim/fighter.ts`) enters
`S.KO` only when `f.hp <= 0 && f.hitstun === 0`, and its very first line is
`if (s.g.roundState !== RoundState.FIGHT) return;`. The killing hit sets `hitstun` *and*
`s.g.roundState = RoundState.KO` on the same frame (`src/sim/hits.ts`), so the gate closes before
the defender's hitstun ever expires. Measured over 400 frames of a real kill: the loser stays in
`S.HITSTUN_STAND` / `HIT_STAND_HARD` through `RoundState.KO` and `ROUND_END`; `S.KO` is never
entered. (It *is* entered if you set `hp = 0` with no hit at all — that is the only path.)

A side effect worth knowing: because `resolveTransitions` returns early once the round leaves
`FIGHT`, the loser's state freezes but `stateFrame` keeps incrementing (measured to 96+). A
one-shot reaction clip therefore holds its last drawing for the whole KO hold. That is currently
what a KO looks like.

The 19-frame threshold is `HARD_HITSTUN_FRAMES` in `src/gfx/renderer.ts`. It splits the two
standing reactions **without the sim storing any hit severity**: on contact `hits.ts` sets
`hitstun` and zeroes `stateFrame`, and the two then tick together, so `hitstun + stateFrame` is
constant for the whole reaction. `STUN_CARRY = 1` (`src/sim/hits.ts`) means the *stored* counter is
one higher than the printed frame data: **punch 16 → 17, kick 21 → 22**. `npm run check` asserts
exactly this (`punch reaction: recovers its hitstun: 17`, `kick …: 22`, `19 separates light from
heavy`).

### 1c. Move-driven clips (`MoveDef.anim`)

The index is `actionFrame`, so the clip must cover `MoveDef.totalFrames` sim frames starting at 0.

| Clip | Move | Total frames | Active | Status |
|---|---|---|---|---|
| `ATK_5P` | `A_5P` (`src/data/chars/a.ts`) | **17** | 5–7 | **REQUIRED** — the move exists |
| `ATK_5K` | `A_5K` | **29** | 9–12 | **REQUIRED** |
| `ATK_2P` | `A_2P` | 15 / active 4–6 (`docs/FEEL-NUMBERS.md`) | — | **MOVE NOT BUILT** |
| `ATK_2K` | `A_2K` | 23 / active 7–9 | — | **MOVE NOT BUILT** |
| `ATK_JP` | `A_JP` | 14 / active 4–8 | — | **MOVE NOT BUILT** |
| `ATK_JK` | `A_JK` | 22 / active 7–12 | — | **MOVE NOT BUILT** |
| `ATK_THROW` | `A_THROW` | 22 / active 3–5 | — | **MOVE NOT BUILT** (literal kept in `docs/MOVE-FORMAT.md`) |
| `THROW_HELD` | — | — | — | **NO SIM STATE AT ALL** (`S.THROW_HOLD` is never entered) |

The 2P/2K/j.P/j.K/throw totals come from `docs/FEEL-NUMBERS.md`'s frame-data table, **not** from
code — `src/data/chars/*.ts` defines only `5P` and `5K` today. Treat them as targets, not as
contract, until the `MoveDef` exists.

### 1d. What happens when a clip is missing

`src/gfx/skin/sheet.ts`, `SpriteSheetAsset`'s constructor. Nothing throws, nothing goes invisible:

1. A lookup table is built for every `AnimId` from `NONE` to `ANIM_COUNT`.
2. Any id with no clip of that name gets `built.get("IDLE") ?? all[0] ?? null` — **the IDLE clip, or
   failing that whatever clip happens to be first.**
3. One dev-only warning lists every one of them:
   `[sunforce] gfx/skin/sheet: <url> has no clip for CROUCH, DASH_F, … — drawing IDLE`
   (`devWarn` in `src/core/assert.ts`; compiled out of production builds).
4. An out-of-range `frame` never throws: `clipFrameAt` clamps negatives to image 0, wraps a looping
   clip into its loop region, and **holds the last image** for a one-shot. So a move whose art is
   shorter than its frame data still renders — it just freezes on the last drawing.

A sheet that is missing, 404s, is unparseable, has no `image` / bad `atlasW`/`atlasH` /
non-positive `unitsPerPx` / no usable clips, or whose PNG will not decode, resolves to `null` with
one `console.warn` line and **the whole character falls back to the procedural stick skin**
(`loadSpriteSkin` → `null`, caller keeps the stick skin). A single malformed frame rect is dropped
on its own; a clip left with zero frames is dropped; only when *every* clip drops does the sheet
fail.

---

## 2. SPRITE FILE RULES

Source art lives in `assets/movements/`. `npm run sheets` (`tools/build-sheets.py`) packs it.

### Naming is the entire interface

```
<costume>-<clip>.png          male-caporal-neutral.png
<costume>-<clip>-<n>.png      female-caporal-walk-2.png
```

Two regexes, both in `tools/build-sheets.py`:

| Regex | Purpose |
|---|---|
| `^([a-z]+-[a-z]+)-(.+)$` | splits **costume** (exactly two lowercase words) from **clip** |
| `^[a-z]+(?:-[a-z]+)*(?:-\d+)?$` (`CLIP_RE`) | the clip part: lowercase words, optional `-<digits>` suffix |

**Rejects are reported, never silently shipped.** Verified against the current
`assets/movements/` contents:

```
  ! skip (malformed clip name "hard-hit02", expected <clip> or <clip>-<n>): male-caporal-hard-hit02.png
  ! 1 file(s) skipped — fix the name or they will never ship
```

Anything that fails the costume regex prints `! skip (unrecognised name): <file>`. A costume with
no `neutral` frame prints `<costume>: no neutral frame, skipping` and produces no sheet; each
roster slot pointing at it then prints `! slot <x>: no sheet for <costume>`.

### Recognised clip stems

`neutral` (mandatory), `punch`, `kick`, `walk[-n]`, `jump[-n]`, `soft-hit[-n]`, `hard-hit[-n]`.
The `series()` helper matches the stem **exactly**, so `hit` never swallows `soft-hit` and
`jump-squat` would not land inside the jump arc. Any other stem is packed into the atlas but no
clip references it.

### Transparency

* Source PNGs must have a real alpha channel. The builder measures each frame's tight alpha
  bounding box with `-threshold 12%`.
* `ALPHA_FLOOR = '12%'` is also applied as `-channel A -level 12%,100%`: **everything under 12%
  alpha is crushed to fully transparent.** Soft glows and feathered edges below that threshold
  disappear — that is deliberate, it is what makes the sole/head measurement stable.
* The atlas is uploaded **straight-alpha**, `UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0`, drawn with
  `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (`sheet.ts` header). Premultiplying the source breaks the hit
  flash (`mix(rgb, white, flash)`) and paints a white box over the transparent margin.
* Filtering is `LINEAR` with **no mipmaps**, so frames need ≥1 px gutter (`PAD = 4`) and colour
  bled into transparent texels.

### Facing

**Draw every frame facing RIGHT.** Facing is a negated quad column, not a second atlas:
`src/gfx/skin/sprite.ts` negates the width about the pivot for `facing < 0` and deliberately does
**not** swap `u0`/`u1` as well — doing both cancels out and yields an unflipped sprite in a shifted
box.

### Canvas size

**Source canvas size is free.** Nothing reads it. Each frame is cropped to its own alpha box,
scaled by `SCALE = 0.45`, and the per-costume `unitsPerPx` is derived so that the result is 378
world units tall regardless (§3). Three costumes currently ship at three different resolutions:

| Costume | Atlas | Neutral height (atlas px) | `unitsPerPx` | On-screen height |
|---|---|---|---|---|
| `male-caporal` | 1652×2485 | 606 | 0.623608018 | 377.91 u |
| `female-caporal` | 1648×3214 | 629 | 0.600858369 | 377.94 u |
| `female-tinku` | 1764×2033 | 675 | 0.560000000 | 378.00 u |

(The ≤0.1 u error is the integer rounding of the resized bitmap, not a bug.)

### Slot → costume mapping

`ROSTER` in `tools/build-sheets.py` maps engine slots to costumes; several slots may share one
costume and one atlas. Current value:

```python
ROSTER = {'a':'male-caporal',  'b':'female-caporal', 'c':'female-tinku',
          'd':'male-caporal',  'e':'female-caporal', 'f':'female-tinku'}
```

Outputs: `public/art/<costume>.png` (one atlas per costume) and `public/art/<slot>.sheet.json`
(one `SpriteSheet` JSON per roster slot). Both are written atomically (temp file + `os.replace`)
because the dev server serves `public/art/` live. The runtime finds the JSON by convention:
`sheetUrlFor(char)` → `art/<charid lowercased>.sheet.json`.

---

## 3. ALIGNMENT — the part that actually breaks

`SpriteFrame.origin` is `[x from the LEFT, y from the TOP]` in **frame-local pixels**, and it maps
onto the fighter's world origin: **feet centre, on the ground line (world y = 0).** It is per
frame, because a crouch and a jump do not share one.

`origin.x` is always the head centroid's x, measured from the frame's left edge
(`head_cx` in `build-sheets.py::measure`, taken from the top 8% band of the alpha box).

`origin.y` has **two rules, and they differ because a tucked foot has nothing to measure against:**

| Frame kind | Rule | Code |
|---|---|---|
| **Grounded** (everything except `jump*`) | anchor on the **SOLE** — the lowest opaque pixel sits exactly on the world ground line | `oy_abs = i['sole']` |
| **Airborne** (clip stem starts with `jump`) | anchor on the **HEAD**, offset down by *this costume's* standing height | `oy_abs = i['head_top'] + base_h` |

Consequences, both verified in the shipped sheets:

* For a grounded frame, `origin.y` equals the frame's own height exactly. (`male-caporal` IDLE:
  `uv` height 606, `origin` `[188, 606]`.)
* For an airborne frame, `origin.y` is **always the costume's neutral height in atlas pixels**,
  whatever that frame's own height is — 606 for `male-caporal`, 629 for `female-caporal`, 675 for
  `female-tinku`.

### `origin.y` MAY EXCEED THE FRAME HEIGHT. NEVER CLAMP IT.

When the feet tuck up, world (0,0) falls **below** the bitmap, so `origin[1] > uv[3]`. This is
correct and unavoidable. `contracts.ts` `SpriteFrame.origin` says so in the type's own doc comment,
and `sheet.ts`'s validator deliberately does not range-check it (it checks only the `uv` rect).
Clamping it into the rect silently drops every jump back onto the floor.

Real overflow in the shipped sheets:

| Slot | Clip | Frame height | `origin.y` | Origin sits below the bitmap by |
|---|---|---|---|---|
| a / d (`male-caporal`) | `JUMP_RISE[1]` | 583 | 606 | 23 px = **14.3 world units** |
| a / d | `JUMP_FALL[0]` | 589 | 606 | 17 px = 10.6 u |
| b / e (`female-caporal`) | `JUMP_RISE[1]` | 570 | 629 | 59 px = **35.5 world units** |
| c / f (`female-tinku`) | `JUMP_FALL[0]` | 657 | 675 | 18 px = 10.1 u |

The blitter is one line and has no special case (`src/gfx/skin/sprite.ts::emit`):

```ts
const y = wy - (fh - oy) * u;     // oy > fh  =>  y > wy  =>  bitmap floats above the ground line
```

### `unitsPerPx` — how 378 is guaranteed at any drawing resolution

There are **two different `unitsPerPx` in this codebase and they are not the same number:**

| Field | Meaning | Who sets it |
|---|---|---|
| `ConceptSpace.unitsPerPx` | concept-sheet pixels → world units, for **boxes and bones** | authored in `src/data/chars/<x>.ts`; `0.5` for every character today |
| `SpriteSheet.unitsPerPx` | **atlas** pixels → world units, for **the drawing** | derived per costume by `build-sheets.py` |

The sprite one is derived from the costume's own neutral frame:

```python
SCALE, FIGHTER_UNITS = 0.45, 378.0
base_h = meas['neutral']['h']                 # source-pixel height of the neutral alpha box
unitsPerPx = FIGHTER_UNITS / (base_h * SCALE) # atlas px -> world units
```

So `neutral_atlas_height * unitsPerPx == 378` by construction, for any drawing resolution, and
**every character is the same height on screen without the artist tracking a pixel budget.** The
box side reaches the same 378 independently: A's `conceptSpace` is `originX 302, groundY 858,
unitsPerPx 0.5`, and 756 concept px × 0.5 = 378 (`FIGHTER_HEIGHT` in contracts.ts §16).

---

## 4. WHAT THE ENGINE DERIVES vs WHAT MUST BE AUTHORED

| DERIVED — do not hand-author, do not check in | AUTHORED — nothing derives these |
|---|---|
| **Atlas packing** — frame placement, atlas size (`build-sheets.py`, 4 per row, `PAD = 4`) | **The drawings.** One image per pose, `assets/movements/<costume>-<clip>[-n].png` |
| **UV rects** — `SpriteFrame.uv` in atlas pixels; normalised at draw time against the *decoded image's* size, not `atlasW/H` | **Frame data** — `totalFrames`, the sparse `timeline`, which frames carry a hitbox |
| **Per-frame `origin`** — sole or head rule, §3 | **All four box classes** — `standHurt`/`crouchHurt`/`airHurt`, `standPush`/`crouchPush`/`airPush`, per-keyframe `hurt`/`hit`/`throwBox`/`pushbox`, in concept space |
| **`unitsPerPx`** — from the neutral frame (§3) | **Physics** — `PhysicsDef`, 17 fields (§5) |
| **Clip durations for the hit reactions** — `spread(16, n)` / `spread(21, n)` over however many drawings exist | **`restPose`** — 24 bone positions in concept pixels |
| **Walk cadence** — `wdur = max(2, round(30 / len(walk)))`, so any number of walk drawings makes a ~30-frame stride; `WALK_B` is the same drawings reversed at `wdur + 1` | **`stick`** — 24 capsule radii, outline width, palette, accessory proxies |
| **Jump rise/fall split** — first ~60% of the `jump-*` drawings are the rise (`split = round(len(jumps)*0.6)`) | **`jiggle`** — accessory springs |
| **Facing** — one negated quad column (§2) | **`moveOrder`** — the move-matching priority table |
| **Z-order** — whoever is swinging draws in front, tie → `g.lastHitBy` → player index; frozen during hitstop so it cannot pop (`renderer.drawFighters`) | **`poseHint`** per move — the procedural fallback pose |
| **Hit flash** — `min(1, hitstop / 9) * 0.85` while `hitstop > 0` | |
| **Defender vibration** — ±2.4 px alternating by `hitstop & 1`, render only | |
| **Glint phase** — advanced by `abs(velX) * 0.004 + 0.0015`, i.e. by speed, not by time | |
| **Frame advantage** — `advHit` / `advBlock` = `stun - (totalFrames - 1 - activeFirst)`, in `compileMove` | |
| **`startup` / `activeFirst` / `activeLast`** — scanned off the compiled frames (any frame with a hitbox *or* throwbox counts as active) | |
| **Dense per-frame box tables** — `compile.ts` expands the sparse timeline to `frames[0…totalFrames-1]` once at load | |
| **Local bounds** — union of every image placed by its own origin (`SkinSprite` constructor) | |

---

## 5. PER-CHARACTER TECHNICAL KNOBS

### 5a. The CONCEPT SPACE convention (exact)

All authoring geometry — hurt/hit/push boxes, bone rest poses, accessory proxy boxes — is written
in **concept space**, defined in `src/core/contracts.ts` and converted once by
`src/data/compile.ts`:

* A fixed **640 × 960** sheet (`w: 640`, `h: 960` are literal types — no other size compiles).
* **x right, y DOWN**, absolute, origin at the sheet's top-left. A `ConceptBox` is
  `[x0, y0, x1, y1]` with `y0 < y1`, so **`y0` is the TOP edge**.
* Three per-character numbers pin it to the world:

| Field | Meaning | A's value | Where A's value came from |
|---|---|---|---|
| `originX` | concept x of the character's midline | `302` | the crotch vertex of `#legs` in `concept/caporal.svg` |
| `groundY` | concept y of the ground line | `858` | the `#ground-shadow` ellipse `cy` |
| `unitsPerPx` | world units per concept pixel | `0.5` | 756 drawn px × 0.5 = 378 = `FIGHTER_HEIGHT` |

Conversion (`compile.ts`, once at load, never per frame):

```
localX = (cx - cs.originX) * cs.unitsPerPx     // +x is FORWARD (facing-relative)
localY = (cs.groundY - cy) * cs.unitsPerPx     // +y is UP, 0 = ground
FX     = trunc(local * ONE)                    // ONE = 256
```

Each edge converts independently and the extent is the difference of two converted edges, so boxes
authored flush stay flush after truncation. **The y flip inverts the edges**: the concept *bottom*
edge becomes `FxBox.y`. Getting it backwards reads on screen as "the hitboxes look roughly right
but the kick whiffs high".

`compileChar`/`conceptBox` reject, at load, with a named error: `x1 <= x0`, `y1 <= y0`, any edge
outside `0…640` / `0…960`, non-finite numbers, `unitsPerPx <= 0`.

### 5b. `CharDef` — every field a new character must supply

`src/core/contracts.ts` §5. All required unless marked.

| Field | Type / units | Default to copy | Notes |
|---|---|---|---|
| `id` | `CharId` | — | must be unique; `compile` asserts no `CharId` compiled twice |
| `name` | `string` | `'A'`…`'F'` | sequential naming rule — no proper names |
| `dance` | `string` | `'A'`…`'F'` in the shipped files | free-form label, unused by the sim |
| `hp` | literal `1000` | `1000` | not negotiable |
| `conceptSpace` | `ConceptSpace` | `{ w:640, h:960, originX:302, groundY:858, unitsPerPx:0.5 }` | §5a |
| `physics` | `PhysicsDef` | see 5c | |
| `standPush` | `ConceptBox` | `[226, 338, 378, 858]` (76 × 260 concept px) | pushbox while grounded |
| `crouchPush` | `ConceptBox` | `[222, 520, 382, 858]` | **authored but never selected** — no crouch state |
| `airPush` | `ConceptBox` | `[234, 400, 370, 858]` | `check-rules` asserts it differs from `standPush` and is used while airborne |
| `standHurt` | `ConceptBox[]` | 3 boxes: legs `[248,470,358,858]`, torso `[238,272,372,472]`, head `[262,168,348,282]` | one box per body region |
| `crouchHurt` | `ConceptBox[]` | 2 boxes | **never selected today** |
| `airHurt` | `ConceptBox[]` | 3 boxes | selected while `FF.AIRBORNE` |
| `restPose` | `[x, y][]`, concept px | `BASE_REST_POSE` | **length must be exactly `BONE_COUNT` = 24**, asserted in `compileChar`. Order = the `Bone` enum. B/F are assigned for `facing = +1`: the sheet's screen-LEFT limb (x < `originX`) is the **BACK** limb. |
| `moveOrder` | `MoveId[]` | `[X_5K, X_5P]` today; `[X_THROW, X_5K, X_5P]` once a throw exists | **priority** for move matching — heavier button first, so a `P+K` throw macro cannot be eaten by the punch matcher. Every id must be a move this character defines (asserted). Data, never object-key order. |
| `moves` | `MoveDef[]` | `[X_5P, X_5K]` today | ids must be in range and unique across the whole roster |
| `stick` | `StickDef` | `radii` = `BASE_RADII`, `outline: 3` | **`radii` length must be 24**, asserted. Required even for a sprite character — it is the fallback skin and the offline baker's input. |
| `jiggle` | `JiggleDef[]` | `BASE_JIGGLE` (ACC0/1/2) | presentation-only springs |
| `parts?` | `{ manifest: string }` | omit | baked vector skin; nothing consumes it yet |

### 5c. `PhysicsDef` — 17 fields, all world units / frames

Character A's values (`src/data/chars/a.ts`) are identical to `BASE_PHYSICS` in
`src/data/chars/common.ts`, and all six characters ship with them today. Use them as the default.

| Field | Units | A / default | Effect |
|---|---|---|---|
| `walkF` | u/frame | `4.0` | forward walk (= 240 u/s) |
| `walkB` | u/frame | `3.4` | back walk |
| `dashSpeed` | u/frame | `9.0` | **no dash state exists yet** |
| `dashFrames` | frames | `20` | idem |
| `backDashSpeed` | u/frame | `8.0` | idem |
| `backDashFrames` | frames | `22` | idem |
| `runDash` | bool | `true` | true run vs step dash; idem |
| `jumpSquat` | frames | `4` | ground commitment before launch. **In no move's `stateMask`** — deliberately, so a jump is punishable |
| `jumpVelY` | u/frame | `24.2` | launch velocity |
| `jumpVelXF` | u/frame | `5.0` | forward air drift, latched at squat |
| `jumpVelXB` | u/frame | `4.4` | back air drift |
| `gravity` | u/frame² | `1.10` | with `jumpVelY 24.2` → 45 airborne frames, 278 u apex (`check-rules`) |
| `airDrag` | multiplier | `1.0` | 1 = none |
| `groundFriction` | multiplier/frame | `0.84` | not applied in walk states (walk sets velocity every frame) |
| `airJumps` | count | `0` | extra air jumps |
| `weightPct` | percent | `100` | received-knockback scale; 78 = heavy |
| `landingLag` | frames | `3` | overridden per move by `MoveDef.landingRecovery` when an air move is out |

Total jump cycle: `4 squat + 45 airborne + 3 landing = 52` frames — asserted by
`scripts/check-rules.ts` (`jump squat is 4 frames`, `airborne 45 frames`, `total jump cycle 52
frames`, `jump apex ~278u`).

### 5d. `MoveDef` — the timeline contract

| Field | Required | Notes |
|---|---|---|
| `id` | yes | one of the reserved `MoveId` slots (§6) |
| `name` | yes | appears in every compile error |
| `group` | yes | `G.PUNCH` / `G.KICK` / `G.THROW` / … — the currency of cancels |
| `input.button` | yes | `B.P` = 16, `B.K` = 32, `B.THROW` = 512 (synthesised from P+K within `THROW_MACRO_SLOP = 2` frames) |
| `input.command?` / `negEdge?` / `dir?` | no | motion inputs; **no command parser is wired yet** |
| `stateMask` | yes | bitmask of `S.*` this move may START from. Standard ground mask = `STAND`, `WALK_F`, `WALK_B`, `DASH_F`, `ACTION` (`ACTION` is included so the move can come out of a cancel). **Never add `S.JUMP_SQUAT` or `S.LANDING`** — their absence is what makes jumps committal and jump-ins punishable (`common.ts`, "DELIBERATE, LOAD-BEARING OMISSION") |
| `totalFrames` | yes | > 0; the clip index range is `0 … totalFrames-1` |
| `timeline` | yes | sparse `Keyframe[]`; `timeline[0].at` **must be 0**, `at` strictly ascending, last `at < totalFrames`. All three asserted. |
| `cancels` | yes | `{ window: [from, to], on: OnMask, into: GroupMask }` |
| `selfChain` | yes | times the move may chain into itself in one combo; 0 = never |
| `landingRecovery?` | no | frames added when an air move lands; defaults to 0 |
| `armor?` | no | `{ window, hits, damagePct }`; defaults to an empty window `[0, -1]` |
| `anim` | yes | the `AnimId` the sprite skin blits |
| `poseHint` | yes | `{ limb, reach, height, lean, crouch, accSwing }` — drives the procedural fallback pose when no clip exists. Required on every move. |

**Keyframe inheritance, exactly** (`compile.ts`):

* **STICKY** — carried forward until replaced: `hurt`, `hit`, `throwBox`, `pushbox`, `friction`,
  `flags`. A present array **replaces** the previous one; `[]` clears it.
* **IMPULSE** — applied on that frame only, `VEL_KEEP` / `SfxId.NONE` elsewhere: `velX`, `velY`,
  `sfx`. If `velX` were sticky, `{ at: 0, velX: 0 }` would pin the fighter's velocity to zero for
  the whole move and silently overwrite friction, knockback and pushbox separation every frame.

`HitProps` (24 fields) should be copied from `PUNCH_PROPS` / `KICK_PROPS` in
`src/data/chars/common.ts` and differentiated only by box and timing. The one inequality that must
survive: **`blockPushX > kbX` on both buttons** (punch 3.0 > 2.4, kick 5.2 > 4.6). That is the whole
offence/defence loop. `hitstop` is symmetric by contract — attacker and defender freeze for the same
count — and that symmetry is what makes `adv = stun - (total - 1 - activeFirst)` arithmetic rather
than assertion.

> **These two rules are conventions, not enforced.** `contracts.ts` says "the validator rejects
> asymmetric hitstop" and `registry.ts` names `src/data/validate.ts` as the owner of validation,
> but **that file does not exist** and `ValidateFn` has no implementation. The only automatic
> load-time checks are the `assert(...)` calls in `src/data/compile.ts` (listed in §5a and §5b) and
> the 45 rule checks in `scripts/check-rules.ts`. Neither looks at `blockPushX` or hitstop
> symmetry. Check them by hand.

---

## 6. HOW TO ADD A CHARACTER, END TO END

The `MoveId` slots are **already reserved** in `src/core/contracts.ts` — seven per character, in
enum order, so state hashes stay stable:

```
NONE = 0,
A_5P, A_5K, A_2P, A_2K, A_JP, A_JK, A_THROW,   //  1 …  7
B_5P … B_THROW,                                //  8 … 14
C_5P … C_THROW,                                // 15 … 21
D_5P … D_THROW,                                // 22 … 28
E_5P … E_THROW,                                // 29 … 35
F_5P … F_THROW,                                // 36 … 42
MOVE_COUNT,                                    // 43
```

Adding a character never touches this enum. Adding a *move type* does, and that is a contract
change requiring a full `npm run typecheck`.

### Checklist — "I have drawings" → "it fights"

1. **Name the costume.** Exactly two lowercase words, e.g. `male-tobas`. Files go in
   `assets/movements/`.
2. **Drop the PNGs in,** all facing RIGHT, transparent background, any canvas size:
   `male-tobas-neutral.png` (mandatory), `-punch`, `-kick`, `-walk-1…n`, `-jump-1…n`,
   `-soft-hit-1…n`, `-hard-hit-1…n`.
3. **Point a roster slot at it.** `ROSTER` in `tools/build-sheets.py`, e.g. `'d':'male-tobas'`.
4. **`npm run sheets`.** Read the console: every skipped file is a file that will never ship.
   Writes `public/art/male-tobas.png` and `public/art/d.sheet.json`. Requires ImageMagick
   (`magick`) on PATH.
5. **Check the two alignment invariants** on the JSON: grounded frames have
   `origin[1] == uv[3]`; airborne (`JUMP_*`) frames all share one `origin[1]` equal to the neutral
   frame's height. If an airborne `origin[1]` got clamped to the frame height, the jump will sit on
   the floor.
6. **Author the data file** `src/data/chars/<x>.ts`: copy `a.ts`, change `CharId`, the `MoveId.X_*`
   ids, and the numbers. Concept boxes are read straight off the 640×960 concept sheet. Keep
   `restPose` and `stick.radii` at 24 entries.
7. **Register it** — `src/data/registry.ts`: import and add to `CHAR_DEFS`. That is one line; every
   derived list (select-screen order, counts, cursor arithmetic) falls out of that array. All six
   slots are already registered today.
8. **`npm run verify`** — `tsc --noEmit` plus 45 headless rule checks (`scripts/check-rules.ts`,
   verified: 45 `check(...)` calls, `ALL PASS`). Load-time assertions in `compile.ts` fire here too,
   with the character and move name in the message.
9. **`npm run dev`**, `F1` for the hit/hurt/push overlay. The boxes lining up with the limbs is the
   end-to-end proof that concept space → world space is right. A broken sheet just falls back to
   the stick skin, so the game still runs.

---

## 7. WHAT IS NOT YET SUPPORTED

**Do not draw these yet — nothing will ever play them.** The only writers of `f.state` are
`setState` in `src/sim/fighter.ts` and two lines in `src/sim/hits.ts`; every call site was read.
The set actually reachable in play is `STAND, WALK_F, WALK_B, JUMP_SQUAT, JUMP_RISE, JUMP_FALL,
LANDING, ACTION, HITSTUN_STAND, HITSTUN_AIR, BLOCKSTUN_STAND, BLOCKSTUN_AIR` — twelve states, and
`S.KO` only in the artificial case described in §1b.

| Clip | Blocked on | Why it is unreachable |
|---|---|---|
| `CROUCH` | crouch state | `S.CROUCH` is never assigned. `FF.CROUCHING` is *read* (`isCrouching`, `canBlock`, `hitstunState`) but never *written*. |
| `HIT_CROUCH` | crouch | needs `Rx.CROUCH` or `FF.CROUCHING`; no move authors `Rx.CROUCH` |
| `BLOCK_CROUCH` | crouch | needs `FF.CROUCHING` |
| `DASH_F`, `DASH_B` | dash state | `S.DASH_F`/`S.DASH_B` never assigned. `PhysicsDef.dashSpeed/dashFrames/backDash*/runDash` are authored and compiled but unused. |
| `KNOCKDOWN`, `WAKEUP` | knockdown | `S.KNOCKDOWN`/`S.WAKEUP` never assigned; `knockdownTimer`/`wakeupTimer` never driven |
| `ATK_THROW`, `THROW_HELD` | throws | `S.THROW_HOLD`/`S.THROWN` never assigned; no `MoveDef` with `group: G.THROW` exists in `src/data/chars/*.ts` |
| `ATK_2P`, `ATK_2K` | crouch normals | no `MoveDef`; the `MoveId` slots are reserved |
| `ATK_JP`, `ATK_JK` | air normals | no `MoveDef`; `AIR_MASK` exists in `common.ts` but nothing uses it |
| `WIN`, `INTRO` | round flow | `S.WIN_POSE`/`S.INTRO`/`S.ROUND_FREEZE` never assigned |
| `KO` | round flow | `S.KO` is gated behind `roundState === FIGHT`, which the killing hit has already cleared — §1b |

Also not built:

* **There is no validator.** `ValidateFn` and `ValidationIssue` are declared in `contracts.ts`;
  `src/data/registry.ts` says `data/validate.ts` owns validation and runs it "in CI and in the dev
  server". **`src/data/validate.ts` does not exist** and nothing calls a `ValidateFn`. The checks
  that really run are `compile.ts`'s `assert(...)` calls at load and `scripts/check-rules.ts`.
* **No motion-input parser.** `Cmd.QCF/QCB/DP/…` and `MoveDef.input.command` exist in the contract;
  `commandMask` is never populated.
* **Counter-hit is switched off.** `const counter = false` in `src/sim/hits.ts`; the `ctrBonus*`
  fields are authored and compiled but never applied. The 19-frame reaction threshold is already
  correct for when it is turned on.
* **`src/data/chars/common.ts` is imported by nothing.** `grep -rn "chars/common" src/` returns only
  its own header comment. `a.ts`–`f.ts` all author longhand. It is a good reference for defaults; it
  is not, today, a shared dependency.
* **`tools/bake-sprites.mts`** (the offline rig frame generator) has **no npm script**. `npm run
  sheets` runs the Python builder only. Run it manually if you want rig-baked frames.
* **B–F are copies of A.** Verified field by field: identical `conceptSpace`, identical
  `PhysicsDef`, identical boxes, identical `5P`/`5K` timelines — only `CharId`, `name`, `dance` and
  the `MoveId` block differ. Differentiation is supposed to be frame data; it has not been done.
  Retuning one of those files is all it takes, and nothing else in the engine changes.
* **Only `stage-1` exists** (`STAGE_DEFS = [STAGE_1]`) although `StageId` reserves six.

---

## PER-CHARACTER CHECKLIST

Tick every line before calling a character done.

**Art files**
- [ ] Costume name is exactly two lowercase words
- [ ] `<costume>-neutral.png` exists (without it, no sheet is produced at all)
- [ ] Every filename matches `<costume>-<clip>.png` or `<costume>-<clip>-<n>.png`, clip lowercase words only
- [ ] `npm run sheets` reports **zero** skipped files
- [ ] All frames drawn facing RIGHT
- [ ] Real alpha channel; nothing load-bearing below 12% alpha
- [ ] `punch`, `kick`, `walk-1…n`, `jump-1…n`, `soft-hit-1…n`, `hard-hit-1…n` present

**Sheet JSON (`public/art/<slot>.sheet.json`)**
- [ ] `neutral_height * unitsPerPx ≈ 378`
- [ ] Grounded frames: `origin[1] == uv[3]`
- [ ] Airborne (`JUMP_*`) frames: `origin[1]` == the neutral frame's height, **even where that exceeds the frame's own height**
- [ ] `IDLE`, `WALK_F`, `WALK_B` have `loopAt >= 0`; one-shots have `loopAt: -1`
- [ ] `ATK_5P` covers **17** sim frames, `ATK_5K` covers **29**
- [ ] `HIT_STAND` covers **17**, `HIT_STAND_HARD` covers **22** (the builder currently emits 16 / 21 — the last drawing then holds one extra frame, which is acceptable but not intentional)
- [ ] Console shows no `has no clip for …` warning for a clip you meant to ship

**Data file (`src/data/chars/<x>.ts`)**
- [ ] `hp: 1000`
- [ ] Every `damage` is exactly `50` or `100`
- [ ] `blockPushX > kbX` on both buttons *(nothing checks this for you)*
- [ ] `hitstop` is one number applied to both fighters — no per-side offset *(nothing checks this for you)*
- [ ] `restPose.length === 24` and `stick.radii.length === 24`
- [ ] Every `ConceptBox` lies inside 640×960, with `x1 > x0` and `y1 > y0`
- [ ] `timeline[0].at === 0`, `at` strictly ascending, last `at < totalFrames`
- [ ] `stateMask` excludes `S.JUMP_SQUAT` and `S.LANDING`
- [ ] `moveOrder` lists the heavier button first and every id is defined by this character
- [ ] Every move has a `poseHint`
- [ ] `MoveId`s come from this character's reserved block and are used nowhere else

**Wiring**
- [ ] `ROSTER` in `tools/build-sheets.py` points the slot at the costume
- [ ] The `CharDef` is imported into `CHAR_DEFS` in `src/data/registry.ts`
- [ ] `npm run verify` → `ALL PASS` (45 checks) with a clean `tsc`
- [ ] `npm run dev` + `F1`: boxes line up with the limbs; the fighter does not float, sink or vanish on jump

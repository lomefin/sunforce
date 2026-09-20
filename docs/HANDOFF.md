# SunForce — handoff

Everything below was read out of the source, not remembered. Each non-obvious number names the
file it came from so you can re-check it. Verified against the tree as of **2026-09-19**.

**What this is.** A 2D fighting game: TypeScript + WebGL2 + Vite, browser, no game framework.
Six characters `A`–`F`, 1000 HP each, punch 50, kick 100. The simulation is a pure, deterministic,
integer fixed-point function over a flat 576-word `Int32Array` (`STATE_WORDS`,
`src/core/contracts.ts:624`). Presentation reads that buffer and never writes to it. It renders
like Guilty Gear XX: **one image per animation frame, blitted as a single quad, no bones at
runtime**.

**Where it actually stands.** The fight works end to end — two fighters, hand-drawn sprites, one
painted stage, HP bars, hitstop, KO, round reset, music — with **two moves in the game** (5P and
5K) on **six characters that are byte-identical copies of one another**. Everything in §5 marked
NOT BUILT is genuinely absent, not half-done.

---

## 1. Run it

| command | what it runs | what you should see |
|---|---|---|
| `npm run dev` | `vite` — port 5173, opens a browser (`vite.config.ts`) | the fight, below |
| `npm run verify` | `npm run typecheck && npm run check` | `ALL PASS` after 45 `PASS` lines |
| `npm run check` | esbuild-bundles `scripts/check-rules.ts` and runs it in node — no browser, no WebGL | 45 `PASS` lines |
| `npm run typecheck` | `tsc --noEmit` | silence |
| `npm run build` | `tsc --noEmit && vite build` | `dist/` |
| `npm run sheets` | `python3 tools/build-sheets.py` | per-costume atlas report; **needs ImageMagick** |
| `npm run preview` | `vite preview` | the built bundle |

`npm run verify` is the gate. I ran it: 45 tests, all passing. They assert the rules directly
against the real `step()` — 1000 HP, punch 50, kick 100, hitstop 9/14, ten kicks KO, determinism
over 200 frames, the 4-frame jump squat / 45-frame airborne / 52-frame cycle, pushbox separation,
wall clamping, and the hit-reaction clip derivation.

Toolchain actually present on this machine: node v25.9.0, npm 11.12.1, Python 3.14.3,
ImageMagick 7.1.2-27 (`/opt/homebrew/bin/magick`).

**On `npm run dev` you should see:** the boot overlay fades; a seafront panorama
(`public/art/stages/stage-1.png`, 2172×724) behind two hand-drawn sprites; character **A** on the
left, character **B** on the right, spawned at x 1620 and 1980 of a 3600-unit stage
(`SPAWN_LEFT`/`SPAWN_RIGHT`, `src/data/stages/stage-1.ts:223`); two HP bars; and this line in the
console, printed by `src/main.ts:149`:

```
[sunforce] P1: WASD move, R punch, T kick, G guard | P2: arrows, I punch, O kick, P guard | F1: hitboxes
```

Music (`public/audio/music/stage-1.mp3`) starts on your **first keypress**, not on load — browsers
keep the `AudioContext` suspended until a gesture (`src/main.ts:126-137`).

### Controls

Source of truth: `DEFAULT_KEYMAP` in `src/input/keymap.ts:80`. **Ignore every older doc** —
`docs/M0-VERTICAL-SLICE.md` still says `J`/`K` and `Numpad1`/`Numpad2`, which is stale. There is no
numpad binding anywhere; both hands rest on their own movement keys.

| | Player 1 | Player 2 |
|---|---|---|
| Up / Down / Left / Right | `W` `S` `A` `D` | `↑` `↓` `←` `→` |
| Punch (50) | `R` | `I` |
| Kick (100) | `T` | `O` |
| Guard | `G` | `P` |
| Taunt | `Q` | `L` |
| Start | `Enter` | `\` |

- **Directions are absolute** all the way to the sim; the facing-relative conversion happens at
  read time (`src/input/keymap.ts:20-23`, `src/sim/fighter.ts` `forwardBit`/`backBit`).
- **Guard is "hold back, or hold G"** — `src/sim/hits.ts:129` derives `blockHeld` from either.
- **Taunt is bound but dead**: nothing outside `keymap.ts` reads `B.TAUNT`. `B.START` is read only
  by the `preventDefault` rule in `src/input/sources.ts:143`.
- **`B.THROW` is not a key.** It is a macro (P+K within `THROW_MACRO_SLOP = 2` frames) synthesised
  by `synthesizeThrowMacro` in `src/input/buffer.ts:123` — which **currently has no caller**, and
  no character authors a throw, so P+K does nothing today.
- **`F1`** toggles the hurt/hit/push/throw box overlay (`attachDebugHotkeys`,
  `src/gfx/debugdraw.ts:93`). It is the **only** hotkey `main.ts` attaches; `F2`/`F3`/`F5` appear in
  `docs/FILE-TREE.md` but `src/ui/debug.ts` does not exist.
- **`[`** opens the character-select screen — but see the warning in §5 about whether the scene
  stack is reachable from `main.ts` yet.

---

## 2. Architecture in one screen

**The one rule: the simulation is pure and presentation is an observer.** `step(state, in0, in1)`
is total over a flat `Int32Array` — no DOM, no `Date`, no `Math.random`, no float, no allocation.
The renderer, audio and HUD *read* that buffer and the event ring; nothing on the presentation side
ever writes a word of it. This is not style. It is what makes the determinism test, the mirror
test and any future rollback netcode possible at all, and it is cheap to preserve and expensive to
restore.

The layering is real, and I verified it by walking every `@/` import:

```
src/core   ──▶ (nothing, except core/loop.ts ──▶ input/sources.ts)
src/data   ──▶ core
src/sim    ──▶ core          ONLY. Never data, never gfx.
src/gfx    ──▶ core, sim (reads state + drains events)
src/ui, src/game ──▶ core, data, gfx, sim
```

`src/sim/**` imports exactly `@/core/*` and `@/sim/*` — nothing else. It never sees an authoring
type; compiled data reaches it as `SimState.defs`, handed in once by `createState`.

| directory | the one or two files that matter |
|---|---|
| `src/core` | **`contracts.ts`** (below). `fixed.ts` — `fxMul(a,b) = ((a*b)/ONE)\|0`, `ONE = 256`. |
| `src/sim` | **`step.ts`** — the frame order, §3. `fighter.ts` — `resolveTransitions`, the *only* writer of `f.state`. |
| `src/data` | `compile.ts` — concept-space px → world FX, sparse timeline → dense per-frame array, once at load. `chars/a.ts` — the only authored character. |
| `src/gfx` | `renderer.ts` — pass orchestration and the state→`AnimId` table. `skin/sprite.ts` + `skin/sheet.ts` — the entire shipping render path. |
| `src/ui`, `src/game` | `game/match.ts` — match lifecycle. `game/scenes.ts` — Fight/Select scenes. `ui/select.ts` — the select screen model. |
| `tools` | `build-sheets.py` — the sprite pipeline (§4). `bake-sprites.mts` — the *offline* rig baker, see §6. |

### `src/core/contracts.ts` — why nothing edits it casually

1345 lines of types, enums and const tables with **zero imports**. It is the root of the dependency
graph and every module compiles against it. Its own rules (lines 9-16): types, enums and const
tables only, no function bodies — cross-module functions are expressed as function *types*
(`StepFn`, `CompileFn`, `SampleFn`) so an implementing module writes
`export const step: StepFn = ...` and the compiler proves the signature.

It also pins things that are load-bearing elsewhere and cannot be changed in isolation: the
`FighterView` word offsets and `STATE_WORDS = 576` (change one and every snapshot, hash and replay
shifts), `MoveId`/`AnimId`/`SfxId` as interned integers (a glob-ordered registry is not stable
across filesystems; an enum is), and the two coordinate systems with the exact conversion between
them. Adding a field is fine — the fighter slot is padded to `FIGHTER_WORDS = 64` for exactly that
reason. Reordering or renarrowing anything is not.

---

## 3. The canonical frame order

Stated once in `docs/ENGINE-DECISIONS.md` §4 and owned by `src/sim/step.ts`. The code below is the
phase list as `step()` actually executes it:

```
 0  g.frame++;  events.beginFrame()
 1  input rings advance  (ringWrite × 2)          ALWAYS, even in hitstop
 2  recogniseCommands -> commandMask              ALWAYS  (no recogniser yet: writes 0)
 3  for p in 0,1:
       if (f.hitstop > 0) { f.hitstop--; continue }   <-- THE ONLY FREEZE
       tickTimers(s, ix)          hitstun--, blockstun--, knockdown--, wakeup--,
                                  landingLag--, dashTimer--, throw timers
       resolveTransitions(s, ix)  the one and only assignment of f.state
       advanceAction(s, ix)       timeline -> this frame's boxes and velocity
 4  integrate()   5  groundClamp()   6  wallClamp()   7  separate()
 8  gather()      one position snapshot, BOTH fighters, hits AND throws. Nothing applied.
 9  freeze()      copy every field commit reads into a pre-commit snapshot
10  commit()      reads ONLY the frozen snapshot      10b commitThrows()
11  updateFacing()
12  roundCheck()  the round clock, KO -> ROUND_END -> next round
```

Two invariants. Break either and the game is subtly, unfindably wrong:

**1. The per-fighter hitstop gate is the only freeze, and the stun timers tick INSIDE it.**
`tickTimers` is called *after* the `if (f.hitstop > 0) continue` guard, on purpose
(`src/sim/step.ts:307-318`). Ticking hitstun outside the gate burns 9 to 14 frames of every hit's
advantage and drops every combo in the game — silently, because each move in isolation still looks
correct. What the gate does **not** freeze: the frame counter, the input rings, the command
recogniser, the event ring, the camera, sparks and audio. A big kick must read as *the fighters are
frozen, the world is exploding*, and a player must be able to buffer a confirm through the freeze.
The gate is symmetric — attacker and defender get the same count (the max of the two on a trade) —
which is what makes frame advantage arithmetic: `adv = stun − (total − 1 − firstActive)`.

**2. gather → freeze → commit, in that order, with commit reading only the frozen snapshot.**
Gathering simultaneously but *committing* sequentially still leaks: corner pushback reads the
opponent's `cornered` flag and scaling reads `comboCount`, so whoever resolves second reads a world
the first already changed. That is the mechanism behind "that trade resolves differently on P2
side". The snapshot removes it by construction rather than by care.

---

## 4. Characters — the technical spec

*(The engineering half only: which stances exist, what the sprite pipeline demands, what a drawing
must satisfy. Nothing here is about how a character should look.)*

> **`docs/CHARACTER-SPEC.md` is the long form of this section** — every `CharDef` and `MoveDef`
> field, the concept-space convention, and an end-to-end "I have drawings → it fights" checklist.
> What follows is the orientation version: enough to know what exists and where the edges are.

### 4.1 The roster, as code

Six slots, all live (`src/data/registry.ts:43`), each with 1000 HP. **B–F are literal copies of A.**
I normalised comments and identifiers and diffed: `b.ts`–`f.ts` are **zero differing lines** from
`a.ts` — same frame data, same boxes, same physics, same palette. Only `CharId`, `MoveId`, the
display name and the comments differ. Differentiation is meant to be *frame data*, and none has been
authored yet.

Naming is sequential everywhere and there are no proper names in code: `CharDef.name` and
`CharDef.dance` are both the bare letter (`dance: 'A'`, `src/data/chars/a.ts:147`), stages are
`stage-1`…`stage-6`, music ids are `stage-1`…

Each character has exactly two moves, verified in `src/data/chars/a.ts`:

| move | total | startup | active | recovery | dmg | guard | kbX | blockPushX | cancels into |
|---|---|---|---|---|---|---|---|---|---|
| `5P` jab | 17 | 5 | 5–7 | 9 | 50 | MID | 2.4 | 3.0 | f5–14 on hit/block → P, K, SPECIAL; f5–14 on hit → JUMP, THROW |
| `5K` | 29 | 9 | 9–12 | 16 | 100 | MID | 4.6 | 5.2 | f9–22 on hit → SPECIAL, JUMP; f9–16 on hit/block → DASH |

`blockPushX > kbX` on both buttons is deliberate and is the single most important line in the feel
table: blockstrings push you out and end, confirmed hits keep you close.
`moveOrder: [MoveId.A_5K, MoveId.A_5P]` (`a.ts:182`) is authored data — never object-key order —
because move matching walks it in priority order.

Physics, character A (`a.ts:150-158`), currently identical on all six:

```
walkF 4.0   walkB 3.4   jumpSquat 4   jumpVelY 24.2   jumpVelXF 5.0 / B 4.4
gravity 1.10   groundFriction 0.84   landingLag 3   weightPct 100   airJumps 0
dashSpeed 9.0 / 20f   backDashSpeed 8.0 / 22f   runDash true        <-- dash is DATA ONLY, no state uses it
```

### 4.2 The stance list

Two orthogonal axes, per `ENGINE-DECISIONS` §8: `f.state` (physical: owns physics, collision and
what input is legal) × `f.action` / `actionFrame` (which move timeline is playing). `S` in
`contracts.ts:213` declares 25 states. This is which of them the machine can actually reach today —
I grepped every assignment of `f.state` in `src/sim/**`, and there are only two writers
(`resolveTransitions`/`startAction` in `fighter.ts`, and the forced stun assignment in
`hits.ts:398-406`):

| `S` state | reachable now? | set by | drawn as (`AnimId`) | art in the sheet? |
|---|---|---|---|---|
| `STAND` | yes | `fighter.ts:410,429,514,554` | `IDLE` | ✅ 1 drawing |
| `WALK_F` | yes | `fighter.ts:420` | `WALK_F` | ✅ 5 drawings |
| `WALK_B` | yes | `fighter.ts:425` | `WALK_B` | ✅ walk reversed |
| `JUMP_SQUAT` | yes | `fighter.ts:348` | `JUMP_SQUAT` | ⚠️ neutral, 1f |
| `JUMP_RISE` | yes | `fighter.ts:369` | `JUMP_RISE` | ✅ first ~60% of jump art |
| `JUMP_FALL` | yes | `fighter.ts:541` | `JUMP_FALL` | ✅ the rest |
| `LANDING` | yes | `fighter.ts:487,537` | `LAND` | ⚠️ neutral, 1f |
| `ACTION` | yes | `fighter.ts:199` | the move's own `anim` | ✅ `ATK_5P`, `ATK_5K` |
| `HITSTUN_STAND` | yes | `hits.ts:406` | `HIT_STAND` / `HIT_STAND_HARD` | ✅ 2 + 2 drawings |
| `HITSTUN_AIR` | yes | `hits.ts:406` | `HIT_AIR` | ⚠️ borrows the soft frames |
| `BLOCKSTUN_STAND` | yes | `hits.ts:398` | `BLOCK_STAND` | ❌ falls back to IDLE |
| `BLOCKSTUN_AIR` | yes | `hits.ts:398` | `BLOCK_AIR` | ❌ IDLE |
| `KO` | yes | `fighter.ts:457` | `KO` | ❌ IDLE |
| `HITSTUN_CROUCH`, `BLOCKSTUN_CROUCH` | **no** — need `FF.CROUCHING` or `Rx.CROUCH`, neither ever set | — | `HIT_CROUCH` / `BLOCK_CROUCH` | `HIT_CROUCH` borrows soft |
| `CROUCH` | **no** — nothing sets it | — | `CROUCH` | ❌ |
| `DASH_F`, `DASH_B` | **no** — only referenced by a friction exclusion (`physics.ts:97`) | — | `DASH_F`/`DASH_B` | ❌ |
| `KNOCKDOWN`, `WAKEUP` | **no** | — | `KNOCKDOWN`/`WAKEUP` | ❌ |
| `THROW_HOLD`, `THROWN` | **no** | — | `ATK_THROW`/`THROW_HELD` | ❌ |
| `INTRO`, `WIN_POSE`, `ROUND_FREEZE` | **no** | — | `INTRO`/`WIN` | ❌ |

`AnimId` (`contracts.ts:122`) declares 30 named clips. The builder emits **13**. Every other one
resolves to `IDLE` at load with one `devWarn` naming the missing set (`skin/sheet.ts:119-129`) — a
fighter is never invisible, it just stands there. The 17 undrawn clips are: `CROUCH`, `DASH_F`,
`DASH_B`, `BLOCK_STAND`, `BLOCK_CROUCH`, `BLOCK_AIR`, `KNOCKDOWN`, `WAKEUP`, `KO`, `WIN`, `INTRO`,
`ATK_2P`, `ATK_2K`, `ATK_JP`, `ATK_JK`, `ATK_THROW`, `THROW_HELD`.

Which clip is drawn is decided in one place, `STATE_ANIM` in `src/gfx/renderer.ts:86`, with one
computed entry: standing hitstun picks `HIT_STAND_HARD` when the *original* hitstun ≥ 19
(`HARD_HITSTUN_FRAMES`, `renderer.ts:63`). The sim stores no hit severity and does not need to:
`hitstun + stateFrame` is invariant for the whole reaction, so the original value is recoverable at
any frame. Punch is 16, kick 21, so 19 separates them — and a counter-hit jab (16+6=22) correctly
promotes to heavy when counter-hit is switched on. Two of the 45 tests assert exactly this.

The frame handed to the skin is `f.actionFrame` during a move and `f.stateFrame` otherwise
(`renderer.ts:348-349`).

### 4.3 Sprite rules

**The runtime contract** is `SpriteSheet` / `SpriteClip` / `SpriteFrame` in `contracts.ts:980-1014`
— a PNG atlas plus one JSON, deliberately tool-agnostic, so a Python packer, the offline rig baker
or an artist exporting from Aseprite all produce the same two files:

```jsonc
{ "image": "male-caporal.png", "atlasW": 1652, "atlasH": 2485,
  "unitsPerPx": 0.623608017817372,
  "clips": {
    "IDLE":   { "loopAt": 0,  "frames": [ { "uv": [825,623,372,606], "origin": [188,606], "dur": 1 } ] },
    "ATK_5P": { "loopAt": -1, "frames": [ /* 3 images, dur 5 / 8 / 4 */ ] }
  } }
```

Rules, all enforced or relied upon by code:

1. **Clips are keyed by the `AnimId` NAME string** (`"IDLE"`, `"ATK_5P"`), never by index — the
   enum grows. `sheet.ts:160` resolves the name via `AnimId[a]`.
2. **`uv` is `[x, y, w, h]` in atlas pixels.** A frame whose rect falls outside the declared atlas
   is dropped, not fatal (`sheet.ts:176-184`).
3. **`origin` is the pivot in frame-local pixels, x from the LEFT and y from the TOP**, and it maps
   onto the fighter's world origin: feet centre, on the ground line. It is per-frame because a
   crouch and a jump do not share one.
4. **The origin may legitimately fall OUTSIDE the frame, and on airborne art it does.** Verified in
   the shipped data: `a.sheet.json` `JUMP_RISE` frame 2 has `h = 583` and `origin[1] = 606`;
   `JUMP_FALL` has `h = 589` and `origin[1] = 606`. Feet tucked up means world (0,0) is *below* the
   bitmap. **Never clamp it into the rect** — clamping drops every jump back onto the floor.
5. **`dur` is sim frames, ≥ 1.** `sheet.ts:47` flattens `dur` into a `byFrame` lookup, so drawing
   is one array read. `loopAt` is the frame index to loop back to; `-1` is a one-shot that holds its
   last image. Out-of-range frames never throw: a looping clip wraps into its loop region, a
   one-shot holds (`clipFrameAt`, `sheet.ts:66`).
6. **`unitsPerPx` is atlas pixels → world units**, per costume, derived from that costume's own
   neutral height, so every character is exactly `FIGHTER_HEIGHT = 378` units tall no matter what
   resolution it was drawn at.
7. **Straight alpha, not premultiplied.** `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is 0 and the batcher
   blends `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (`sheet.ts:255-270`). The quad shader does
   `mix(rgb, white, flash)` and `a *= alpha`, both straight-alpha operations; a premultiplied atlas
   makes the hit flash paint a white box over the sprite's transparent margin.
8. **`LINEAR` filtering, no mipmaps** — this art is rich and detailed, never pixel art, and a mip
   chain only softens the ink line. Which is why frames need a transparent gutter (the builder pads
   4 px) and colour bled into their transparent texels.
9. **Facing is one negated column, about the origin** (`sprite.ts:158-161`). The UV rect is *not*
   swapped as well — doing both cancels out and yields an unflipped sprite in a shifted box.
10. **A missing or broken sheet is not an error.** `acquireSheet` resolves to `null` — never throws,
    never rejects — and the caller keeps the procedural stick skin, so the game always runs.

**The authoring rules** (`tools/build-sheets.py`) — naming *is* the interface:

```
assets/movements/<costume>-<clip>.png          male-caporal-neutral.png
assets/movements/<costume>-<clip>-<n>.png      female-caporal-walk-2.png
```

- Recognised clips: `neutral` (**required**, or the costume is skipped), `punch`, `kick`,
  `walk-1..n`, `jump-1..n`, `soft-hit-1..n`, `hard-hit-1..n`.
- Anything else is reported and skipped rather than shipped as junk. The clip part must match
  `^[a-z]+(-[a-z]+)*(-\d+)?$` — `hard-hit-2` is frame 2 of `hard-hit`; `hard-hit02` is a typo.
- **The two alignment rules, the only hard part:** grounded frames anchor on the **sole** (lowest
  opaque pixel sits on the ground line); airborne frames (`jump*`) anchor on the **head**, offset
  down by that costume's own standing height, because tucked feet have no ground contact to measure.
  Rule 4 above is the consequence.
- Pacing is derived, not authored: walk is a ~30-frame stride however many drawings exist
  (`wdur = max(2, round(30/len(walk)))`, so 5 drawings → 6 frames each; `WALK_B` is the walk
  reversed at `wdur+1`). Jump art splits 60/40 into rise/fall. Hit reactions are paced to cover
  their own hitstun span exactly and then hold — `SOFT_HITSTUN = 16` over the `soft-hit` drawings,
  `HARD_HITSTUN = 21` over the `hard-hit` ones. `ATK_5P` is 5/8/4 = **17** and `ATK_5K` is 9/12/8 =
  **29**, which are exactly `A_5P.totalFrames` and `A_5K.totalFrames`; if you retune a move's total
  frames, these constants in `build-sheets.py:206-211` have to follow.
- Per-frame processing: crop to the alpha bbox at a 12% threshold, level the alpha, resize to
  `SCALE = 0.45`, pack 4 per row with 4 px padding.
- `ROSTER` (`build-sheets.py:66`) maps roster slots to costumes. Today: `a`,`c`,`e` →
  `male-caporal`; `b`,`d`,`f` → `female-caporal`. I verified the output: `a/c/e.sheet.json` are
  byte-identical, as are `b/d/f.sheet.json`.

---

## 5. Done vs NOT BUILT

### Done and working

- The whole sim frame: state machine, physics, AABB collision with four box classes, hit
  resolution, hitstop, knockback with corner transfer, wall clamp, KO, round and match flow with
  reset. `npm run check` proves the rules headlessly in node.
- Fixed-point determinism plumbing: `ONE = 256`, `fxMul`, the 576-word flat state, `snapshot` /
  `restore`, the 48-slot event ring with a `confirmedFrame` watermark.
- Input: keyboard for two players on one keyboard, sticky latch, per-slot consume bits, 6-frame
  leniency, absolute→relative conversion at read time. `GamepadSource` and `ReplaySource` classes
  exist in `input/sources.ts` (only `keyboardPair()` is wired up). `DummySource` exists with six
  modes.
- Rendering: WebGL2, one instanced quad batcher, the sprite skin (shipping path), the procedural
  stick skin (fallback), the stage backdrop with parallax and a flat-band fallback, HP bars, the F1
  box overlay, the camera.
- The sprite pipeline: 32 drawings across two costumes → two atlases → six sheet JSONs.
- Audio: graph, buses, loader with an extension probe, music player. `stage-1.mp3` plays.
- Character select model and screen (`ui/select.ts`), scene stack (`game/scenes.ts`), match
  lifecycle (`game/match.ts`).

### NOT BUILT — verified absent

| thing | evidence |
|---|---|
| **Crouch** | `FF.CROUCHING` is read in two places (`sim/collision.ts:110`, `gfx/debugdraw.ts:231`) and **set nowhere**; `S.CROUCH` is assigned nowhere. |
| **Dash** | `S.DASH_F`/`S.DASH_B` appear only in a friction exclusion (`physics.ts:97`) and in move `stateMask`s. `dashSpeed`/`dashFrames` are authored but unused. |
| **Throws** | No character authors a `throwBox`; `commitThrows` (`step.ts:106`) retires an always-empty candidate; `synthesizeThrowMacro` has no caller. The literal for A's throw is preserved verbatim in `docs/MOVE-FORMAT.md` for paste-back. |
| **Air normals, crouching normals** | `MoveId` reserves `*_2P/_2K/_JP/_JK/_THROW` for all six characters; none is authored. |
| **Block art** | Blocking *works* in the sim (`canBlock`, `hits.ts:176`; `BLOCKSTUN_*` states are entered) but `BLOCK_STAND`/`BLOCK_CROUCH`/`BLOCK_AIR` have no clip and render as `IDLE`. |
| **Knockdown / wakeup / intro / win pose / KO pose** | States and `AnimId`s exist; nothing enters them and no art exists. |
| **Damage proration, counter-hit** | Explicitly deferred: `const counter = false` (`hits.ts:289`) and flat 50/100 damage (`hits.ts:32`). `DAMAGE_SCALE` and `STUN_SCALE` are in contracts but unapplied — so `docs/FEEL-NUMBERS.md`'s combo table is a *target*, not current behaviour. |
| **Motion commands** | `recogniseCommands` writes 0 every frame (`step.ts:87`); `sim/commands.ts` does not exist. |
| **Characters B–F as characters** | Byte-identical copies of A (§4.1). |
| **Stages 2–6** | Only `STAGE_1` exists as data. `assets/backgrounds/stage-3.png` and `public/art/stages/stage-3.png` (2172×724) are present with **no `StageDef`** — the art is staged and unreachable. |
| **SFX wiring** | `src/audio/sfx.ts` (319 lines, `SFX_FILES` table, event-ring drain, `createAudioSystem` facade) is complete and **imported by nothing**. `main.ts` builds graph + loader + music only. `public/audio/sfx/` does not exist. |
| **Tests and golden data** | `tests/` and `golden/` are **empty directories**. The determinism and mirror tests that ENGINE-DECISIONS §6 and §17 justify the whole architecture with do not exist. The 45 checks in `scripts/check-rules.ts` are all there is. |
| **`src/data/validate.ts`** | Does not exist, though `registry.ts:60` says it owns validation and "runs in CI and in the dev server". Nothing validates compiled frame data. |
| **`src/sim/hash.ts`, `sim/throws.ts`, `sim/commands.ts`, `sim/round.ts`, `gfx/fx.ts`, `gfx/post.ts`, `gfx/skin/parts.ts`, `ui/hud.ts`, `ui/debug.ts`, `src/util/**`** | Listed in `docs/FILE-TREE.md`; none exists. `src/util/` is an empty directory. |
| **Scene stack reachable from boot** | ⚠️ **Check this first.** As of this writing `src/main.ts` (last modified 17:45) constructs its own inline `FightScene` and does **not** import `@/game/scenes`, so the `[` select screen is unreachable — while `src/game/match.ts` and `scenes.ts` were being edited at 18:41 by another workflow. Confirm with `grep -n "scenes" src/main.ts` before believing either way. |

---

## 6. Traps

**The contract is frozen.** `src/core/contracts.ts` has zero imports and everything imports it.
Adding is cheap (the fighter slot is padded to 64 words for that); reordering `F`/`GL` offsets,
renumbering an enum or narrowing a type breaks snapshots, hashes and replays at once. Re-run
`npm run typecheck` across all modules after any edit to it.

**`|0` truncation is load-bearing for mirror symmetry.** `fxMul(a,b) = ((a*b)/ONE)|0`
(`core/fixed.ts:68`). `|0` truncates toward zero, so `trunc(-x) === -trunc(x)`. Measured in the
contract's own comment: at `kbX = 1179` with 88% decay, `|0` gives ±1036 (symmetric) while `>>8`
gives 1036 / **−1037** (asymmetric). Swapping in `>>8` "for speed" silently makes leftward knockback
decay differently from rightward — the actual mechanism behind "that combo only works on P1 side".
Same reason pushbox separation at exactly equal positions pushes each fighter along `−own.facing`
rather than breaking the tie on slot index (`sim/physics.ts:30-34, 233-248`).

**Sprite origins outside the frame are correct.** See §4.3 rule 4. The first instinct on seeing
`origin[1] > h` is to clamp it. Don't.

**The builder writes atomically, and you want it to.** `build-sheets.py:138-145` writes
`<name>.tmp.png` then `os.replace`s it (same for each `.sheet.json`). The Vite dev server serves
straight out of `public/art/`, so a rebuild during a live session must never expose a half-written
file — a truncated PNG decodes as a black rectangle, which looks exactly like a rendering bug. Keep
the `.png` extension on the temp file: ImageMagick picks its encoder from the extension.

**`npm run sheets` must be re-run whenever art changes.** Nothing watches `assets/`. The atlas and
the JSON are only consistent because one run writes both — if the PNG is regenerated and the JSON
is not (or you hand-edit one), every `uv` points at the wrong rectangle and the sprites look
scrambled rather than missing. `sheet.ts:292` warns when the decoded image size disagrees with
`atlasW`/`atlasH` and then **uses the image anyway**, so that warning is your only signal. Note the
asymmetry: stage backgrounds are skipped when the destination is newer than the source, but sprite
atlases are rebuilt unconditionally on every run.

**`tools/bake-sprites.mts` will overwrite the hand-drawn sheet.** It is the *offline* rig baker —
the 24-bone rig moved offline, and it rasterises the stick skin into frames. It hardcodes
`writeFileSync('public/art/a.png', …)` and `'public/art/a.sheet.json'` (lines 542-543). Running it
replaces character A's hand-drawn sheet with baked stick-figure art. It has **no npm script** and
needs the `@/` alias resolved to run at all. Treat it as a fallback generator, not part of the
normal loop.

**The sheet builder only recognises costumes named `*-caporal`.** `build-sheets.py:84` matches
`^(.*?-caporal)-(.+)$`. I simulated the scan over the current `assets/movements/`: **10 of 42 files
are skipped** — all nine `female-tinku-*.png` drawings (unrecognised costume) plus
`male-caporal-hard-hit02.png` (malformed clip name; `hard-hit-2` already exists). New art in a new
costume is silently invisible until that regex and `ROSTER` learn about it.

**A missing sheet is silent by design.** Missing clips, a 404, a broken JSON and a non-decoding PNG
all degrade to the stick skin or to `IDLE` with a single console line. Good for shipping, bad for
noticing — check the console when a character looks wrong rather than assuming the data is fine.

**Decimals are legal in `src/data/**` and forbidden in `src/sim/**`.** `compile.ts` converts once
at load and rounds to integers; the sim is integers only. Nothing enforces this — `eslint.config.js`
("THE WALL" in `docs/FILE-TREE.md`, which was also supposed to ban `>>` on fx values) does not
exist, and neither does a linter in `package.json`. It is a convention held up by review alone.

---

## 7. Where to look next

1. **Teach the sheet builder the new costume.** Nine `female-tinku-*` drawings are sitting in
   `assets/movements/` and are being skipped (§6). It is a regex and a `ROSTER` entry, and it is the
   only thing blocking a third look from reaching the screen.
2. **Confirm the boot path reaches `game/scenes.ts`.** If `main.ts` still builds its own
   `FightScene`, the select screen, the dummy and the match lifecycle are all written and unreachable
   — the cheapest large win in the tree.
3. **Write `src/data/validate.ts` and the two tests the architecture is justified by.** `tests/` and
   `golden/` are empty; the mirror and determinism tests are the only things that would catch a
   `>>8`, a slot-index tiebreak or state living outside the buffer. Right now nothing does, and the
   whole fixed-point discipline is unenforced.
4. **Author the rest of character A**: 2P, 2K, j.P, j.K and the throw, plus the `CROUCH` and
   `DASH_*` states. The state machine already has the cases (they resolve to neutral rather than
   being absent, so an early state cannot wedge a fighter), `MoveId` reserves the slots, the
   timeline format supports them, and `docs/MOVE-FORMAT.md` holds A's throw literal verbatim for
   paste-back.
5. **Give B–F their own frame data.** With two buttons and equal HP, reach / startup / active /
   recovery / walk speed / weight / pushbox width are the *only* axis of identity. `ENGINE-DECISIONS`
   §19 sketches one archetype per slot. Nothing else in the engine has to change.
6. **Wire the sfx.** `audio/sfx.ts` is finished and unimported; it wants an `EventDrain` in the
   frame loop and files in `public/audio/sfx/`.
7. **Stage 3.** The panorama is already staged at `public/art/stages/stage-3.png`; it needs a
   `StageDef` modelled on `stage-1.ts` (ground line as a fraction of image height, world height,
   parallax — all derived from the source pixel dimensions, which is why the builder never resizes
   a background).

---

## 8. The other docs — and what has gone stale

| doc | what it is for | status |
|---|---|---|
| `docs/CHARACTER-SPEC.md` | The technical character spec: the full stance list, the sprite file rules, alignment, `CharDef`/`PhysicsDef`/`MoveDef` field by field, and the add-a-character checklist. Written alongside this handoff. | Current. The authority for §4. |
| `docs/ENGINE-DECISIONS.md` | The locked architectural decisions, numbered §1–§19, each with its rationale. The *why* behind everything in §3 and §6 above. Read §4 (frame order), §5 (determinism), §9 (collision/block predicate) first. | Current, with one naming slip: §15 and §12 call the first stage `socavon`, which violates the sequential-naming rule. The code says `stage-1` throughout. |
| `docs/FEEL-NUMBERS.md` | The locked feel targets: per-hit-type table, A's frame data, movement, jump arc, proration, knockback, camera. | **Partly aspirational.** Hitstop, hitstun, blockstun, jump arc, walk speeds and stage geometry match the code. Proration, counter-hit, dash, back dash, crouching normals and air normals are **specified but not implemented** (§5). |
| `docs/MOVE-FORMAT.md` | A worked example of the `MoveDef`/`CharDef` format — an older copy of `chars/a.ts`, kept because it holds the throw literal for paste-back. | **Diverged from the code on purpose**, but read it as an example, not as truth: it shows `dance: 'Caporal'` where the code says `'A'`, and includes `A_THROW` in `moves`/`moveOrder` where the code does not. |
| `docs/FILE-TREE.md` | The intended final layout, with an ownership note per file. Useful as a map of where a new file *should* go. | **Largely aspirational.** Many listed files do not exist (§5), `chars/stages/socavon.ts` is really `stages/stage-1.ts`, `tools/bake-parts.mts` is really `tools/bake-sprites.mts` + `build-sheets.py`, and the `art/*.rig.json` + `public/baked/**` parts pipeline was superseded by the sprite pipeline. |
| `docs/M0-VERTICAL-SLICE.md` | The original 13-file milestone and its seven acceptance tests. Good context for why the early files look the way they do. | **Historical.** All 13 files exist and `main.ts` is no longer missing. Acceptance test 3 still names `J`/`K` and `Numpad1`/`Numpad2` — **stale**, see §1. |
| `CLAUDE.md` | Project rules: the fixed game rules, sequential naming, the sprite pipeline summary, art direction per slot. | Current. Its controls table matches `keymap.ts`. Note the "characters are stick figures for now" line is now the *fallback* path, not the shipping one. |

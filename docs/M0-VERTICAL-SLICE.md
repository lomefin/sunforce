## M0 — "two stick figures punch each other in a browser"

This is the milestone P1's plan was missing, and it is the one that decides whether a one-go parallel build works. **Nothing merges to main until M0 is green.** Note that `src/main.ts` does not exist today, so `index.html` currently fails to boot — M0 fixes that first.

### The 13 files that must work, in order

| # | File | Reduced to |
|---|---|---|
| 1 | `src/core/contracts.ts` | complete and frozen (already verified compiling) |
| 2 | `src/core/fixed.ts` | `fx/px/fxMul/fxDiv/fxClamp/fxPct`. ~30 lines |
| 3 | `src/sim/state.ts` | buffer alloc, `FighterView`/`GlobalView`, `createState`, `resetRound` |
| 4 | `src/data/compile.ts` | concept px → FX, sparse timeline → dense frames |
| 5 | `src/data/chars/a.ts` | **`5P` and `5K` only** (already written and typechecked) |
| 6 | `src/sim/collision.ts` | `worldBox`, integer AABB, `gather()` — hurt/hit only, throws stubbed |
| 7 | `src/sim/hits.ts` | `freeze()` + `commit()`: damage, hitstun, hitstop, knockback, KO |
| 8 | `src/sim/physics.ts` | integrate, ground clamp, wall clamp, pushbox separation |
| 9 | `src/sim/fighter.ts` | `resolveTransitions` for STAND / WALK / ACTION / HITSTUN only |
| 10 | `src/sim/step.ts` | **all 13 phases wired**, with commands/throws/round as no-op calls |
| 11 | `src/input/{sources,keymap,buffer}.ts` + `dummy.ts` | keyboard + `DummyMode.STAND` |
| 12 | `src/core/loop.ts` | accumulator + both guards. Snap only (`alpha` hardcoded 0) |
| 13 | `src/gfx/{gl,programs,batch}.ts` + `skin/pose.ts` + `skin/anim.ts` + `skin/stick.ts` + `renderer.ts` + `src/main.ts` | one instanced quad, the stick SDF shader, 24-bone solve, **procedural `poseHint` fallback only**, fixed ortho camera, two HP-bar quads |

### Deliberately deferred out of M0
Every one of these is purely additive against the frozen contract, which is the point:
throws · cancels · commands/motion inputs · crouch/jump/dash · counter-hit · juggle · proration (M0 does flat 50/100) · characters B–F · the parts skin and the whole bake pipeline · post-processing · the stage · audio · character select · the camera spring · interpolation · all five test files.

### Acceptance — all seven must hold
1. `npm run dev` boots to a black canvas with two stick figures on a ground line — **no `#fatal` overlay** (today it would show one; `src/main.ts` is missing).
2. Both figures have 24 solved bones and a visible accessory proxy (A's hat brim), not a T-pose.
3. `J` and `K` (P1) and `Numpad1`/`Numpad2` (P2) produce visibly different punch and kick animations **driven entirely by `poseHint` with zero authored clips**.
4. A connecting punch removes exactly 50 HP; a kick exactly 100. HP bars move.
5. On connect: both fighters freeze for 9/14 frames **while a debug spark keeps animating** — the freeze is per-fighter, not global.
6. `F1` draws hurt/hit/push boxes, and they line up with the limbs — which is the proof that concept space → world space is correct end to end.
7. Ten kicks KO. The round resets.

### Why this order de-risks the parallel build
It forces the three seams that every other file depends on to be exercised by real code before seven agents fan out: **concept space → world space** (acceptance 6), **sim → presentation via pose only** (acceptance 3), and **the per-fighter hitstop gate inside the canonical frame order** (acceptance 5). If those three are right, the remaining ~60 files are additive. If any is wrong, it is wrong in 13 files rather than 70.

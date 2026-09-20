## SunForce — LOCKED engine decisions

**Base: Proposal 1 (Lockstep Core / Observer Renderer).** It won every judge (7/7/6 vs 3/4/5 and 6/6/4). Grafted: P3's concept-space box authoring, P3's material-atlas-by-palette-substitution, P3's throw-on-P+K, P3's event-ring watermark; P2's respect for the repo that actually exists. All three fatal flaws and all three "missing from all" gaps are fixed below.

### Verified repo facts (I checked; the proposals disagreed)
- The repo is **not empty**. `package.json`, `vite.config.ts` (`@`→`./src`), `tsconfig.json` (strict + `noUncheckedIndexedAccess` + `isolatedModules` + `verbatimModuleSyntax`), `CLAUDE.md`, `index.html` (canvas `#game`, `#boot`, `#fatal-msg`) all exist. `src/{audio,core,data,gfx,sim,ui,util}` and `public/audio` exist and are **empty**. **`src/main.ts` is missing — index.html references it, so the app currently fails to boot.** P2 was right; P1 and P3 invented an empty project. We honour the existing layout.
- `concept/caporal.svg`: ground `#ground-shadow` ellipse **cy=858**, crown y=100, boot bottom y=856 → **756 px of character**. Midline **x=302** (the crotch vertex of `#legs`). 8 clipPaths. Palette `#A31627 #85101B #07060F #4C4849 #D9D7D8 #D1CFCE #C6973F #DAB8B0`; ink stroke `#2A2118` at widths 1–3.
- `concept/tobas.svg`: **ZERO clipPaths.** So P2's clipPath-derived sequin mask produces *nothing* for character D. Confirmed fatal.
- **The split problem is smaller than everyone said, and needs no geometry code.** I measured element-by-element: in caporal's `#legs`, only **2 of 27** elements cross x=302. `#arms`, `#footwear`, `#puffs` cross **zero**. tobas crosses **zero everywhere**. So parts declare a **concept-space clip rect** and the rasteriser clips — left leg `[0,0,302,960]`, right leg `[302,0,640,960]`. Exact on the 2 crossing paths, preserves stroke joins, one line in the baker. **No Bézier splitting anywhere.** This removes P1's and P3's art-pipeline fatal flaw outright.

---

### 1. Simulation clock — 60 Hz fixed, accumulator, two guards
`MAX_DELTA_MS=250` clamps an alt-tab; `MAX_STEPS_PER_FRAME=5` then **discards** the accumulator. The game runs slow for one hitch; it never spirals. *Rationale: banking debt is the only way a fighting game locks up.* KO slow-motion scales the **accumulator** (`acc += dt * timeScalePct/100`), never the step threshold — P2 had the multiplication on the wrong side and its KO ran at 4× speed.

### 2. Interpolation — snap the read, interpolate the drift
Action frame, all boxes and all bone poses **snap**. Only the render root translation and the camera lerp by `alpha`, and only when `refreshRate > 62`, no fighter is in hitstop, and `teleportEpoch` is unchanged. *Rationale: P2 interpolates bone angles, which on C's 4-frame jab is a 25% lie about the frame you are on. P3's `interpolatePose` opt-in survives for walk/idle only — the validator rejects it on any state carrying a hitbox.*

### 3. Hitstop — per-fighter, and the world keeps breathing
`f.hitstop > 0` → decrement and `continue`. **Symmetric**: attacker and defender freeze for the same count. *Rationale: this is not an oversight in SF/GG, it is why frame advantage is computable — hitstop cancels out of `adv = stun − attackerFramesRemaining`. P2 made it asymmetric, which silently offsets every move by +2 and leaves the trade case (one fighter owed two different hitstops) undefined.* The input ring, command recogniser, frame counter, camera, sparks, shake and audio all keep running, so buffering a confirm through the freeze works and a big kick reads as *fighters frozen, world exploding*.

### 4. THE canonical frame order — stated once, owned by `src/sim/step.ts`
P1's fatal flaw was shipping two contradictory orders (§1 ticked hitstun inside the gate, §6 ticked it unconditionally — implement §6 and every combo drops). There is now exactly one:

```
0  frame++;  events.beginFrame()
1  input rings advance          (ALWAYS, even in hitstop)
2  commands -> commandMask      (ALWAYS)
3  for p in 0,1:
     if hitstop > 0 { hitstop--; continue }        <- the ONLY freeze
     hitstun--, blockstun--, knockdownTimer--, wakeupTimer--   <- INSIDE the gate
     resolveTransitions(); advanceAction()
4  physics.integrate()   5  ground clamp   6  wall clamp   7  pushbox separation
8  collision.gather()    one position snapshot, BOTH fighters, hits AND throws.
                         NOTHING applied.
9  hits.freeze()         copy every field the commit reads (hp, cornered,
                         juggleCount, comboCount, facing, state) into a
                         pre-commit snapshot
10 hits.commit()         both slots read ONLY the frozen snapshot -> genuinely
                         order-independent
11 facing.update()       12  round.check()
```
Step 9 is the fix for the correctness judge's "missing from all": gathering simultaneously but *committing* sequentially still leaks, because corner-pushback transfer reads the opponent's cornered flag and scaling reads comboCount. Now it can't.

### 5. Determinism — integers executed in doubles, `ONE = 256`
`fxMul(a,b) = ((a*b)/256)|0`. **Proved, not asserted:** max `posX` = 3600·256 = 2^19.8; scalars < 2^16; products ≤ 6.04e10 < 2^53, so the multiply is exact on every conforming engine. Rejected P2's `(Math.imul(a,b)/256)|0` — `imul` truncates to 32 bits *before* the divide and wraps by construction. Rejected P3's Q16.16 split-word version as unnecessary at our range.

**`|0` truncates toward zero and that is load-bearing.** I verified it: at `kbX = 1179` with 88% decay, truncate gives ±1036 (symmetric), `>>8` gives 1036 / **−1037** (asymmetric). Floor-rounding makes leftward knockback decay differently from rightward — the actual mechanism behind "that combo only works on P1 side". P1 got this right by accident and didn't know why; it is now a comment, a test, and a lint rule.

### 6. Mirror symmetry — a first-class invariant with a test (missing from all three)
`tests/mirror.test.ts` replays a golden input stream with players swapped and every x negated about the stage centre, and asserts the hash stream is the mirror of the original. Three concrete violations pre-emptively fixed: (a) trunc-toward-zero rounding, above; (b) **no slot-index tiebreaks** — pushbox separation at exactly equal positions pushes each fighter along `−own.facing` (perfectly antisymmetric) instead of P1's `a.posX <= b.posX ? -1 : 1` with `a` hardcoded as fighter 0; (c) the frozen pre-commit snapshot at step 9.

### 7. Input — absolute directions, sticky latch, per-slot consume
One `uint16` per player per frame. Directions stored **absolute**, converted facing-relative at read time, so a replay survives a side swap. Sticky latch (`live | sticky`) so a 4 ms tap between ticks cannot be eaten. Edges are **derived** (`held[i] & ~held[i-1]`), never stored — a stored edge goes stale across a rollback.
**Consume bits live in the high 16 bits of the ring word**, per frame slot. *Rationale: P1's `consumedMask` was a global button mask, so with 6-frame leniency a jab that consumed P at frame 10 would eat a genuinely new P press at frame 15. Per-slot fixes it with zero extra memory.*
`THROW` is a synthesised macro bit: P and K within `THROW_MACRO_SLOP = 2` frames. Motion recognisers (`QCF/DP/charge`) ship working on day one even though v1 has no specials, so the plumbing is exercised, not hypothetical.

### 8. Character state machine — two orthogonal axes, one owner
`f.state` (physical: owns physics, collision, legal input) × `f.action`/`actionFrame` (which `CompiledMove` is playing). Transitions are owned by **exactly one function**, `resolveTransitions`, in one `switch`, with a fixed ladder: forced (hitstun/KO/round) → cancel window ∩ buffered input → new move by `moveOrder` priority → movement → idle. No enter/exit callbacks, no state objects, no observers. `moveOrder` is **authored data**, never object-key order.
Cancels are declarative: `{ window: [6,14], on: On.HIT, into: G.KICK|G.SPECIAL }`. `FF.HIT_CONFIRMED` is set by `hits.commit`; `usedCancels`, `hitIdsUsed`, `chainDepth` and `chainMoveId` are **all cleared in `startAction`** and nowhere else — P1 read `hitIdsUsed` but never wrote it and never cleared `usedCancels`.

### 9. Collision — AABB, four box classes, throws from day one
Axis-aligned only. Integer overlap is four compares (exact, no epsilon); players *read* rectangles; every canonical fighter from SF2 to Strive ships AABB; a swung arc is 2–3 boxes. Classes: **hurt, hit, push, throw**.

**Throws are simulation, not a later feature.** With two buttons, no throw, and blocked pushback deliberately exceeding hit pushback, holding back is strictly dominant and every system above it collapses into turtling. P1 and P2 both missed this; P1 additionally shipped "no reversal invuln in v1", leaving okizeme with no counterplay at all. So: `BoxKind.THROW` is in the gather from day one, **strike beats throw** on the same frame (a throw is a read, not a mash), throw-vs-throw is a mutual whiff into 16f neutral, 3-frame tech window, throw-invulnerable wakeup frames 0–3. Damage 100 — kick-equivalent, so "punch 50 / kick 100" stays literally true.

**Block predicate — the clause that fixes P1's fatal gameplay bug.** P1 required the defender to be "actionable", while `resolveAction` short-circuits on `hitstun | blockstun | knockdownTimer` — read consistently, a fighter in blockstun cannot block, making every two-hit blockstring an unblockable counterhit. Locked:
```
canBlock = !(flags & GUARD_BROKEN) && hitstun === 0 && knockdownTimer === 0
        && (state !== S.ACTION || actionFrame < startup(action))
        && holdingBack(facing-relative) or G held
        && guardHeightMatches(props.guard, crouching, airborne)
```
**Blockstun is deliberately not excluded** — the second hit of a blockstring must be blockable.

**Trades: both connect, neither gets counterhit.** *Rationale: P3 was right that a trade is a mutual mistake, not a punish; P1 never said.* No priority by player index (deterministic but unfair), none by move level (a design decision we don't need yet).

**Pushboxes:** symmetric split, `PUSH_SEP_MAX=6`/frame cap, corner transfer (whoever can't move donates their share — this is what makes cornering *stick*), and **air-vs-air separation disabled** (standard convention; P1 halved it instead and would drift air-combo spacing).

### 10. Frame data — TypeScript literals, boxes in CONCEPT SPACE
Containers are `.ts` literals, not JSON: compile-time interface checking is the only thing that keeps six parallel agents honest, and P3 deleted it. But the **numbers are concept-space** — absolute pixels of the 640×960 sheet, y-down, `[x0,y0,x1,y1]` — with `ConceptSpace { originX: 302, groundY: 858, unitsPerPx: 0.5 }` declared once per character. A designer reads a box straight off the artwork. *Rationale: this is the cheapest possible defence against the frame-data agent and the rig agent inventing two coordinate systems, which nobody notices until a kick visually whiffs.* Bone rest poses are authored in the same frame, so boxes, bones and art share one space. Characters B/C/E/F (no sheet yet) use caporal's conceptSpace as placeholder, and their boxes transfer unchanged when their sheet lands.
`compile.ts` converts once at load and **expands the sparse timeline to a dense per-frame array**, so the sim never searches. Decimals are legal in `src/data/**`; the float ban applies to `src/sim/**` only, and `validate()` asserts every *compiled* number is an integer. *Rationale: P1's lint banning decimal literals in data would fire on every authored number and agents would just disable it.*

### 11. Damage & round math — proration on, but hit #1 always full
`DAMAGE_SCALE = [100,80,70,60,50,42,36,32,30]`, floor 30, min 10, applied from combo hit #2. **So "a connected punch takes 50" is literally true for every non-combo hit**, which is what the user's rule means — while combos don't trivially kill. Verified: `P>P>K = 160`, `K>K = 180`, `P>P>K>K = 220` → **4.5–6 confirms per round**, ~40 s rounds, 99 s timer, first to 2.
**Hitstun proration is a separate, much gentler table** (`STUN_SCALE`, floor 64). *Rationale: P1 scaled hitstun by the damage table down to 20%, which is 9 frames of hitstun on a jab at hit 5 — every route drops. Juggle-count gravity plus per-move `juggleLimit` already terminates combos correctly.*

### 12. Rendering — baked part atlas + 24-bone rig, B/F not L/R
Offline-baked raster parts, one instanced quad batcher, ~17 draw calls. Rejected runtime `Path2D` (CPU-bound, unbatchable, non-deterministic across browsers) and tessellation (destroys the 3px ink outline that *is* the hand-drawn look, and explodes the 81 sequins into tens of thousands of triangles).

**Bones are B/F (back/front relative to facing), never L/R.** This is P1's genuine win and it fixes both P2's and P3's *unflagged* fatal art bug: they bind part z to L/R bones with fixed depth, so when a fighter turns around the far arm and far leg do not swap behind the torso — broken on every crossup and every side swap. With B/F, facing flip is `scaleX = −1` on root: no bone swapping, no mirrored clips, no z inversion.

**Material atlas by palette substitution (grafted from P3).** Re-render each part with rules keyed on the artwork's own fill hexes → `mat.png`: R = specular/sequin, G = rim mask, B = emissive, A = palette row. `#D9D7D8`/`#E0E2DD` become sequin fields, `#C6973F` becomes emissive gold. Zero hand-painted maps, works on tobas (no clipPaths) and on all four unmade sheets, and gives the fake alpha-gradient rim light a real authored mask so plume quills can opt out of the both-sides glow P1 conceded it couldn't fix. `glintPhase` advances with character speed — sequins sparkle when you move.

**Soft parts deform.** `mesh: 'grid5'` (5×5 grid, 2 bones) on exactly the parts that read as a pivoting sticker when rigid: `plume-wings`, `headwear-fan`, `waist-and-apron`. Plus 1-bone jiggle springs on bells, plumes and apron driven by the derivative of root position. *Rationale: P2 and P3 ship pure rigid quads; a 63-path feathered fan rotated rigidly is dead on screen in a game whose art direction is plumes in motion.*

**VRAM — nobody computed it, so:** albedo 2048² RGBA8 (16.8 MB) + material 1024² (4.2 MB) = **21 MB per character**. Only the two selected characters are resident, so **42 MB + stage**. P1's 4096² × 2 costumes × 6 characters was ~192 MB+ and fatal on an iGPU. Stick skin needs **zero** atlas.

**Scale math, from measured geometry:** 756 concept px → 378 world units ⇒ `unitsPerPx = 0.5` exactly. Concept art is therefore already drawn at 2× world resolution; `BAKE_SCALE = 2` gives **4× world resolution**, supporting the 1.30 zoom ceiling with real headroom.

**Z between two overlapping fighters:** painter's order, no depth buffer (depth-testing alpha-blended quads haloes). Whoever has an active hitbox draws in front; tie → `lastHitBy`; tie → player index. The rule only re-evaluates when neither fighter is in hitstop, so it never pops during the visible freeze.

### 13. Two skins, one interface — and the stick figure poses the costume bones
`CharacterSkin` with `emit(out, pose, opts)`; `SkinStick` (capsule-SDF quads, taper, outline, per-character palette lifted from the sheet) and `SkinParts` (baked atlas) both implement it. F1 toggles live.

**Mandatory fix (missing from all three): the stick skin draws posable PROXIES for the accessory bones.** All three promised "animation authored on sticks survives the upgrade untouched" — true for the 19 body bones, false for exactly the parts that make these characters Bolivian carnival dancers. If `headwear`, `plume-wings`, `headwear-fan`, `puffs`, `waist-and-apron` and `bells` are invisible on the placeholder, nothing is ever keyed on them, and six months later the real art lands welded and dead. So `StickDef.accessories` declares a crude brim/fan/plume/apron/bells/horns/shell/skirt proxy per accessory bone, **sized from the real measured group bounds** (caporal headwear `[224,100,376,167]`, puffs `[162,266,438,396]`, bells `[212,675,412,807]`; tobas headwear-fan `[228,108,374,339]`, plume-wings `[100,315,450,437]`, waist-and-apron `[192,536,408,700]`), driven by the same bone transforms and jiggle springs the real parts will use. P2's one static accessory primitive is recognisability, not a keyable track.

### 14. Animation fallback — what renders before any clip exists (missing from all three)
Every move declares `anim: AnimId`. **When no clip is loaded — which is true for every move on day one — `sample()` synthesises a pose from `MoveDef.poseHint` and the move's phases** (wind-back → extend → settle), including `accSwing` on the accessory bones. So a punch reads as a punch with zero animation authoring. P1's `frame-lint` *hard-failed the build* on a missing clip, which means on day one both fighters T-pose through every attack and nothing ships.

### 15. Stage & camera
World X ∈ [0, 3600] (1.875 logical screens at 1920×1080), walls at ±90, ceiling 900, spawns 1620/1980. Camera: midpoint, zoom fit clamped [0.80, 1.30], critically-damped spring on the **render** clock, **zoom out twice as fast as in** (P3's detail — the difference between a camera that tracks and one that makes people seasick), vertical parallax at 0.4× horizontal, **clamp then shake** with a 64 px art bleed. First stage `socavon` — "Socavón al amanecer": sky / cordillera / sanctuary+headframe / crowd (bobs, excites on a kick) / wet cobbles with a 0.22 reflection strip / streamers.

### 16. Audio — convention over configuration, honouring CLAUDE.md
`public/audio/music/<musicId>.{webm,ogg,m4a,mp3}` — the user drops a file in and nothing else changes; missing file = silence + one console warning. `AudioBufferSourceNode` with data-driven `loopStart`/`loopEnd` (never `HTMLAudioElement` — its `loop` inserts an audible gap). Buses master→limiter, music via a **manual duck gain** (`setTargetAtTime`, not a keyed compressor — imprecise and untunable), sfx/hit/voice/foley/ambience. SFX fire at `ctx.currentTime`; we log `outputLatency` but don't compensate, because hitstop's 9–14 frame freeze gives the ear a 150–230 ms window. Audio is driven by the **event ring with a `confirmedFrame` watermark** (grafted from P3), so a rolled-back frame's sounds are discarded rather than double-fired — P1 listed this as unsolved.

### 17. Rollback readiness — pay the seam, not the feature
`step(state, in0, in1)` total and pure over a **576-word Int32Array**; snapshot is one 2.3 KB `.set()`; presentation never writes state; events are drained, not called. We ship an 8-deep snapshot ring used *only* by the determinism test, which **resimulates frames 1800–3599 and re-asserts the hash** — the only assertion in any proposal that catches state living outside the buffer. No transport, no prediction, no delay. Cost today: fixed point, a flat schema, an event ring.

**No code generator.** P1's `gen-state.ts` emitting a committed `state.gen.ts` is the one genuinely shared mutable file — two agents adding a fighter field both regenerate it and collide. The view classes are **hand-written once**, in one file, owned by one agent, with the fighter slot padded to 64 words so later fields never shift offsets.

**Interned integer ids everywhere** (`MoveId`, `AnimId`, `SfxId` as enums in the contract). P3's `stateId` was an interned index into a glob-ordered registry sitting *inside the hashed snapshot* — glob order isn't stable across filesystems, so its one determinism guard could diverge for reasons unrelated to the sim. An enum is stable by construction.

### 18. The CPU dummy — you cannot ship "they fight" with one keyboard (missing from all three)
`DummySource implements InputSource` with `STAND / BLOCK_ALL / CROUCH_BLOCK / JUMP / RANDOM_POKE / CPU_BASIC`, its own seeded xorshift so dummy matches replay exactly. ~80 lines, plugs into the seam we already have, doubles as the collision and hit-resolution test harness, and is the difference between "the engine works" and "the engine works, watch."

### 19. Roster — differentiation is frame data, and that is the honest axis
Two buttons and identical HP forces all identity onto reach, startup/active/recovery, walk/dash, jump arc, weight, pushbox width, and one signature property each. A Caporal all-rounder (best gatlings, bell-stomp run); B Morenada heavyweight (1 hit of armour on 5K f6–9, weight 78, gravity 1.22, widest pushbox); C Tinku rushdown (4f jab, 3-chain, lightest so juggles never drop him — Tinku *is* a ritual fist-fight, it would be perverse to make him anything else); D Tobas aerial (longest reach, highest arc, double jump, worst punishes); E Waka Waka trickster (2K and 5K share 11 identical animation frames — a true unreactable 50/50 built from two buttons); F Waka Waka Toro charge (armoured chargeable dash on `Cmd.CHARGE_B`, corner wall-bounce). **Accepted risk:** with no specials, if the frame data isn't authored with real care A–F read as palette swaps, and the only fix is slow iterative tuning.

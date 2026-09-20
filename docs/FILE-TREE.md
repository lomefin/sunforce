```
sunforce/
├── index.html                      EXISTS. canvas#game, #boot, #fatal-msg. Do not restructure.
├── package.json                    EXISTS. ADD devDeps: vitest, @resvg/resvg-js, eslint + plugins.
├── tsconfig.json                   EXISTS. strict, noUncheckedIndexedAccess, isolatedModules. Unchanged.
├── vite.config.ts                  EXISTS. '@' -> ./src. ADD: public/ passthrough only. No GLSL plugin needed.
├── CLAUDE.md                       EXISTS. Project rules. Unchanged.
├── eslint.config.js                NEW. THE WALL: bans Math/Date/performance/float-literals in src/sim/**,
│                                        and bans `>>` on fx values everywhere (mirror-safety).
│
├── assets/                         EXISTS. 23 Oruro reference photos. Never read at runtime.
├── concept/                        EXISTS. Art source of truth. Never read at runtime.
│   ├── caporal.svg                 char A. 640x960. ground cy=858, midline x=302, 8 clipPaths.
│   ├── caporal.png                 rendered reference only.
│   └── tobas.svg                   char D. 640x960. ground cy=857. ZERO clipPaths.
│
├── art/
│   ├── caporal.rig.json            owns: caporal group->bone bindings, pivots, CLIP RECTS, z, materials.
│   └── tobas.rig.json              owns: same for tobas. Needs no clip rects (nothing crosses the midline).
│
├── tools/
│   ├── bake-parts.mts              owns: SVG -> per-part crop + mat.png pass, via resvg-js. Applies clip rects.
│   ├── bake-atlas.mts              owns: MaxRects pack, premultiply, mips, parts.json. Pure, no SVG knowledge.
│   ├── rig-check.mts               owns: fails the build if any <g id> is neither mapped nor stripped.
│   └── gen-sin.mts                 owns: emits src/core/sin.gen.ts (1024-entry Int32 sine table).
│
├── public/
│   ├── audio/music/<musicId>.*     USER DROPS MUSIC HERE. Loader tries webm, ogg, m4a, mp3.
│   ├── audio/sfx/*.ogg             hit_light, hit_heavy, hit_ch, guard_*, whiff_*, land, bell, grab, ko...
│   ├── baked/<char>/atlas.png      GENERATED, gitignored. 2048^2 RGBA8 albedo.
│   ├── baked/<char>/mat.png        GENERATED. 1024^2. R=spec/sequin G=rim B=emissive A=paletteRow.
│   ├── baked/<char>/parts.json     GENERATED. AtlasManifest: uv, size, pivot, z, mesh, pre-sorted.
│   └── stages/socavon/layers/*.png sky, cordillera, sanctuary, crowd, cobbles, streamers. 64px bleed.
│
├── golden/replay-001.json          seed + 3600 frames of inputs + a state hash every 60 frames.
│
├── tests/
│   ├── fixed.test.ts               owns: fxMul/fxDiv exactness across the real operand range; TRUNC-TOWARD-ZERO
│   │                                     lock (asserts fxMul(-a,b) === -fxMul(a,b)) so nobody swaps in >>8.
│   ├── frames.test.ts              owns: runs validate() over every CompiledMove; asserts the derived
│   │                                     advantage table matches feelNumbers exactly.
│   ├── collision.test.ts           owns: AABB edges, corner push transfer, trade symmetry, strike-beats-throw.
│   ├── determinism.test.ts         owns: golden replay -> hash match, THEN resimulate 1800..3599 from the
│   │                                     snapshot ring and re-assert. The second assertion is the real test.
│   └── mirror.test.ts              owns: replay with players swapped and every x negated; asserts the hash
│                                         stream is the mirror. Catches slot-index tiebreaks and asymmetric
│                                         rounding. THE test no proposal had.
│
└── src/
    ├── main.ts                     owns: WIRING ONLY. canvas, GL, asset load, scene stack, loop start,
    │                                     #boot fade, #fatal handler. index.html already expects this file.
    │
    ├── core/
    │   ├── contracts.ts            owns: EVERY cross-module type. Written first, FROZEN. Zero imports.
    │   ├── fixed.ts                owns: fx/px/fxMul/fxDiv/fxAbs/fxSign/fxClamp/fxPct. Exactness comments.
    │   ├── sin.gen.ts              GENERATED + COMMITTED. 1024-entry Q16.16 sine table. Only generated file.
    │   ├── rng.ts                  owns: SimRng (xorshift32, seed lives IN the state) + CosmeticRng.
    │   ├── ring.ts                 owns: fixed-capacity zero-alloc ring helpers over typed arrays.
    │   ├── assert.ts               owns: dev-only invariants, stripped in prod.
    │   └── loop.ts                 owns: rAF accumulator, MAX_STEPS/MAX_DELTA guards, timeScale on the
    │                                     ACCUMULATOR, alpha, snapshot swap, LoopStats.
    │
    ├── sim/                        PURE. 576 int32 words. No DOM, no float, no allocation, no wall clock.
    │   ├── state.ts                owns: buffer alloc, FighterView/GlobalView (HAND-WRITTEN, not generated),
    │   │                                 createState, resetRound, snapshot/restore.
    │   ├── hash.ts                 owns: FNV-1a hash + hashMirrored (the side-parity oracle).
    │   ├── step.ts                 owns: THE 13-PHASE FRAME ORDER. The most important file in the repo.
    │   ├── fighter.ts              owns: resolveTransitions (the ONLY transition owner), cancelMask,
    │   │                                 startAction (clears hitIdsUsed/usedCancels/chainDepth), advanceAction.
    │   ├── physics.ts              owns: gravity, friction, integrate, ground/wall clamp, pushbox separation
    │   │                                 with corner transfer and the mirror-safe equal-position rule.
    │   ├── collision.ts            owns: worldBox, integer AABB, gather() for hit AND throw, one snapshot.
    │   ├── hits.ts                 owns: freeze() pre-commit snapshot, block/counter/armor resolution,
    │   │                                 damage+stun proration, juggle, knockback, trades, KO.
    │   ├── throws.ts               owns: throwbox gather, strike-beats-throw, tech window, throw-vs-throw
    │   │                                 clash, THROW_HOLD/THROWN states, wakeup throw invuln.
    │   ├── commands.ts             owns: input ring -> Cmd bitmask (QCF/QCB/DP/charge). Works day one.
    │   ├── events.ts               owns: Ev codes, the in-state event ring, confirmedFrame watermark.
    │   └── round.ts                owns: timer, KO, round/match win, intro & victory sequencing.
    │
    ├── data/
    │   ├── compile.ts              owns: concept px -> FX world units; EXPANDS sparse timelines to dense
    │   │                                 per-frame arrays; derives startup/active/advHit/advBlock.
    │   ├── validate.ts             owns: damage in {50,100}; symmetric hitstop; blockPushX >= kbX;
    │   │                                 every compiled number an integer; ascending keyframes; no hitbox
    │   │                                 without a hurtbox on active frames; interpolatePose banned on
    │   │                                 states with hitboxes. Errors fail CI.
    │   ├── registry.ts             owns: DefRegistry assembly. Indexed by enum, never by glob order.
    │   ├── chars/common.ts         owns: shared normal templates + the shared stick rig proportions.
    │   ├── chars/a.ts              owns: A Caporal  — all-rounder, best gatlings, bell-stomp run  [PARALLEL]
    │   ├── chars/b.ts              owns: B Morenada — armor on 5K f6-9, weight 78, widest pushbox [PARALLEL]
    │   ├── chars/c.ts              owns: C Tinku    — 4f jab, 3-chain, lightest                   [PARALLEL]
    │   ├── chars/d.ts              owns: D Tobas    — longest reach, double jump, highest arc     [PARALLEL]
    │   ├── chars/e.ts              owns: E WakaWaka — 2K/5K share 11 anim frames: a true 50/50    [PARALLEL]
    │   ├── chars/f.ts              owns: F Toro     — charge dash w/ armor, corner wall-bounce    [PARALLEL]
    │   └── stages/socavon.ts       owns: 7 parallax layers, walls, light dir, musicId 'socavon'.
    │
    ├── input/
    │   ├── sources.ts              owns: InputSource + KeyboardSource + GamepadSource + ReplaySource.
    │   ├── keymap.ts               owns: event.code table for 2 local players, remap, localStorage.
    │   ├── buffer.ts               owns: live/sticky latch, THROW macro synthesis, ring push with the
    │   │                                 per-slot consume bits, edge derivation, buffered() queries.
    │   └── dummy.ts                owns: DummySource. STAND/BLOCK_ALL/CROUCH_BLOCK/JUMP/RANDOM_POKE/CPU_BASIC.
    │
    ├── gfx/
    │   ├── gl.ts                   owns: context creation, caps probe, DPR resize, letterbox, state cache.
    │   ├── programs.ts             owns: compile/link, uniform location cache, dev hot-reload.
    │   ├── batch.ts                owns: instanced quad writer, 24 floats/instance, flush per materialKey.
    │   ├── renderer.ts             owns: pass orchestration + the front-fighter z rule. ONLY caller of draw*.
    │   ├── camera.ts               owns: 2-fighter framing, asymmetric zoom, spring, CLAMP-THEN-SHAKE.
    │   ├── stage.ts                owns: parallax draw, haze grade, crowd bob + crowdExcite, reflection strip.
    │   ├── fx.ts                   owns: sparks/rings/dust/confetti/flash. Consumes events. CosmeticRng only.
    │   ├── post.ts                 owns: ONE fullscreen pass: bloom composite, chroma, vignette, filmic.
    │   ├── debugdraw.ts            owns: F1 box overlay (4 classes), F3 frame-data readout from the data.
    │   ├── skin/pose.ts            owns: PoseBuffer, 24-bone solve, BONE_PARENTS walk, jiggle springs.
    │   ├── skin/anim.ts            owns: AnimClip Int16 format, sampler, AND the PROCEDURAL poseHint
    │   │                                 fallback that keeps day-one moves from T-posing.
    │   ├── skin/stick.ts           owns: SkinStick — capsule SDF, taper, outline, palette, AND the
    │   │                                 posable ACCESSORY PROXIES.                          [PARALLEL]
    │   ├── skin/parts.ts           owns: SkinParts — baked atlas quads, grid5 soft meshes.    [PARALLEL]
    │   ├── skin/atlas.ts           owns: parts.json load, albedo+material texture upload, AtlasCache.
    │   └── shaders/*.ts            owns: GLSL as exported template literals (NOT .glsl files — avoids a
    │                                     build-config dependency for six parallel agents).
    │       ├── part.ts             part.vert/frag: flash, tint, palette LUT, rim from mat.G, sequin glint.
    │       ├── stick.ts            stick.vert/frag: line-segment SDF capsules, free AA, free outline.
    │       ├── stage.ts            parallax + haze grade + reflection distortion.
    │       ├── fx.ts               soft-additive sparks.
    │       └── post.ts             bright-pass composite, chroma, vignette, filmic curve.
    │
    ├── audio/
    │   ├── graph.ts                owns: AudioContext, bus tree, limiter, manual duck().
    │   ├── music.ts                owns: AudioBufferSourceNode, sample-accurate loopStart/loopEnd.
    │   ├── sfx.ts                  owns: SfxId -> file/bus/gain/pitch table, voice limiting, event consumer.
    │   └── load.ts                 owns: fetch + decodeAudioData, gesture unlock, the music.* extension probe.
    │
    ├── game/
    │   ├── scenes.ts               owns: Scene interface + stack. Title / Select / Match / Results.
    │   ├── match.ts                owns: match flow, skin selection, dummy wiring, HUD feed.
    │   └── replay.ts               owns: record seed+input stream, playback, verify hash. Writes golden/.
    │
    ├── ui/
    │   ├── hud.ts                  owns: HP bars with damage-trail ghost, timer, round pips, combo counter.
    │   ├── select.ts               owns: 6-slot character select, 2 cursors, stage pick, costume auto-swap.
    │   ├── font.ts                 owns: bitmap font atlas renderer.
    │   └── debug.ts                owns: F1 boxes, F2 frame-step, F3 frame data + state hash, F5 skin toggle.
    │
    └── util/
        ├── math.ts                 owns: clamp/lerp/damp. RENDER-SIDE FLOAT ONLY. Never imported by src/sim.
        └── maxrects.ts             owns: rect packer, shared with tools/.
```

## LOCKED feel numbers

All frame counts are 60ths. All distances are **world units** (1 unit = 1 logical px at zoom 1.0 on a 1920×1080 viewport). Fighter height **378**. `ONE = 256` FX per world unit.

### The one formula everything derives from
Hitstop is **symmetric**, so it cancels out and frame advantage is arithmetic, not assertion:
```
adv = stun − (totalFrames − 1 − firstActiveFrame)
```
This is why `hitstopAtk = hitstopDef − 2` is rejected: it silently offsets every move by +2 from what its own frame data reads, and leaves the trade case (a fighter owed two different hitstops) undefined.

### Per-hit-type table (baseline = character A)
| | Punch (50) | Kick (100) | Throw (100) |
|---|---|---|---|
| hitstop, both parties | **9** | **14** | 12 |
| hitstop on block | 7 | 10 | — |
| counter-hit hitstop bonus | +4 | +4 | — |
| hitstun | **16** | **21** | knockdown |
| counter-hit hitstun bonus | +6 | +8 | — |
| blockstun | **11** | **14** | unblockable |
| counter-hit damage | ×1.25 | ×1.25 | ×1.0 |
| knockback on hit (u/f) | 2.4 | 4.6 | 3.0 x / 5.5 y |
| **pushback on block (u/f)** | **3.0** | **5.2** | — |
| attacker self-push on block | 1.0 | 2.2 | — |
| juggle cost / limit | 1 / 5 | 2 / 3 | ends combo |
| screen shake | 5 px / 7 f | 12 px / 11 f | 8 px / 9 f |
| zoom punch | — | ×1.035 over 12 f | — |
| chromatic aberration | 0 | 3.5 px over 8 f | 0 |
| hit flash | white f0–2, red ramp 6 f | white f0–2, red ramp 6 f | white f0–2 |
| defender render shake | ±2 px, flip/frame | ±3.5 px, flip/frame | — |

**`blockPushX > kbX` on both buttons is the single most important line here.** Blockstrings push you out and end; confirmed hits keep you close and combo. That one inequality creates the entire offence/defence loop — and it is also exactly why throws must exist, or the correct play is to hold back forever.

### Frame data — character A (verified arithmetically)
| move | total | active | recovery | on block | on hit | reach (u) | guard |
|---|---|---|---|---|---|---|---|
| 5P | 17 | 5–7 | 9 | **0** | +5 | 92 | mid |
| 5K | 29 | 9–12 | 16 | **−5** | +2 | 119 | mid |
| 2P | 15 | 4–6 | 8 | +1 | +6 | 78 | mid |
| 2K | 23 | 7–9 | 13 | −1 | hard knockdown | 104 | **low** |
| j.P | 14 | 4–8 | 5 | +2 | +7 | 84 | air |
| j.K | 22 | 7–12 | 9 | 0 | +7 | 108 | air |
| throw (P+K) | 22 | 3–5 | 16 | — | 100 + hard kd | 63 | unblockable |

Punch is neutral-to-plus on block: you keep your turn. Kick is −5: you gambled. Two buttons, and there is already real rock-paper-scissors before a single special exists.

### Movement — character A
| | value |
|---|---|
| walk forward | 4.0 u/f (240 u/s) |
| walk back | 3.4 u/f |
| dash | true run, 9.0 u/f, 20 f min |
| back dash | 8.0 u/f, 22 f, invuln f1–5 |
| ground friction | ×0.84 / frame |

### Jump arc (verified by integration)
| | value |
|---|---|
| jump squat | 4 f |
| initial vY | 24.2 u/f |
| gravity | 1.10 u/f² |
| **airborne** | **45 f** |
| **apex** | **278 u** (0.74 character heights) |
| landing recovery | 3 f |
| **total cycle** | **52 f** |
| air drift fwd / back | 5.0 / 4.4 u/f |

### Proration — hit #1 is always full
`DAMAGE_SCALE = [100, 80, 70, 60, 50, 42, 36, 32, 30]`, floor 30, min 10 damage.
So **"a connected punch takes 50" is literally true for every non-combo hit.**

| combo | damage | % of 1000 | confirms to KO |
|---|---|---|---|
| P | 50 | 5% | 20 |
| K | 100 | 10% | 10 |
| P>K | 130 | 13% | 7.7 |
| P>P>K | **160** | 16% | **6.2** |
| K>K | 180 | 18% | 5.6 |
| P>P>K>K | 220 | 22% | 4.5 |

→ **4.5–6 clean confirms per round, ~40 s rounds.** Timer 99 s, first to 2 of 3. Neither the 10-kick slog nor an infinite.

**Hitstun proration is a separate, gentler table** — `STUN_SCALE = [100,100,94,88,82,76,72,68,64]`, floor 64. Coupling hitstun to the damage table gives 9 frames of hitstun on a jab by hit 5 and drops every route.

**Juggle:** `gravityMul += 10%` per air hit, capped 180%. Past a hit's `juggleLimit` it whiffs entirely with a distinct `JUGGLE_DENY` tick, so the player learns the rule instead of being confused by it.

### Knockback, corner, knockdown
| | value |
|---|---|
| knockback decay | ×0.88/frame, **truncated toward zero** (mirror-safe) |
| pushbox separation cap | 6 u/frame (3 airborne) |
| air-vs-air pushboxes | **disabled** (so juggled opponents aren't shoved out of combos) |
| corner | separation and blocked pushback **transfer to the attacker** — this is what makes cornering stick, and what stops infinite corner blockstrings |
| wall | hard at 90 u from each stage edge; `Rx.WALL_BOUNCE` inverts vX at 60% + 12 f untechable |
| hard knockdown | 26 f down + 14 f wakeup, **throw-invulnerable wakeup f0–3** |
| throw tech window | 3 f |

### Stage & camera
| | value |
|---|---|
| stage width | 3600 u (1.875 logical screens) |
| walls | x = 90 and x = 3510 |
| round-start positions | 1620 / 1980 (360 apart) |
| ceiling | 900 u |
| camera zoom | clamp [0.80, 1.30], **zoom out 2× faster than in** |
| camera margin | 260 u, spring ω = 12 (x) / 9 (zoom) / 14 (y) |
| vertical parallax | 0.4 × horizontal |
| shake | applied **after** the wall clamp; stage art carries 64 px bleed |
| KO | timeScale 30% for 45 f, zoom ×1.25 over 12 f, music ducks to 0.35 |

### Impact ranking — what actually sells a hit, in order
1. **Hitstop.** 9 and 14 frames of absolute stillness *while the world keeps moving*. Never smooth it, never interpolate through it, never freeze the camera with it. This is 90% of impact.
2. **Counter-hit feedback.** +4 hitstop, +6/+8 hitstun, ×1.25 damage, purple-white spark, "CH" on screen. Cheapest readability win in the genre.
3. **Spark spawns at the centroid of hitbox ∩ hurtbox**, never at the attacker's hand. Almost every amateur fighting game gets this wrong and it is most of what makes a hit look *connected*.
4. **Defender render shake** ±2/±3.5 px, sign flipping every frame, during hitstop. Presentation only, costs nothing, sells everything.
5. **Hit flash** white for 2 frames then red ramp over 6.
6. **Directional screen shake** along the knockback normal, decay `(1−t)^1.6`.
7. **Zoom punch + chromatic aberration on kicks only.** Reserve them so they stay special.
8. **Audio ducking** to 0.55 for 120 ms on a kick. A hit the music buries doesn't land.
9. **Bells.** Character A's costume has them — every landing and dash start gets a bell layer. Free character identity, straight out of the reference photos.

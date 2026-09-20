// =============================================================================
// SunForce — src/data/registry.ts
// DefRegistry assembly. The one place the game learns what exists.
//
// Two rules, both from ENGINE-DECISIONS §17:
//
//   1. INDEXED BY ENUM, NEVER BY GLOB ORDER. Nothing here scans a directory.
//      CharId and StageId are the index, the arrays below are hand-listed, and
//      compile() asserts that no id is claimed twice. A registry built by glob
//      is not stable across filesystems, and the sim hashes ids.
//
//   2. COMPILED ONCE, AT LOAD, NEVER AGAIN. compile() is the authoring seam;
//      after REGISTRY exists, nothing in src/sim has ever seen a CharDef.
//
// Adding a character is ONE LINE: import it and put it in CHAR_DEFS. Every
// derived list below (selectable ids, counts, the select-screen cursor) falls
// out of that array, so there is no second place to forget.
// =============================================================================

import { assertDefined } from '@/core/assert';
import { CharId, StageId } from '@/core/contracts';
import type {
  CharDef, CompiledChar, CompiledMove, DefRegistry, MoveId, StageDef,
} from '@/core/contracts';
import { compile } from '@/data/compile';

import { CHAR_A } from '@/data/chars/a';
import { CHAR_B } from '@/data/chars/b';
import { CHAR_C } from '@/data/chars/c';
import { CHAR_D } from '@/data/chars/d';
import { CHAR_E } from '@/data/chars/e';
import { CHAR_F } from '@/data/chars/f';
import { STAGE_1 } from '@/data/stages/stage-1';

// -----------------------------------------------------------------------------
// THE ROSTER. All six are live. B–F are currently COPIES of A — identical
// looks, identical frame data — because the six characters are meant to look
// alike and differentiate by frame data, which is not yet tuned per slot.
// Order in this array is presentation order on the select screen. It is NOT the
// index — CharId is — so reordering it can never change a replay.
// -----------------------------------------------------------------------------

export const CHAR_DEFS: readonly CharDef[] = [
  CHAR_A, CHAR_B, CHAR_C, CHAR_D, CHAR_E, CHAR_F,
];

export const STAGE_DEFS: readonly StageDef[] = [
  STAGE_1,
];

// -----------------------------------------------------------------------------
// BUILDER. Takes explicit lists so tests can compile a two-character registry,
// or a single hand-built fixture, without touching the shipped roster.
// -----------------------------------------------------------------------------

/**
 * Compile a registry from authoring defs. Pure: no module state, no caching,
 * safe to call as often as a test likes.
 *
 * Validation is NOT run here. data/validate.ts owns that and runs in CI and in
 * the dev server over the finished registry, because a validator that only ever
 * sees the shipped roster cannot check a fixture.
 */
export const buildRegistry = (
  chars: readonly CharDef[] = CHAR_DEFS,
  stages: readonly StageDef[] = STAGE_DEFS,
): DefRegistry => compile(chars, stages);

/**
 * The shipped registry. Built at module load, shared by everything: the sim
 * gets it through createState, the renderer reads pushboxes and anim ids off
 * it, the select screen reads names. Frozen in the sense that matters — every
 * type inside it is deeply readonly.
 */
export const REGISTRY: DefRegistry = buildRegistry();

// -----------------------------------------------------------------------------
// SELECTION. Both players pick from the same list; in M0 that list is [A], so
// both of them are A and the select screen is a formality — but the cursor
// arithmetic below is already correct for six, so nothing changes when B lands.
// -----------------------------------------------------------------------------

/** CharIds that have a compiled character behind them, in roster order. */
export const SELECTABLE_CHARS: readonly CharId[] = CHAR_DEFS.map((c) => c.id);

/** StageIds with a StageDef behind them, in listing order. */
export const SELECTABLE_STAGES: readonly StageId[] = STAGE_DEFS.map((s) => s.id);

export const DEFAULT_CHAR: CharId = CharId.A;
export const DEFAULT_STAGE: StageId = StageId.STAGE_1;

/**
 * Move a select cursor by `delta` slots with wraparound, returning a CharId
 * that is guaranteed to exist. With one character on the roster this is the
 * identity, which is exactly right: the cursor cannot land on nothing.
 */
export const cycleChar = (id: CharId, delta: number): CharId => {
  const n = SELECTABLE_CHARS.length;
  if (n === 0) return DEFAULT_CHAR;
  const at = SELECTABLE_CHARS.indexOf(id);
  const from = at < 0 ? 0 : at;
  // JS % keeps the sign of the dividend, so bias into [0, n) before the second.
  const next = (((from + delta) % n) + n) % n;
  return SELECTABLE_CHARS[next]!;
};

/** Does this id have a compiled character? Guards a replay or a saved choice. */
export const isSelectableChar = (id: CharId): boolean =>
  SELECTABLE_CHARS.includes(id);

/** Does this id have a stage? Same job for a replay's stage field. */
export const isSelectableStage = (id: StageId): boolean =>
  SELECTABLE_STAGES.includes(id);

/**
 * Coerce an untrusted CharId (replay file, localStorage, URL param) to one that
 * exists. Loading a replay recorded against a roster we no longer have must
 * fall back, not crash — and must NOT silently change a match already running,
 * which is why this is a pure function the caller applies before createState.
 */
export const coerceChar = (id: CharId): CharId =>
  isSelectableChar(id) ? id : DEFAULT_CHAR;

export const coerceStage = (id: StageId): StageId =>
  isSelectableStage(id) ? id : DEFAULT_STAGE;

// -----------------------------------------------------------------------------
// LOOKUPS. sim/state.ts has its own charOf/stageOf that go through SimState;
// these are for the code that has a registry and an id but no match running —
// the select screen, the loader, the frame-data overlay, tests.
// -----------------------------------------------------------------------------

export const charById = (r: DefRegistry, id: CharId): CompiledChar =>
  assertDefined(r.chars[id], `data/registry: no compiled character for CharId ${id}`);

export const stageById = (r: DefRegistry, id: StageId): StageDef =>
  assertDefined(r.stages[id], `data/registry: no stage for StageId ${id}`);

export const moveById = (r: DefRegistry, id: MoveId): CompiledMove =>
  assertDefined(r.moves[id], `data/registry: no compiled move for MoveId ${id}`);

/** The move exists on the roster, without asserting. For the debug overlay. */
export const tryMoveById = (r: DefRegistry, id: MoveId): CompiledMove | null =>
  r.moves[id] ?? null;

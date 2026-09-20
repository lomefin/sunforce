// =============================================================================
// SunForce — src/input/keymap.ts
// The BINDING TABLES. One place knows that `KeyJ` is P1's punch; nothing else
// in the codebase ever sees a `KeyboardEvent.code` string.
//
// TWO PLAYERS, ONE KEYBOARD, ZERO SPECIAL CASES
//   A KeyMap is a flat `code -> [player, bit]` table covering BOTH players, so
//   the DOM listener in input/sources.ts is a single lookup with no per-player
//   branch and no possibility of one player's binding shadowing the other's.
//   A duplicate `code` is impossible by construction: it is an object key.
//
// WHY GAMEPADS DROP IN WITHOUT A REWRITE
//   The whole input stack downstream of this file speaks ONE currency: a
//   `ButtonMask` of `B.*` bits with ABSOLUTE directions. A device map is
//   therefore nothing but "device signal -> bit", and this file carries one per
//   device kind (`KeyMap` for the keyboard, `PadMap` for a Standard-Mapping
//   gamepad). Adding a device means adding a table and a source that reads it;
//   it never means touching the buffer, the sim, or a move's `input.button`.
//
// DIRECTIONS ARE ABSOLUTE HERE AND EVERYWHERE UPSTREAM OF THE SIM.
//   `KeyA` is LEFT, not BACK. The facing-relative conversion happens at READ
//   time in input/buffer.ts, which is what lets a recorded replay survive a
//   side swap (see ENGINE-DECISIONS §7).
// =============================================================================

import { B } from '@/core/contracts';
import type { ButtonMask, KeyMap, PlayerIx } from '@/core/contracts';
import { devWarn } from '@/core/assert';

// -----------------------------------------------------------------------------
// The bindable bits. `B.THROW` is deliberately ABSENT: it is a macro SYNTHESISED
// by input/buffer.ts from a P+K coincidence, never a raw device signal. Binding
// it directly would let a single key produce a throw the sim cannot attribute to
// two presses, and would make `THROW_MACRO_SLOP` untestable.
// -----------------------------------------------------------------------------

export interface ButtonInfo {
  readonly bit: number;
  /** Stable machine name, used by the remap UI and by the settings blob. */
  readonly name: string;
}

export const BUTTONS: readonly ButtonInfo[] = [
  { bit: B.U, name: 'up' },
  { bit: B.D, name: 'down' },
  { bit: B.L, name: 'left' },
  { bit: B.R, name: 'right' },
  { bit: B.P, name: 'punch' },
  { bit: B.K, name: 'kick' },
  { bit: B.G, name: 'guard' },
  { bit: B.TAUNT, name: 'taunt' },
  { bit: B.START, name: 'start' },
];

/** Every bit a device may legally produce. `B.THROW` is not one of them. */
export const BINDABLE_MASK: ButtonMask =
  B.U | B.D | B.L | B.R | B.P | B.K | B.G | B.TAUNT | B.START;

/** Directions only — handy for the sources' preventDefault rule. */
export const DIR_MASK: ButtonMask = B.U | B.D | B.L | B.R;

export const buttonName = (bit: number): string => {
  for (let i = 0; i < BUTTONS.length; i++) {
    const b = BUTTONS[i]!;
    if (b.bit === bit) return b.name;
  }
  return `0x${(bit >>> 0).toString(16)}`;
};

// -----------------------------------------------------------------------------
// KEYBOARD
//
// P1: WASD + R punch + T kick.   P2: arrows + I punch + O kick.
// NO NUMPAD ANYWHERE — these must work on a laptop / tenkeyless keyboard.
// Each player's attacks sit under the hand that is already on their movement
// keys: P1's R/T next to WASD, P2's I/O next to the arrows.
// The extras (guard, taunt, start) cost nothing and keep the table honest about
// what the contract's `B` set actually contains.
// -----------------------------------------------------------------------------

export const DEFAULT_KEYMAP: KeyMap = {
  // ---- player 1 — left hand: WASD to move, R/T to attack --------------------
  KeyW: [0, B.U],
  KeyS: [0, B.D],
  KeyA: [0, B.L],
  KeyD: [0, B.R],
  KeyR: [0, B.P],
  KeyT: [0, B.K],
  KeyG: [0, B.G],
  KeyQ: [0, B.TAUNT],
  Enter: [0, B.START],
  // ---- player 2 — right hand: arrows to move, I/O to attack ----------------
  ArrowUp: [1, B.U],
  ArrowDown: [1, B.D],
  ArrowLeft: [1, B.L],
  ArrowRight: [1, B.R],
  KeyI: [1, B.P],
  KeyO: [1, B.K],
  KeyP: [1, B.G],
  KeyL: [1, B.TAUNT],
  Backslash: [1, B.START],
};

/** `null` when the key is not bound — the caller must NOT swallow the event. */
export const lookupKey = (
  map: KeyMap, code: string,
): readonly [PlayerIx, number] | null => map[code] ?? null;

/** The code currently bound to one player's button, or `null`. */
export const bindingFor = (map: KeyMap, player: PlayerIx, bit: number): string | null => {
  for (const code of Object.keys(map)) {
    const e = map[code];
    if (e !== undefined && e[0] === player && e[1] === bit) return code;
  }
  return null;
};

/**
 * Returns a NEW map with `code` bound to (player, bit). Any other code that was
 * bound to that same (player, bit) is dropped, and `code`'s previous meaning —
 * possibly the OTHER player's — is overwritten. Remapping is therefore always a
 * swap-free, duplicate-free operation, which is the only way a two-player
 * keyboard remap screen stays sane.
 */
export const rebind = (map: KeyMap, code: string, player: PlayerIx, bit: number): KeyMap => {
  const out: Record<string, readonly [PlayerIx, number]> = {};
  for (const k of Object.keys(map)) {
    const e = map[k];
    if (e === undefined) continue;
    if (k === code) continue;
    if (e[0] === player && e[1] === bit) continue;
    out[k] = e;
  }
  out[code] = [player, bit];
  return out;
};

/** Returns a NEW map with `code` unbound. */
export const unbind = (map: KeyMap, code: string): KeyMap => {
  const out: Record<string, readonly [PlayerIx, number]> = {};
  for (const k of Object.keys(map)) {
    const e = map[k];
    if (e === undefined || k === code) continue;
    out[k] = e;
  }
  return out;
};

// -----------------------------------------------------------------------------
// PERSISTENCE. Every access is wrapped: `localStorage` throws outright in a
// sandboxed iframe and in Safari private mode, and it does not exist at all
// under Node (vitest, the determinism harness). A settings read must never be
// the reason the game fails to boot.
// -----------------------------------------------------------------------------

export const KEYMAP_STORAGE_KEY = 'sunforce.keymap.v1';

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** Shape check for one deserialised entry. Junk is dropped, never trusted. */
const validEntry = (v: unknown): v is readonly [PlayerIx, number] => {
  if (!Array.isArray(v) || v.length !== 2) return false;
  const p: unknown = v[0];
  const bit: unknown = v[1];
  if (p !== 0 && p !== 1) return false;
  if (typeof bit !== 'number' || !Number.isInteger(bit) || bit === 0) return false;
  return (bit & ~BINDABLE_MASK) === 0;
};

/**
 * Parses a serialised map. Unknown keys and malformed entries are discarded
 * with a dev warning; if NOTHING survives, `fallback` is returned, so a
 * corrupted settings blob degrades to playable defaults instead of a dead
 * keyboard.
 */
export const parseKeyMap = (json: string, fallback: KeyMap = DEFAULT_KEYMAP): KeyMap => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    devWarn('input/keymap: stored keymap is not valid JSON; using defaults');
    return fallback;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    devWarn('input/keymap: stored keymap is not an object; using defaults');
    return fallback;
  }
  const src = raw as Record<string, unknown>;
  const out: Record<string, readonly [PlayerIx, number]> = {};
  let kept = 0;
  for (const code of Object.keys(src)) {
    const e = src[code];
    if (!validEntry(e)) {
      devWarn(`input/keymap: dropping malformed binding for "${code}"`);
      continue;
    }
    out[code] = [e[0], e[1]];
    kept++;
  }
  return kept === 0 ? fallback : out;
};

export const serializeKeyMap = (map: KeyMap): string => JSON.stringify(map);

/** Loads the persisted map, or `fallback` when there is none (the normal case). */
export const loadKeyMap = (fallback: KeyMap = DEFAULT_KEYMAP): KeyMap => {
  const s = storage();
  if (s === null) return fallback;
  let json: string | null = null;
  try {
    json = s.getItem(KEYMAP_STORAGE_KEY);
  } catch {
    return fallback;
  }
  return json === null ? fallback : parseKeyMap(json, fallback);
};

/** True if it was actually written. */
export const saveKeyMap = (map: KeyMap): boolean => {
  const s = storage();
  if (s === null) return false;
  try {
    s.setItem(KEYMAP_STORAGE_KEY, serializeKeyMap(map));
    return true;
  } catch {
    devWarn('input/keymap: could not persist the keymap');
    return false;
  }
};

export const clearStoredKeyMap = (): void => {
  const s = storage();
  if (s === null) return;
  try {
    s.removeItem(KEYMAP_STORAGE_KEY);
  } catch {
    // Nothing to do: the map simply stays where it was.
  }
};

// -----------------------------------------------------------------------------
// GAMEPAD — the table only. `GamepadSource` in input/sources.ts reads it.
//
// Indices are the W3C "standard" mapping, so any XInput-class pad works with no
// per-vendor table: 0 south, 1 east, 2 west, 3 north, 4/5 shoulders, 6/7
// triggers, 8 select, 9 start, 12..15 d-pad U/D/L/R, axes 0/1 = left stick.
// -----------------------------------------------------------------------------

export interface PadMap {
  /** Gamepad button index -> `B` bits. A value may carry several bits (macros). */
  readonly buttons: Readonly<Record<number, number>>;
  /** Left-stick index pair. */
  readonly axisX: number;
  readonly axisY: number;
  /** |axis| below this reads as centred. Presentation-side float; never in sim. */
  readonly deadzone: number;
  /** Also read buttons 12..15 as the d-pad. */
  readonly dpad: boolean;
}

export const DEFAULT_PAD_MAP: PadMap = {
  buttons: {
    0: B.P,             // south  — punch
    2: B.K,             // west   — kick
    1: B.G,             // east   — guard
    3: B.P | B.K,       // north  — throw macro: two REAL bits, so buffer.ts's
    //                     P+K coincidence rule synthesises B.THROW exactly as
    //                     it would for two fingers.
    4: B.P,
    5: B.K,
    6: B.G,
    7: B.G,
    9: B.START,
    8: B.TAUNT,
    12: B.U,
    13: B.D,
    14: B.L,
    15: B.R,
  },
  axisX: 0,
  axisY: 1,
  deadzone: 0.45,
  dpad: true,
};

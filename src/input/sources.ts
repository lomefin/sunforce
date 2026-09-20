// =============================================================================
// SunForce — src/input/sources.ts
// DEVICES -> ONE PER-FRAME MASK. Everything that can produce input implements
// the frozen `InputSource`: `poll(frame) -> ButtonMask`, absolute directions.
//
// THE SAMPLING RULE, WHICH IS THE WHOLE POINT OF THIS FILE
//   Sampling happens on the DOM EVENT; consumption happens on the SIM TICK.
//   A keydown at t=4 ms and its keyup at t=8 ms both fall between two 16.6 ms
//   ticks: polling `document.activeElement`-style "is it down now?" at tick time
//   would see nothing and the punch would never come out. The `StickyLatch` in
//   input/buffer.ts remembers "this went down since you last asked", so the tap
//   is reported for exactly one frame — which `ringPressEdge` then derives as a
//   one-frame press.
//
// ONE KEYBOARD, TWO PLAYERS
//   `KeyboardDevice` installs ONE pair of listeners for the whole keyboard and
//   fans each `event.code` out to the right player's latch through the KeyMap.
//   Two independent listeners would double-handle every event and would make a
//   shared key (a code bound for both players) ambiguous; here it is impossible,
//   because a code maps to exactly one (player, bit).
//
// NOTHING HERE TOUCHES THE STATE BUFFER. A source produces a mask; phase 1 of
// the frame order writes it into the ring. Keeping that seam means a replay
// source and a live keyboard are interchangeable with no other change.
// =============================================================================

import { B } from '@/core/contracts';
import type {
  ButtonMask, InputSource, KeyMap, PlayerIx, ReplayFile,
} from '@/core/contracts';
import { devWarn } from '@/core/assert';
import { StickyLatch } from '@/input/buffer';
import { DEFAULT_KEYMAP, DEFAULT_PAD_MAP, DIR_MASK, lookupKey } from '@/input/keymap';
import type { PadMap } from '@/input/keymap';

/** What a DOM source needs. `window` satisfies it; so does a test double. */
export interface EventHost {
  addEventListener(type: string, listener: (e: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: unknown): void;
}

const defaultHost = (): EventHost | null =>
  typeof window === 'undefined' ? null : (window as unknown as EventHost);

// -----------------------------------------------------------------------------
// KEYBOARD
// -----------------------------------------------------------------------------

export interface KeyboardOpts {
  readonly map?: KeyMap;
  readonly host?: EventHost | null;
  /**
   * Swallow the browser's default action for keys we own — arrows and space
   * scroll the page, and an unhandled Enter re-triggers whatever has focus.
   * Only BOUND keys are ever cancelled, so F5, F12 and ctrl-shortcuts survive.
   */
  readonly preventDefault?: boolean;
}

/**
 * The keyboard itself: one listener pair, one latch per player.
 * Create ONE of these per page. Hand each player a `KeyboardSource` view of it.
 */
export class KeyboardDevice {
  private map: KeyMap;
  private readonly host: EventHost | null;
  private readonly preventDefault: boolean;
  private readonly latches: readonly [StickyLatch, StickyLatch] =
    [new StickyLatch(), new StickyLatch()];
  private attached = false;

  constructor(opts: KeyboardOpts = {}) {
    this.map = opts.map ?? DEFAULT_KEYMAP;
    this.host = opts.host === undefined ? defaultHost() : opts.host;
    this.preventDefault = opts.preventDefault ?? true;
    if (this.host === null) {
      devWarn('input/sources: no DOM host; KeyboardDevice will report no input');
      return;
    }
    this.host.addEventListener('keydown', this.onKeyDown);
    this.host.addEventListener('keyup', this.onKeyUp);
    this.host.addEventListener('blur', this.onBlur);
    this.attached = true;
  }

  /** Live remap. Held keys are released so a rebound key cannot stick down. */
  setKeyMap(map: KeyMap): void {
    this.map = map;
    this.latches[0].releaseAll();
    this.latches[1].releaseAll();
  }

  keyMap(): KeyMap {
    return this.map;
  }

  /** One frame of input for one player. Consumes that player's sticky bits. */
  sample(p: PlayerIx): ButtonMask {
    return this.latches[p].sample();
  }

  /** A view of one player, for handing to the loop. */
  source(p: PlayerIx): InputSource {
    return new KeyboardSource(p, this);
  }

  dispose(): void {
    if (!this.attached || this.host === null) return;
    this.host.removeEventListener('keydown', this.onKeyDown);
    this.host.removeEventListener('keyup', this.onKeyUp);
    this.host.removeEventListener('blur', this.onBlur);
    this.attached = false;
    this.latches[0].reset();
    this.latches[1].reset();
  }

  // Arrow functions so `removeEventListener` gets the same reference back.
  private readonly onKeyDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    const hit = lookupKey(this.map, ke.code);
    if (hit === null) return;
    // A modifier chord belongs to the browser, not to the fighter.
    if (ke.ctrlKey || ke.metaKey || ke.altKey) return;
    this.latches[hit[0]].down(hit[1]);
    if (this.preventDefault && this.shouldCancel(hit[1])) e.preventDefault();
  };

  private readonly onKeyUp = (e: Event): void => {
    const ke = e as KeyboardEvent;
    const hit = lookupKey(this.map, ke.code);
    if (hit === null) return;
    this.latches[hit[0]].up(hit[1]);
    if (this.preventDefault && this.shouldCancel(hit[1])) e.preventDefault();
  };

  /** Alt-tab: the keyup never arrives, so nothing may stay held. */
  private readonly onBlur = (): void => {
    this.latches[0].releaseAll();
    this.latches[1].releaseAll();
  };

  private shouldCancel(bit: number): boolean {
    return (bit & (DIR_MASK | B.START)) !== 0;
  }
}

/** One player's view of a `KeyboardDevice`. */
export class KeyboardSource implements InputSource {
  private readonly device: KeyboardDevice;
  private readonly owned: boolean;
  private readonly ix: PlayerIx;

  /** Pass a shared `device` for local versus; omit it and this source owns one. */
  constructor(player: PlayerIx, device?: KeyboardDevice, opts: KeyboardOpts = {}) {
    this.ix = player;
    this.owned = device === undefined;
    this.device = device ?? new KeyboardDevice(opts);
  }

  poll(_frame: number): ButtonMask {
    return this.device.sample(this.ix);
  }

  /** Only tears down the device if this source created it. */
  dispose(): void {
    if (this.owned) this.device.dispose();
  }
}

/**
 * The local-versus wiring M0 boots with: one device, two sources.
 * Dispose the device when the match ends; the sources are views of it.
 */
export const keyboardPair = (
  opts: KeyboardOpts = {},
): { device: KeyboardDevice; sources: readonly [InputSource, InputSource] } => {
  const device = new KeyboardDevice(opts);
  return { device, sources: [device.source(0), device.source(1)] };
};

// -----------------------------------------------------------------------------
// GAMEPAD
//
// A pad has no events, so it is polled: `poll()` reads the live snapshot and
// pushes it through the same latch, which means a button that went down and up
// between two polls is still reported once. That is the best a polled device can
// do, and it keeps the semantics identical to the keyboard's.
// -----------------------------------------------------------------------------

export class GamepadSource implements InputSource {
  private readonly latch = new StickyLatch();
  private readonly padIndex: number;
  private readonly map: PadMap;
  private warned = false;

  constructor(padIndex: number, map: PadMap = DEFAULT_PAD_MAP) {
    this.padIndex = padIndex;
    this.map = map;
  }

  poll(_frame: number): ButtonMask {
    this.latch.setLive(this.read());
    return this.latch.sample();
  }

  dispose(): void {
    this.latch.reset();
  }

  /** True when the pad is present this instant. */
  connected(): boolean {
    return this.pad() !== null;
  }

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    const pads = navigator.getGamepads();
    return pads[this.padIndex] ?? null;
  }

  private read(): ButtonMask {
    const pad = this.pad();
    if (pad === null) {
      if (!this.warned) {
        devWarn(`input/sources: gamepad ${this.padIndex} is not connected`);
        this.warned = true;
      }
      return 0;
    }
    this.warned = false;

    let mask = 0;
    const buttons = pad.buttons;
    for (let i = 0; i < buttons.length; i++) {
      if (!this.map.dpad && i >= 12 && i <= 15) continue;
      const bits = this.map.buttons[i];
      if (bits === undefined) continue;
      const b = buttons[i];
      if (b !== undefined && b.pressed) mask |= bits;
    }

    const dz = this.map.deadzone;
    const ax = pad.axes[this.map.axisX] ?? 0;
    const ay = pad.axes[this.map.axisY] ?? 0;
    if (ax <= -dz) mask |= B.L;
    else if (ax >= dz) mask |= B.R;
    // Gamepad Y is positive DOWN; the game's U bit is up.
    if (ay <= -dz) mask |= B.U;
    else if (ay >= dz) mask |= B.D;

    // Opposite directions cannot both be true: SOCD resolves to neutral, which
    // is the only option that cannot be used to fake an impossible input.
    if ((mask & B.L) !== 0 && (mask & B.R) !== 0) mask &= ~(B.L | B.R);
    if ((mask & B.U) !== 0 && (mask & B.D) !== 0) mask &= ~(B.U | B.D);
    return mask;
  }
}

// -----------------------------------------------------------------------------
// REPLAY
//
// The determinism and mirror tests drive the sim through this, so it must be a
// pure function of the frame number: no latch, no clock, no state beyond the
// tape.
// -----------------------------------------------------------------------------

export interface ReplayOpts {
  /** Restart at frame 0 when the tape runs out. Default false. */
  readonly loop?: boolean;
  /** Repeat the last mask forever instead of going neutral. Default false. */
  readonly holdLast?: boolean;
}

export class ReplaySource implements InputSource {
  private readonly tape: readonly number[];
  private readonly loop: boolean;
  private readonly holdLast: boolean;

  constructor(tape: readonly number[], opts: ReplayOpts = {}) {
    this.tape = tape;
    this.loop = opts.loop ?? false;
    this.holdLast = opts.holdLast ?? false;
  }

  get length(): number {
    return this.tape.length;
  }

  poll(frame: number): ButtonMask {
    const n = this.tape.length;
    if (n === 0 || frame < 0) return 0;
    if (frame < n) return this.tape[frame]!;
    if (this.loop) return this.tape[frame % n]!;
    if (this.holdLast) return this.tape[n - 1]!;
    return 0;
  }

  dispose(): void {
    // Nothing to release: the tape is plain data owned by the caller.
  }
}

/** De-interleaves `ReplayFile.inputs` ([p0,p1,p0,p1,...]) into two sources. */
export const replayPair = (
  file: ReplayFile, opts: ReplayOpts = {},
): readonly [InputSource, InputSource] => {
  const src = file.inputs;
  const frames = src.length >> 1;
  const a: number[] = new Array<number>(frames);
  const b: number[] = new Array<number>(frames);
  for (let f = 0; f < frames; f++) {
    a[f] = src[f * 2] ?? 0;
    b[f] = src[f * 2 + 1] ?? 0;
  }
  return [new ReplaySource(a, opts), new ReplaySource(b, opts)];
};

/** Always neutral. Useful as a placeholder second player in a tool or a test. */
export class NullSource implements InputSource {
  poll(_frame: number): ButtonMask {
    return 0;
  }

  dispose(): void {
    // Nothing to release.
  }
}

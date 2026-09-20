// =============================================================================
// SunForce — src/core/assert.ts
// Dev-only invariants. Zero imports, zero allocation on the passing path.
//
// HOW IT IS COMPILED OUT
// `DEV` below is the single expression `import.meta.env.DEV` (the `as` casts
// erase to nothing, so that exact token survives into the emitted JS). Vite's
// define pass rewrites it to the literal `false` in a production build, every
// assert body becomes `if (!false) return;` -> `return;`, and the minifier drops
// both the call bodies and any message string that is a literal. In dev, in
// vitest, and in bare Node (where `import.meta.env` does not exist at all) it
// evaluates to `true` and the checks run.
//
// RULES
//   - Assertions state INVARIANTS, never control flow. Code must be correct
//     with every assert removed.
//   - Never put a side effect in an argument: `assert(pop() > 0, ...)` loses the
//     pop in production.
//   - Never assert in a per-frame sim hot loop (fxMul, AABB overlap, the ring
//     read). Assert at the seams: load, createState, resetRound, startAction.
// =============================================================================

/** True in dev, in tests, and anywhere `import.meta.env` is absent. */
export const DEV: boolean =
  (import.meta as unknown as { readonly env?: { readonly DEV?: boolean } }).env?.DEV !== false;

/** Thrown by every helper here, so a test can assert on the class. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/** Unconditional failure. Returns `never`, so it narrows exhaustive switches. */
export function fail(message: string): never {
  throw new AssertionError(message);
}

/** The workhorse. Narrows `cond` for the rest of the caller's scope. */
export function assert(cond: unknown, message: string): asserts cond {
  if (!DEV) return;
  if (!cond) throw new AssertionError(message);
}

/**
 * Asserts a value is a safe 32-bit integer. This is THE guard for the
 * simulation's "no floats past this line" rule: every number written into the
 * state buffer and every number produced by `src/data/compile.ts` must pass it.
 */
export function assertInt(v: number, where: string): void {
  if (!DEV) return;
  if (!Number.isInteger(v)) throw new AssertionError(`${where}: expected an integer, got ${v}`);
  if (v < -2147483648 || v > 2147483647) {
    throw new AssertionError(`${where}: ${v} does not fit in an Int32Array slot`);
  }
}

/** Inclusive range check. */
export function assertRange(v: number, lo: number, hi: number, where: string): void {
  if (!DEV) return;
  if (!(v >= lo && v <= hi)) {
    throw new AssertionError(`${where}: ${v} is outside [${lo}, ${hi}]`);
  }
}

/** Array/typed-array index bound check for the places that cannot use `!`. */
export function assertIndex(i: number, length: number, where: string): void {
  if (!DEV) return;
  if (!Number.isInteger(i) || i < 0 || i >= length) {
    throw new AssertionError(`${where}: index ${i} out of range [0, ${length})`);
  }
}

/** Narrows `T | null | undefined` to `T`. Use at load seams, not per frame. */
export function assertDefined<T>(v: T | null | undefined, where: string): T {
  if (DEV && (v === null || v === undefined)) {
    throw new AssertionError(`${where}: expected a value, got ${v === null ? 'null' : 'undefined'}`);
  }
  return v as T;
}

/** One-line dev diagnostic. Silent in production. */
export function devWarn(message: string): void {
  if (!DEV) return;
  console.warn(`[sunforce] ${message}`);
}

/**
 * Compile-time exhaustiveness guard:
 *   `default: return never(x, 'state');`
 * fails to typecheck the day someone adds an enum member and forgets a case.
 */
export function never(v: never, where: string): never {
  throw new AssertionError(`${where}: unhandled case ${String(v)}`);
}

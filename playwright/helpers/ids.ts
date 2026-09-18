/**
 * Drop-in replacement for `Date.now()` used purely as a uniqueness token
 * throughout these specs — embedded in phone numbers, device/customer
 * names, etc. via `String(uniqueNow()).slice(-N)`, exactly like the plain
 * `Date.now()` calls it replaces.
 *
 * Playwright runs spec files across multiple parallel worker processes.
 * Two workers (or two `beforeAll` blocks in the same file) that happen to
 * start within the same millisecond used to generate colliding trailing
 * digits with plain `Date.now()`, which surfaced as "duplicate phone" 400s
 * or cross-test data bleed. This instead returns a fixed-width digit
 * string whose low-order digits (the ones every call site actually slices
 * out) come from the worker index plus a large random component, so
 * collisions are astronomically unlikely regardless of timing.
 *
 * Returns a STRING (always exactly 11 digits: 2 worker + 9 random), not a
 * number — an earlier version returned `Number(...)`, which silently
 * strips leading zeros (worker 0 contributes nothing, and a small random
 * draw yields fewer than 9 digits), so `String(uniqueNow()).slice(-7)`
 * could come up short and produce malformed/too-short phone numbers. See
 * fixtures/test-data.js in the jest suite for the equivalent fix (its
 * ENTROPY constant is a string for the same reason) and full rationale.
 *
 * Callers must not do arithmetic on the result (e.g. `uniqueNow() + 1`) —
 * that would silently become string concatenation, not numeric addition.
 * Call uniqueNow() again instead; each call is independently unique.
 */
export function uniqueNow(): string {
  const worker = String(process.env.TEST_WORKER_INDEX ?? process.env.JEST_WORKER_ID ?? 0)
    .padStart(2, '0')
    .slice(-2);
  const rand = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');
  return `${worker}${rand}`;
}

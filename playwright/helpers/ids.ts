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
 * or cross-test data bleed. This instead returns a number whose low-order
 * digits (the ones every call site actually slices out) come from the
 * worker index plus a large random component, so collisions are
 * astronomically unlikely regardless of timing. See fixtures/test-data.js
 * in the jest suite for the equivalent fix and full rationale.
 */
export function uniqueNow(): number {
  const worker = String(process.env.TEST_WORKER_INDEX ?? process.env.JEST_WORKER_ID ?? 0)
    .padStart(2, '0')
    .slice(-2);
  const rand = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');
  return Number(`${worker}${rand}`);
}

/**
 * Self-check for playwright/helpers/ids.ts's uniqueNow().
 *
 * Regression coverage for a bug where uniqueNow() returned a `number`
 * (via `Number(...)`), which silently strips leading zeros — worker 0
 * contributed nothing to the string, and a small random draw produced
 * fewer than 9 digits, so `String(uniqueNow()).slice(-7)` could come up
 * short (or, combined with `runId + 1`-style arithmetic elsewhere,
 * malformed). uniqueNow() must always return a fixed-width, all-digit
 * string whose 2-digit worker prefix keeps parallel workers disjoint.
 *
 * Uniqueness within one worker is probabilistic (9 random digits), so the
 * no-duplicate checks use a realistic per-run volume (REALISTIC_CALLS).
 * At 5,000 draws the birthday bound gives a ~1.25% duplicate chance per
 * worker, which made the old 5,000-draw uniqueness assertions flaky.
 *
 * These tests call the pure function directly — no page/request fixture
 * is used, so no browser is launched for this file.
 */
import { test, expect } from './helpers/fixtures';
import { uniqueNow } from './helpers/ids';

const DIGITS_ONLY = /^\d{11}$/;
const ITERATIONS = 5_000;
// A full suite run generates on the order of a hundred ids per worker.
// Duplicate probability at 200 draws: ~200^2 / (2 * 10^9) = 0.002%.
const REALISTIC_CALLS = 200;

function generateMany(workerIndex: string, count: number): string[] {
  const prevWorker = process.env.TEST_WORKER_INDEX;
  process.env.TEST_WORKER_INDEX = workerIndex;
  try {
    const values: string[] = [];
    for (let i = 0; i < count; i++) values.push(uniqueNow());
    return values;
  } finally {
    if (prevWorker === undefined) delete process.env.TEST_WORKER_INDEX;
    else process.env.TEST_WORKER_INDEX = prevWorker;
  }
}

test.describe('uniqueNow() self-check', () => {
  test(`every value is an 11-digit, fixed-width string across ${ITERATIONS} calls on worker 0`, () => {
    const values = generateMany('0', ITERATIONS);
    for (const v of values) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(DIGITS_ONLY);
      expect(v.length).toBe(11);
      // The pattern every call site actually relies on: slicing off the
      // trailing N digits must always yield exactly N characters.
      expect(v.slice(-7)).toHaveLength(7);
      expect(v.slice(-8)).toHaveLength(8);
    }
  });

  test(`worker 0 produces no duplicates across ${REALISTIC_CALLS} calls`, () => {
    const values = generateMany('0', REALISTIC_CALLS);
    expect(new Set(values).size).toBe(values.length);
  });

  test(`worker 1 produces no duplicates across ${REALISTIC_CALLS} calls, and is fixed-width across ${ITERATIONS}`, () => {
    const sample = generateMany('1', REALISTIC_CALLS);
    expect(new Set(sample).size).toBe(sample.length);
    const values = generateMany('1', ITERATIONS);
    for (const v of values) {
      expect(v).toMatch(DIGITS_ONLY);
      expect(v.length).toBe(11);
    }
  });

  test('worker 0 and worker 1 pools never collide with each other', () => {
    // Deterministic: every id carries its worker index as a 2-digit prefix,
    // so the two pools are disjoint regardless of the random part.
    const worker0 = new Set(generateMany('0', ITERATIONS));
    const worker1 = generateMany('1', ITERATIONS);
    for (const v of worker0) expect(v.startsWith('00')).toBe(true);
    for (const v of worker1) {
      expect(v.startsWith('01')).toBe(true);
      expect(worker0.has(v)).toBe(false);
    }
  });

  test('an unset worker index (defaults to "0") is still fixed-width and collision-free', () => {
    const prevWorker = process.env.TEST_WORKER_INDEX;
    const prevJestWorker = process.env.JEST_WORKER_ID;
    delete process.env.TEST_WORKER_INDEX;
    delete process.env.JEST_WORKER_ID;
    try {
      const values: string[] = [];
      for (let i = 0; i < ITERATIONS; i++) values.push(uniqueNow());
      for (const v of values) expect(v).toMatch(DIGITS_ONLY);
      expect(values.every((v) => v.startsWith('00'))).toBe(true);
      const sample = values.slice(0, REALISTIC_CALLS);
      expect(new Set(sample).size).toBe(sample.length);
    } finally {
      if (prevWorker !== undefined) process.env.TEST_WORKER_INDEX = prevWorker;
      if (prevJestWorker !== undefined) process.env.JEST_WORKER_ID = prevJestWorker;
    }
  });
});

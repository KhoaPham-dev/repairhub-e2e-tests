/**
 * Self-check for playwright/helpers/ids.ts's uniqueNow().
 *
 * Regression coverage for a bug where uniqueNow() returned a `number`
 * (via `Number(...)`), which silently strips leading zeros — worker 0
 * contributed nothing to the string, and a small random draw produced
 * fewer than 9 digits, so `String(uniqueNow()).slice(-7)` could come up
 * short (or, combined with `runId + 1`-style arithmetic elsewhere,
 * malformed). uniqueNow() must always return a fixed-width, all-digit
 * string, and must never repeat across many calls — including across
 * different simulated worker indices, since parallel Playwright workers
 * must not collide with each other either.
 *
 * These tests call the pure function directly — no page/request fixture
 * is used, so no browser is launched for this file.
 */
import { test, expect } from './helpers/fixtures';
import { uniqueNow } from './helpers/ids';

const DIGITS_ONLY = /^\d{11}$/;
const ITERATIONS = 5_000;

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

  test(`worker 0 produces no duplicates across ${ITERATIONS} calls`, () => {
    const values = generateMany('0', ITERATIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  test(`worker 1 produces no duplicates across ${ITERATIONS} calls, and is fixed-width too`, () => {
    const values = generateMany('1', ITERATIONS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toMatch(DIGITS_ONLY);
      expect(v.length).toBe(11);
    }
  });

  test('worker 0 and worker 1 pools never collide with each other', () => {
    const worker0 = generateMany('0', ITERATIONS);
    const worker1 = generateMany('1', ITERATIONS);
    const combined = new Set([...worker0, ...worker1]);
    expect(combined.size).toBe(worker0.length + worker1.length);
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
      expect(new Set(values).size).toBe(values.length);
    } finally {
      if (prevWorker !== undefined) process.env.TEST_WORKER_INDEX = prevWorker;
      if (prevJestWorker !== undefined) process.env.JEST_WORKER_ID = prevJestWorker;
    }
  });
});

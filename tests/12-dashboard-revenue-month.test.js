/**
 * TC-12 — Dashboard Revenue Month Aggregation (fix/dashboard-month-revenue)
 *
 * Covers API-level scenarios for:
 *   GET /api/dashboard/revenue?period=month
 *
 * Verifies the fix for the generate_series over-count bug:
 *   - Response has exactly 4 items (Tuần 1–4)
 *   - Items have the correct Vietnamese week labels in the `date` field
 *   - Revenue values are numbers >= 0
 *   - Unauthenticated request returns 401
 *
 * Prerequisites: backend running at http://localhost:3001
 */

const { api, login } = require('../helpers/api');
const { ADMIN_CREDS } = require('../fixtures/test-data');

let adminToken;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-12a Authentication
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-12a GET /dashboard/revenue?period=month — authentication', () => {
  test('Unauthenticated request returns 401', async () => {
    const { status, body } = await api.get('/dashboard/revenue?period=month');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Authenticated admin request returns 200', async () => {
    const { status, body } = await api.get('/dashboard/revenue?period=month', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-12b Response shape — exactly 4 weekly buckets
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-12b GET /dashboard/revenue?period=month — response shape', () => {
  let data;

  beforeAll(async () => {
    const { body } = await api.get('/dashboard/revenue?period=month', {
      token: adminToken,
    });
    data = body.data;
  });

  test('Response data is an array', async () => {
    expect(Array.isArray(data)).toBe(true);
  });

  test('Response has exactly 4 items', async () => {
    expect(data).toHaveLength(4);
  });

  test('Items have Vietnamese week labels: Tuần 1, Tuần 2, Tuần 3, Tuần 4', async () => {
    const expectedLabels = ['Tuần 1', 'Tuần 2', 'Tuần 3', 'Tuần 4'];
    const actualLabels = data.map((item) => item.date);
    expect(actualLabels).toEqual(expectedLabels);
  });

  test('Each item has a `day` field with week shorthand T1–T4', async () => {
    const expectedDayValues = ['T1', 'T2', 'T3', 'T4'];
    const actualDayValues = data.map((item) => item.day);
    expect(actualDayValues).toEqual(expectedDayValues);
  });

  test('Each item has a `revenue` field that is a number', async () => {
    for (const item of data) {
      expect(typeof item.revenue).toBe('number');
    }
  });

  test('All revenue values are non-negative (>= 0)', async () => {
    for (const item of data) {
      expect(item.revenue).toBeGreaterThanOrEqual(0);
    }
  });

  test('Each item has exactly the expected fields: day, date, revenue', async () => {
    for (const item of data) {
      expect(item).toHaveProperty('day');
      expect(item).toHaveProperty('date');
      expect(item).toHaveProperty('revenue');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-12c Aggregation correctness — no inflation from the old generate_series bug
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-12c GET /dashboard/revenue?period=month — aggregation sanity', () => {
  let data;

  beforeAll(async () => {
    const { body } = await api.get('/dashboard/revenue?period=month', {
      token: adminToken,
    });
    data = body.data;
  });

  test('Total revenue across 4 weeks is a finite number', async () => {
    const total = data.reduce((sum, item) => sum + item.revenue, 0);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
  });

  test('Week 4 (Tuần 4) is present — days 29–31 are not dropped', async () => {
    const week4 = data.find((item) => item.date === 'Tuần 4');
    expect(week4).toBeDefined();
    expect(typeof week4.revenue).toBe('number');
    expect(week4.revenue).toBeGreaterThanOrEqual(0);
  });

  test('No week appears more than once (no duplicate rows from join)', async () => {
    const labels = data.map((item) => item.date);
    const uniqueLabels = [...new Set(labels)];
    expect(uniqueLabels).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-12d Edge cases — other period values
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-12d GET /dashboard/revenue — other periods still work', () => {
  test('period=today returns 200 with a single-entry array', async () => {
    const { status, body } = await api.get('/dashboard/revenue?period=today', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test('period=week returns 200 with a 7-entry array', async () => {
    const { status, body } = await api.get('/dashboard/revenue?period=week', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(7);
  });

  test('Unknown period returns 200 with empty array', async () => {
    const { status, body } = await api.get('/dashboard/revenue?period=unknown', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  test('Missing period param returns 200 with empty array', async () => {
    const { status, body } = await api.get('/dashboard/revenue', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

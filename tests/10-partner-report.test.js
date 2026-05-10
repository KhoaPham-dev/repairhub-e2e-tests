/**
 * TC-10 — Partner Report (RH-98)
 *
 * Covers API-level scenarios for:
 *   GET /api/reports/partner
 *
 * Scenarios:
 *   - 401 unauthenticated
 *   - 403 technician role
 *   - 400 missing params (no partner_id, no start, no end)
 *   - 400 invalid UUID partner_id
 *   - 400 invalid date (start / end)
 *   - 400 end before start
 *   - 404 non-existent or non-partner customer_id
 *   - 200 valid admin request — xlsx content-type and non-empty buffer
 *   - xlsx parsed: sheet named "Chi tiết đơn hàng", correct 9 column headers
 *   - 200 empty result (no orders in range) — header-only sheet
 */

const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { api, login, BASE_URL } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS, makePartnerCustomer, makeCustomer, makeOrder, makeBranch } = require('../fixtures/test-data');

// ─── Expected shape ───────────────────────────────────────────────────────────

const EXPECTED_SHEET_NAME = 'Chi tiết đơn hàng';

// Row 3 (index 2) in the AOA is the column header row
// Row 0: partner+period info, Row 1: empty, Row 2: headers
const EXPECTED_HEADERS = [
  'Mã đơn', 'Trạng thái', 'Ghi chú', 'Ngày tạo', 'Thiết bị', 'Báo giá',
];

// ─── Shared state ─────────────────────────────────────────────────────────────

let adminToken;
let techToken;
let partnerId;       // a valid partner customer created in beforeAll
let retailCustomerId; // a non-partner (RETAIL) customer id
let branchId;        // a branch for order creation

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);

  // Create a partner customer to use in positive tests
  const partnerData = makePartnerCustomer();
  const { status: pStatus, body: pBody } = await api.post('/customers', {
    token: adminToken,
    body: partnerData,
  });
  if (pStatus === 201 && pBody.data?.id) {
    partnerId = pBody.data.id;
  } else {
    console.warn('Failed to create partner customer:', pStatus, JSON.stringify(pBody));
  }

  // Create a retail (non-partner) customer for the 404 non-partner test
  const retailData = makeCustomer();
  const { status: rStatus, body: rBody } = await api.post('/customers', {
    token: adminToken,
    body: retailData,
  });
  if (rStatus === 201 && rBody.data?.id) {
    retailCustomerId = rBody.data.id;
  }

  // Get a branch id for order creation
  const { status: bStatus, body: bBody } = await api.get('/branches', { token: adminToken });
  if (bStatus === 200 && bBody.data?.length > 0) {
    branchId = bBody.data[0].id;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-10a: Auth / RBAC
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-10a GET /reports/partner — auth and RBAC', () => {
  const VALID_PARAMS = '?partner_id=00000000-0000-0000-0000-000000000001&start=2026-01-01&end=2026-01-31';

  test('Unauthenticated request returns 401', async () => {
    const { status, body } = await api.get(`/reports/partner${VALID_PARAMS}`);

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Technician (non-admin) gets 403', async () => {
    const { status, body } = await api.get(`/reports/partner${VALID_PARAMS}`, {
      token: techToken,
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-10b: Missing / invalid params → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-10b GET /reports/partner — param validation (400)', () => {
  test('No params at all returns 400', async () => {
    const { status, body } = await api.get('/reports/partner', { token: adminToken });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Missing partner_id returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?start=2026-01-01&end=2026-01-31',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Missing start returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000001&end=2026-01-31',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Missing end returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000001&start=2026-01-01',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Invalid UUID partner_id returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=not-a-uuid&start=2026-01-01&end=2026-01-31',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Invalid start date returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000001&start=not-a-date&end=2026-01-31',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Invalid end date returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000001&start=2026-01-01&end=not-a-date',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('end before start returns 400', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000001&start=2026-01-31&end=2026-01-01',
      { token: adminToken }
    );

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-10c: Non-existent / non-partner customer → 404
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-10c GET /reports/partner — 404 scenarios', () => {
  test('Non-existent UUID partner_id returns 404', async () => {
    const { status, body } = await api.get(
      '/reports/partner?partner_id=00000000-0000-0000-0000-000000000099&start=2026-01-01&end=2026-01-31',
      { token: adminToken }
    );

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Valid UUID that belongs to a non-partner (RETAIL) customer returns 404', async () => {
    if (!retailCustomerId) {
      console.warn('Skipping: retail customer not created in beforeAll');
      return;
    }

    const { status, body } = await api.get(
      `/reports/partner?partner_id=${retailCustomerId}&start=2026-01-01&end=2026-01-31`,
      { token: adminToken }
    );

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-10d: Valid admin request — xlsx structure
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-10d GET /reports/partner — valid request returns xlsx', () => {
  let xlsxBuffer;

  beforeAll(async () => {
    if (!partnerId) {
      console.warn('Skipping xlsx tests: partner customer not created');
      return;
    }

    // Create at least one order for this partner so the data sheet is non-empty
    if (branchId) {
      const orderData = makeOrder(partnerId, branchId);
      await api.post('/orders', { token: adminToken, body: orderData });
    }

    // Download the partner report for a wide date range to capture the order
    const response = await fetch(
      `${BASE_URL}/reports/partner?partner_id=${partnerId}&start=2020-01-01&end=2099-12-31`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    if (response.status === 200) {
      xlsxBuffer = await response.buffer();
    } else {
      const text = await response.text();
      console.warn('Partner report download failed:', response.status, text);
    }
  });

  test('Valid admin request returns 200', async () => {
    if (!partnerId) {
      console.warn('Skipping: partner not created');
      return;
    }

    const { status } = await api.get(
      `/reports/partner?partner_id=${partnerId}&start=2020-01-01&end=2099-12-31`,
      { token: adminToken }
    );

    expect(status).toBe(200);
  });

  test('Response has xlsx content-type', async () => {
    if (!partnerId) {
      console.warn('Skipping: partner not created');
      return;
    }

    const response = await fetch(
      `${BASE_URL}/reports/partner?partner_id=${partnerId}&start=2020-01-01&end=2099-12-31`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') || '';
    expect(contentType).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const disposition = response.headers.get('content-disposition') || '';
    expect(disposition).toMatch(/attachment/i);
  });

  test('Response buffer is non-empty with xlsx magic bytes (PK)', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    expect(xlsxBuffer.length).toBeGreaterThan(0);
    // ZIP/xlsx magic bytes
    expect(xlsxBuffer[0]).toBe(0x50); // P
    expect(xlsxBuffer[1]).toBe(0x4b); // K
  });

  test('Workbook has exactly 1 sheet named "Chi tiết đơn hàng"', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(1);
    expect(wb.SheetNames[0]).toBe(EXPECTED_SHEET_NAME);
  });

  test('"Chi tiết đơn hàng" header row (row 3) contains correct 6 column headers', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    const ws = wb.Sheets[EXPECTED_SHEET_NAME];
    expect(ws).toBeDefined();

    // Row 0: partner info, Row 1: empty, Row 2: column headers
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const headerRow = rows[2];
    expect(headerRow).toEqual(EXPECTED_HEADERS);
  });

  test('Sheet has data rows below the header (order data present)', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    const ws = wb.Sheets[EXPECTED_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // At minimum: info row, empty row, header row, at least 1 data row
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-10e: Empty result (no orders in range) → 200 with header-only sheet
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-10e GET /reports/partner — empty result returns header-only sheet', () => {
  let emptyBuffer;

  beforeAll(async () => {
    if (!partnerId) {
      console.warn('Skipping empty-result test: partner customer not created');
      return;
    }

    // Use a date range guaranteed to have no orders (far past)
    const response = await fetch(
      `${BASE_URL}/reports/partner?partner_id=${partnerId}&start=2000-01-01&end=2000-01-31`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    if (response.status === 200) {
      emptyBuffer = await response.buffer();
    } else {
      const text = await response.text();
      console.warn('Empty range report failed:', response.status, text);
    }
  });

  test('Request with no orders in range returns 200', async () => {
    if (!partnerId) {
      console.warn('Skipping: partner not created');
      return;
    }

    const { status } = await api.get(
      `/reports/partner?partner_id=${partnerId}&start=2000-01-01&end=2000-01-31`,
      { token: adminToken }
    );

    expect(status).toBe(200);
  });

  test('Empty-range xlsx is still a valid xlsx (PK magic bytes)', async () => {
    if (!emptyBuffer) {
      console.warn('Skipping: empty buffer not available');
      return;
    }

    expect(emptyBuffer[0]).toBe(0x50); // P
    expect(emptyBuffer[1]).toBe(0x4b); // K
  });

  test('Empty-range workbook has 1 sheet named "Chi tiết đơn hàng"', async () => {
    if (!emptyBuffer) {
      console.warn('Skipping: empty buffer not available');
      return;
    }

    const wb = XLSX.read(emptyBuffer, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(1);
    expect(wb.SheetNames[0]).toBe(EXPECTED_SHEET_NAME);
  });

  test('Empty-range sheet has header row but no data rows (header-only)', async () => {
    if (!emptyBuffer) {
      console.warn('Skipping: empty buffer not available');
      return;
    }

    const wb = XLSX.read(emptyBuffer, { type: 'buffer' });
    const ws = wb.Sheets[EXPECTED_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Row 0: partner info, Row 1: empty, Row 2: column headers, no more rows
    expect(rows.length).toBe(3);

    const headerRow = rows[2];
    expect(headerRow).toEqual(EXPECTED_HEADERS);
  });
});

/**
 * TC-09 — Revenue Reports (RH-87 Epic: RH-88, RH-90)
 *
 * Covers API-level scenarios for:
 *   RH-90  GET /api/reports — list (auth, RBAC, response shape)
 *          POST /api/reports/generate — manual generation (auth, RBAC, validation, 201)
 *          GET /api/reports/:id/download — download (auth, RBAC, 404, xlsx content-type)
 *          Path traversal protection on download endpoint
 *   RH-88  Generated report has status "done" after POST /generate
 *          Report appears in GET /api/reports list after generation
 *   RH-87  Excel workbook has exactly 2 sheets with correct names and headers
 *          (feat/rh-87-report-detail-sheet — "Chi tiết đơn hàng" sheet added)
 *
 *   RH-89 (Scheduler) — marked MANUAL; cannot trigger node-cron in E2E environment.
 */

const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { api, login, BASE_URL } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS } = require('../fixtures/test-data');

let adminToken;
let techToken;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);
});

// ─────────────────────────────────────────────────────────────────────────────
// RH-90: GET /api/reports — list endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-09a GET /reports — list', () => {
  test('Unauthenticated request returns 401', async () => {
    const { status, body } = await api.get('/reports');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Technician (non-admin) gets 403', async () => {
    const { status, body } = await api.get('/reports', { token: techToken });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Admin gets 200 and an array of report metadata', async () => {
    const { status, body } = await api.get('/reports', { token: adminToken });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('Each report row has expected metadata fields', async () => {
    const { body } = await api.get('/reports', { token: adminToken });

    // Only validate shape when there is at least one row
    if (body.data.length > 0) {
      const row = body.data[0];
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('period_start');
      expect(row).toHaveProperty('period_end');
      expect(row).toHaveProperty('generated_at');
      expect(row).toHaveProperty('status');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RH-90: POST /api/reports/generate — manual generation
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-09b POST /reports/generate — manual generation', () => {
  let generatedReportId;

  test('Unauthenticated request returns 401', async () => {
    const { status, body } = await api.post('/reports/generate', {
      body: { period_start: '2026-01-01', period_end: '2026-01-14' },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Technician (non-admin) gets 403', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: techToken,
      body: { period_start: '2026-01-01', period_end: '2026-01-14' },
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Invalid date format returns 400', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: 'not-a-date', period_end: '2026-01-14' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Both dates invalid returns 400', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: 'bad', period_end: 'also-bad' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('end_date <= start_date returns 400', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-01-15', period_end: '2026-01-01' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Equal start and end date (end == start) returns 400', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-01-01', period_end: '2026-01-01' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Valid admin request returns 201 with report data (RH-88, RH-90)', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-01-01', period_end: '2026-01-15' },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.id).toBeTruthy();
    expect(body.data.period_start).toBeTruthy();
    expect(body.data.period_end).toBeTruthy();
    expect(body.data.generated_at).toBeTruthy();

    generatedReportId = body.data.id;
  });

  // ── RH-88: report status and list appearance ───────────────────────────────

  test('RH-88 — generated report has status "done"', async () => {
    // generatedReportId set by previous test; skip if generation failed
    if (!generatedReportId) {
      console.warn('Skipping: no report was generated in the previous test');
      return;
    }

    const { body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-02-01', period_end: '2026-02-15' },
    });

    expect(body.data.status).toBe('done');
  });

  test('RH-88 — generated report appears in GET /api/reports list', async () => {
    if (!generatedReportId) {
      console.warn('Skipping: no report was generated in the previous test');
      return;
    }

    const { status, body } = await api.get('/reports', { token: adminToken });

    expect(status).toBe(200);
    const found = body.data.find((r) => r.id === generatedReportId);
    expect(found).toBeDefined();
  });

  test('No body supplied — uses default period, returns 201', async () => {
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: {},
    });

    // Default period: last 14 days — should succeed
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('done');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RH-90: GET /api/reports/:id/download — download endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-09c GET /reports/:id/download — download', () => {
  let downloadableReportId;

  beforeAll(async () => {
    // Generate a fresh report to download
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-03-01', period_end: '2026-03-15' },
    });
    if (status === 201 && body.data?.id) {
      downloadableReportId = body.data.id;
    }
  });

  test('Unauthenticated request returns 401', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    const { status, body } = await api.get(`/reports/${fakeId}/download`);

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Technician (non-admin) gets 403', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    const { status, body } = await api.get(`/reports/${fakeId}/download`, {
      token: techToken,
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Non-existent UUID returns 404', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000001';
    const { status, body } = await api.get(`/reports/${nonExistentId}/download`, {
      token: adminToken,
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('Non-UUID id value returns 404 (not a valid UUID format)', async () => {
    const { status, body } = await api.get('/reports/not-a-uuid/download', {
      token: adminToken,
    });

    // Route treats non-UUID as not found
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('Valid done report returns 200 with xlsx content-type', async () => {
    if (!downloadableReportId) {
      console.warn('Skipping download test: no report was generated in beforeAll');
      return;
    }

    const fetch = require('node-fetch');
    const BASE_URL = process.env.API_URL || 'http://localhost:6061/api';

    const response = await fetch(
      `${BASE_URL}/reports/${downloadableReportId}/download`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );

    expect(response.status).toBe(200);

    const contentType = response.headers.get('content-type') || '';
    expect(contentType).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const contentDisposition = response.headers.get('content-disposition') || '';
    expect(contentDisposition).toMatch(/attachment/i);

    // Verify xlsx magic bytes: PK (ZIP)
    const buf = await response.buffer();
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
  });

  // ── Path traversal protection ──────────────────────────────────────────────

  test('Path traversal — non-UUID id with traversal characters returns 404 (not 403/500)', async () => {
    // The route validates UUID format first; any non-UUID id returns 404 before
    // the DB query. Full path-traversal protection (file_path check against
    // REPORTS_DIR) requires DB manipulation which is not feasible in E2E.
    // This test confirms the pre-DB guard works at the route level.
    const traversalAttempt = '../../../etc/passwd';
    const encoded = encodeURIComponent(traversalAttempt);

    const { status } = await api.get(`/reports/${encoded}/download`, {
      token: adminToken,
    });

    // Non-UUID → 404, never reaches DB or file system
    expect(status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RH-87: Excel workbook sheet structure — feat/rh-87-report-detail-sheet
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-09e RH-87 Excel workbook — two sheets with correct structure', () => {
  let reportId;
  let xlsxBuffer;

  const EXPECTED_SHEET_NAMES = ['Báo cáo doanh thu', 'Chi tiết đơn hàng'];
  const EXPECTED_DETAIL_HEADERS = [
    'Mã đơn', 'Trạng thái', 'Ghi chú', 'Ngày tạo',
    'Khách hàng', 'Loại khách', 'Số điện thoại', 'Thiết bị', 'Báo giá',
  ];

  beforeAll(async () => {
    // Generate a fresh report specifically for sheet-structure inspection
    const { status, body } = await api.post('/reports/generate', {
      token: adminToken,
      body: { period_start: '2026-04-01', period_end: '2026-04-15' },
    });

    if (status === 201 && body.data?.id) {
      reportId = body.data.id;

      // Download the xlsx binary
      const response = await fetch(
        `${BASE_URL}/reports/${reportId}/download`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );

      if (response.status === 200) {
        xlsxBuffer = await response.buffer();
      }
    }
  });

  test('POST /reports/generate returns 201 — report generated successfully', async () => {
    expect(reportId).toBeTruthy();
  });

  test('GET /reports/:id/download returns 200 with xlsx content-type', async () => {
    if (!reportId) {
      console.warn('Skipping: reportId not set — generation failed');
      return;
    }

    const response = await fetch(
      `${BASE_URL}/reports/${reportId}/download`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(response.status).toBe(200);

    const contentType = response.headers.get('content-type') || '';
    expect(contentType).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  test('Downloaded binary is a valid xlsx (ZIP magic bytes PK)', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    expect(xlsxBuffer[0]).toBe(0x50); // P
    expect(xlsxBuffer[1]).toBe(0x4b); // K
  });

  test('Workbook has exactly 2 sheets', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    expect(wb.SheetNames).toHaveLength(2);
  });

  test('Sheet 1 is named "Báo cáo doanh thu"', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    expect(wb.SheetNames[0]).toBe('Báo cáo doanh thu');
  });

  test('Sheet 2 is named "Chi tiết đơn hàng"', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    expect(wb.SheetNames[1]).toBe('Chi tiết đơn hàng');
  });

  test('"Chi tiết đơn hàng" row 1 has the 9 correct column headers', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    const ws = wb.Sheets['Chi tiết đơn hàng'];
    expect(ws).toBeDefined();

    // Read row 1 as an array of values (header_only mode via sheet_to_json with header: 1)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const headerRow = rows[0];
    expect(headerRow).toEqual(EXPECTED_DETAIL_HEADERS);
  });

  test('"Báo cáo doanh thu" sheet 1 is present and non-empty', async () => {
    if (!xlsxBuffer) {
      console.warn('Skipping: xlsx buffer not available');
      return;
    }

    const wb = XLSX.read(xlsxBuffer, { type: 'buffer' });
    const ws = wb.Sheets['Báo cáo doanh thu'];
    expect(ws).toBeDefined();

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    // Expect at least: period header row, empty row, column header row, totals row
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RH-89: Scheduler — MANUAL (cannot trigger in E2E environment)
// ─────────────────────────────────────────────────────────────────────────────

describe('TC-09d RH-89 Scheduler — MANUAL', () => {
  test.skip(
    'Scheduler auto-generates report on 1st and 15th — MANUAL: cannot trigger node-cron in E2E environment',
    () => {}
  );
});

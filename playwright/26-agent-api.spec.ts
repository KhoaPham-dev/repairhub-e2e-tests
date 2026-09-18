/**
 * PW-26 — Agent API (/api/agent/*) — RH-149 / feat/RH-146-agent-api
 *
 * Covers SRS FR-17 (subsections 17A-17C) and NFR-08, and
 * api-contracts.md's "Agent API" section: a read-only, X-Agent-Key-gated,
 * PII-free API consumed exclusively by repairhub-mcp.
 *
 * Data seeding strategy: order_images.image_path and order_status_history
 * rows never need to reference a real uploaded file — the Agent API only
 * builds a URL string from image_path, it never touches disk. So every
 * fixture here is seeded by (a) creating the order via the normal staff
 * API, then (b) writing controlled `created_at` / `status` / media /
 * status-history rows DIRECTLY via E2E_DATABASE_URL — the only way to get
 * exact, arbitrary timestamps (the staff API always uses NOW()).
 *
 * Test groups:
 *   Auth: missing/wrong X-Agent-Key -> 401 on all 3 endpoints; a valid
 *         staff JWT alone does NOT grant access; correct key -> 200.
 *   PII:  a full response from all 3 endpoints never contains customer
 *         name/phone/address, serial_imei, accessories, status-history
 *         notes, or a staff name; fault_description masks phone/email.
 *   /orders: filters (date_from/date_to/status/product_type/has_media),
 *         pagination, 400s for invalid limit/offset, sort by created_at desc.
 *   /orders/:idOrCode: by id and by code; status_timeline field shape; 404.
 *   /featured: exact ranking/scores/reasons on a hand-computed fixture;
 *         variety guard + backfill; exclusions (status, no-media);
 *         activity rules (created/status-change/media count, notes-only
 *         doesn't); date-window edges; limit clamping; invalid date 400.
 *   Security (backend 9bf41c7 — NFR-08.4/08.5): fully-spaced phone digits
 *         are masked too; the failed-auth rate limiter 429s a bad key on a
 *         low-limit instance, and good-key traffic there is governed by
 *         the separate, much higher global limit, not the low one; a request
 *         produces one structured "[agent-api]" stdout line and the key
 *         is never logged (captured from a spawned throwaway instance).
 *   Disabled mode: a second backend instance started without
 *         AGENT_API_KEY/PUBLIC_MEDIA_BASE_URL -> every route 404.
 *
 * Prerequisites: backend running at http://localhost:6061 with
 *                AGENT_API_KEY=AGENT_API_KEY (below) and
 *                PUBLIC_MEDIA_BASE_URL=http://localhost:6061.
 */

import { test, expect } from './helpers/fixtures';
import { Client } from 'pg';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { uniqueNow } from './helpers/ids';
import { ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { AGENT_API_KEY } from './helpers/agentMcpConfig';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const AGENT_BASE = `${API_BASE}/agent`;

const PII_EXCLUDED_STRING_KEYS = [
  'customer_id', 'customer_name', 'customer_phone', 'customer_address', 'customer_type',
  'serial_imei', 'accessories', 'created_by', 'created_by_name', 'changed_by', 'changed_by_name', 'notes',
];

function agentHeaders(key: string = AGENT_API_KEY) {
  return { 'X-Agent-Key': key };
}

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  return (await res.json()).data.token as string;
}

async function dbConnect(): Promise<Client> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('E2E_DATABASE_URL must be set to run PW-26 (DB-seeded featured/PII fixtures)');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Spreads a large future range across concurrent/repeated runs so no two
 * invocations of this file ever pick the same VN calendar date. */
function uniqueFutureBaseDate(): string {
  const n = Number(uniqueNow());
  const dayOffset = n % 3650; // ~10 years
  const base = new Date('2099-01-01T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** ISO instant for an exact VN wall-clock time on a given YYYY-MM-DD date. */
function vnInstant(dateStr: string, hms: string): string {
  return `${dateStr}T${hms}+07:00`;
}

interface SeedResult {
  orderId: string;
  orderCode: string;
  customerId: string;
  branchId: string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  overrides: { product_type?: string; fault_description?: string } = {},
): Promise<SeedResult> {
  const runId = uniqueNow();
  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone: `090${runId.slice(-7)}`, name: `Khách PW-26 ${runId}`, type: 'RETAIL' },
  });
  const customerId = (await cRes.json()).data.id as string;
  const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: overrides.product_type ?? 'SPEAKER',
      device_name: `Loa PW-26-${runId}`,
      fault_description: overrides.fault_description ?? 'Loi nho',
      quotation: 0,
    },
  });
  const oBody = await oRes.json();
  return { orderId: oBody.data.id as string, orderCode: oBody.data.order_code as string, customerId, branchId };
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
}

async function insertMedia(
  db: Client,
  adminUserId: string,
  orderId: string,
  stage: 'INTAKE' | 'COMPLETION',
  kind: 'photo' | 'video',
  uploadedAtIso: string,
): Promise<void> {
  const ext = kind === 'video' ? '.mp4' : '.jpg';
  const imagePath = `agent-e2e-${uniqueNow()}${ext}`;
  await db.query(
    `INSERT INTO order_images (order_id, image_path, image_type, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, imagePath, stage, adminUserId, uploadedAtIso]
  );
}

async function setOrder(db: Client, orderId: string, fields: { status?: string; createdAtIso?: string; orderCodeSuffix?: string }): Promise<void> {
  if (fields.status !== undefined) {
    await db.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, fields.status]);
  }
  if (fields.createdAtIso !== undefined) {
    await db.query('UPDATE orders SET created_at = $2 WHERE id = $1', [orderId, fields.createdAtIso]);
  }
  if (fields.orderCodeSuffix !== undefined) {
    await db.query('UPDATE orders SET order_code = order_code || $2 WHERE id = $1', [orderId, fields.orderCodeSuffix]);
  }
}

async function insertStatusHistory(
  db: Client,
  adminUserId: string,
  orderId: string,
  oldStatus: string | null,
  newStatus: string,
  changedAtIso: string,
  notes: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO order_status_history (order_id, changed_by, old_status, new_status, notes, changed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, adminUserId, oldStatus, newStatus, notes, changedAtIso]
  );
}

/**
 * Spawns a throwaway repairhub-backend instance (ts-node, not nodemon — a
 * one-shot process, no watch/restart) with the given env overrides, and
 * captures every byte it writes to stdout/stderr into an in-memory buffer
 * for the caller to inspect (e.g. for the request-logging check). Resolves
 * once the server's own "running on port <port>" startup line appears.
 * Caller is responsible for killing the returned process.
 */
async function spawnBackendCapturingStdout(
  port: string,
  envOverrides: Record<string, string>,
): Promise<{ child: ChildProcessWithoutNullStreams; getOutput: () => string }> {
  const backendDir = path.join(__dirname, '..', '..', 'repairhub-backend');
  let output = '';
  const child = spawn('npx', ['ts-node', 'src/index.ts'], {
    cwd: backendDir,
    env: { ...process.env, PORT: port, ...envOverrides },
  });
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const deadline = Date.now() + 20_000;
  while (!output.includes(`running on port ${port}`)) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`backend on port ${port} did not start within 20s. Output so far:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, getOutput: () => output };
}

// ---------------------------------------------------------------------------

test.describe('PW-26 Agent API', () => {
  let staffToken: string;
  let db: Client;
  let adminUserId: string;

  test.beforeAll(async ({ request }) => {
    staffToken = await apiLogin(request);
    db = await dbConnect();
    const r = await db.query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [ADMIN_USER]);
    adminUserId = r.rows[0].id;
  });

  test.afterAll(async () => {
    await db.end();
  });

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  test.describe('auth', () => {
    const endpoints = [
      { name: 'GET /orders', path: '/orders' },
      { name: 'GET /orders/:idOrCode', path: '/orders/nonexistent-code' },
      { name: 'GET /featured', path: '/featured' },
    ];

    for (const ep of endpoints) {
      test(`${ep.name} — no X-Agent-Key -> 401`, async ({ request }) => {
        const res = await request.get(`${AGENT_BASE}${ep.path}`);
        expect(res.status()).toBe(401);
        const body = await res.json();
        expect(body).toEqual({ success: false, data: null, error: 'Unauthorized' });
      });

      test(`${ep.name} — wrong X-Agent-Key -> 401`, async ({ request }) => {
        const res = await request.get(`${AGENT_BASE}${ep.path}`, { headers: agentHeaders('not-the-real-key') });
        expect(res.status()).toBe(401);
      });

      test(`${ep.name} — a valid staff JWT alone does NOT grant access -> 401`, async ({ request }) => {
        const res = await request.get(`${AGENT_BASE}${ep.path}`, { headers: { Authorization: `Bearer ${staffToken}` } });
        expect(res.status()).toBe(401);
      });

      test(`${ep.name} — correct X-Agent-Key -> 200`, async ({ request }) => {
        const res = await request.get(`${AGENT_BASE}${ep.path}`, { headers: agentHeaders() });
        // /orders/:idOrCode with a made-up code is a 404 (auth already passed) — every
        // other path returns 200. Either way it must NOT be 401.
        expect(res.status()).not.toBe(401);
        expect([200, 404]).toContain(res.status());
      });
    }
  });

  // ---------------------------------------------------------------------
  // No PII
  // ---------------------------------------------------------------------

  test('PII: no excluded field or raw value appears anywhere in any of the 3 endpoints\' JSON', async ({ request }) => {
    const distinctiveName = `KHACHPIITEST-${uniqueNow()}`;
    const distinctivePhone = `098${uniqueNow().slice(-7)}`;
    const distinctiveAddress = `SO 123 DUONG PIITEST ${uniqueNow()}`;
    const distinctiveSerial = `SERIALPII${uniqueNow()}`;
    const distinctiveAccessories = `PHUKIENPII${uniqueNow()}`;
    const distinctiveNotes = `GHICHUNOIBOPII${uniqueNow()}`;
    const rawPhoneInFault = '0987654321';
    const rawEmailInFault = 'lienhe-pii-test@example.com';

    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: { phone: distinctivePhone, name: distinctiveName, address: distinctiveAddress, type: 'RETAIL' },
    });
    const customerId = (await cRes.json()).data.id as string;
    const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${staffToken}` } })).json()).data[0].id;

    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: {
        customer_id: customerId,
        branch_id: branchId,
        product_type: 'SPEAKER',
        device_name: `Loa PII ${uniqueNow()}`,
        serial_imei: distinctiveSerial,
        accessories: distinctiveAccessories,
        fault_description: `May khong len nguon, lien he ${rawPhoneInFault} hoac ${rawEmailInFault} de biet them`,
        quotation: 0,
      },
    });
    const orderId = (await oRes.json()).data.id as string;
    const orderCode = (await oRes.json()).data.order_code as string;

    // A status-history row with staff notes.
    await request.put(`${API_BASE}/orders/${orderId}/status`, {
      headers: { Authorization: `Bearer ${staffToken}` },
      data: { status: 'DANG_KIEM_TRA', notes: distinctiveNotes },
    });

    await insertMedia(db, adminUserId, orderId, 'INTAKE', 'photo', new Date().toISOString());

    const todayVn = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

    const [listRes, detailRes, featuredRes] = await Promise.all([
      request.get(`${AGENT_BASE}/orders?limit=100`, { headers: agentHeaders() }),
      request.get(`${AGENT_BASE}/orders/${orderId}`, { headers: agentHeaders() }),
      request.get(`${AGENT_BASE}/featured?date=${todayVn}&limit=20`, { headers: agentHeaders() }),
    ]);
    expect(listRes.status()).toBe(200);
    expect(detailRes.status()).toBe(200);
    expect(featuredRes.status()).toBe(200);

    const detailJson = await detailRes.json();
    const combined = JSON.stringify([await listRes.json(), detailJson, await featuredRes.json()]);

    for (const forbidden of [distinctiveName, distinctivePhone, distinctiveAddress, distinctiveSerial, distinctiveAccessories, distinctiveNotes, ADMIN_USER, customerId]) {
      expect(combined, `must not contain "${forbidden}"`).not.toContain(forbidden);
    }
    for (const key of PII_EXCLUDED_STRING_KEYS) {
      expect(combined, `must not contain the key "${key}"`).not.toContain(`"${key}"`);
    }
    expect(combined, 'raw phone from fault_description must not survive').not.toContain(rawPhoneInFault);
    expect(combined, 'raw email from fault_description must not survive').not.toContain(rawEmailInFault);

    expect(detailJson.data.fault_description).toContain('[đã ẩn]');
    expect(detailJson.data.order_code).toBe(orderCode);

    await cleanup(staffToken, request, customerId);
  });

  // ---------------------------------------------------------------------
  // GET /orders — filters, pagination, 400s, sort
  // ---------------------------------------------------------------------

  test.describe('/orders', () => {
    // Non-integers, and anything outside the documented 1-100 range —
    // including 0 below the minimum — must all be rejected. Fixed in
    // backend 9298595 (parseIntParam() previously had no lower bound, so
    // limit=0 silently fell through to a 200 with an empty items[]).
    test('invalid limit (non-integer, or outside the 1-100 range) -> 400', async ({ request }) => {
      for (const limit of ['0', '101', 'abc', '-1']) {
        const res = await request.get(`${AGENT_BASE}/orders?limit=${limit}`, { headers: agentHeaders() });
        expect(res.status(), `limit=${limit}`).toBe(400);
        expect((await res.json()).error).toBe('Invalid limit');
      }
    });

    test('invalid offset -> 400', async ({ request }) => {
      for (const offset of ['-1', 'abc']) {
        const res = await request.get(`${AGENT_BASE}/orders?offset=${offset}`, { headers: agentHeaders() });
        expect(res.status(), `offset=${offset}`).toBe(400);
        expect((await res.json()).error).toBe('Invalid offset');
      }
    });

    test('invalid date_from/date_to/status/product_type -> 400', async ({ request }) => {
      const cases: Array<[string, string]> = [
        ['date_from=not-a-date', 'Invalid date_from'],
        ['date_to=2026-13-40', 'Invalid date_to'],
        ['status=NOT_A_STATUS', 'Invalid status'],
        ['product_type=NOT_A_TYPE', 'Invalid product_type'],
      ];
      for (const [qs, expectedError] of cases) {
        const res = await request.get(`${AGENT_BASE}/orders?${qs}`, { headers: agentHeaders() });
        expect(res.status(), qs).toBe(400);
        expect((await res.json()).error).toBe(expectedError);
      }
    });

    test('filters (status, product_type, has_media) and pagination, sorted by created_at desc', async ({ request }) => {
      const tag = uniqueNow();
      const o1 = await seedOrder(staffToken, request, { product_type: 'HEADPHONE' });
      await new Promise((r) => setTimeout(r, 20));
      const o2 = await seedOrder(staffToken, request, { product_type: 'HEADPHONE' });
      await new Promise((r) => setTimeout(r, 20));
      const o3 = await seedOrder(staffToken, request, { product_type: 'HEADPHONE' });

      await request.put(`${API_BASE}/orders/${o2.orderId}/status`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: { status: 'DANG_KIEM_TRA', notes: `n${tag}` },
      });
      await insertMedia(db, adminUserId, o3.orderId, 'INTAKE', 'photo', new Date().toISOString());

      // Tag all 3 via device_name isn't filterable — use product_type + a
      // wide-enough limit and locate our 3 orders by id within the page.
      const listRes = await request.get(`${AGENT_BASE}/orders?product_type=HEADPHONE&limit=100`, { headers: agentHeaders() });
      expect(listRes.status()).toBe(200);
      const items = (await listRes.json()).data.items as Array<{ id: string; created_at: string; product_type: string }>;
      for (const it of items) expect(it.product_type).toBe('HEADPHONE');
      const ids = items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([o1.orderId, o2.orderId, o3.orderId]));

      // Sort: created_at strictly non-increasing across the whole page.
      for (let i = 1; i < items.length; i++) {
        expect(new Date(items[i - 1].created_at).getTime()).toBeGreaterThanOrEqual(new Date(items[i].created_at).getTime());
      }
      // o3 (created last) must come before o1 (created first) in the list.
      expect(ids.indexOf(o3.orderId)).toBeLessThan(ids.indexOf(o1.orderId));

      // status filter
      const statusRes = await request.get(`${AGENT_BASE}/orders?status=DANG_KIEM_TRA&limit=100`, { headers: agentHeaders() });
      const statusIds = (await (await statusRes).json()).data.items.map((i: { id: string }) => i.id);
      expect(statusIds).toContain(o2.orderId);
      expect(statusIds).not.toContain(o1.orderId);

      // has_media filter
      const mediaRes = await request.get(`${AGENT_BASE}/orders?has_media=true&limit=100`, { headers: agentHeaders() });
      const mediaIds = (await mediaRes.json()).data.items.map((i: { id: string }) => i.id);
      expect(mediaIds).toContain(o3.orderId);
      expect(mediaIds).not.toContain(o1.orderId);

      // pagination: total reflects the product_type-filtered count; limit=1 pages work
      const page0 = await (await request.get(`${AGENT_BASE}/orders?product_type=HEADPHONE&limit=1&offset=0`, { headers: agentHeaders() })).json();
      const page1 = await (await request.get(`${AGENT_BASE}/orders?product_type=HEADPHONE&limit=1&offset=1`, { headers: agentHeaders() })).json();
      expect(page0.data.items.length).toBe(1);
      expect(page1.data.items.length).toBe(1);
      expect(page0.data.items[0].id).not.toBe(page1.data.items[0].id);
      expect(page0.data.total).toBe(page1.data.total);
      expect(page0.data.total).toBeGreaterThanOrEqual(3);
      expect(page0.data.limit).toBe(1);
      expect(page1.data.offset).toBe(1);

      await cleanup(staffToken, request, o1.customerId);
      await cleanup(staffToken, request, o2.customerId);
      await cleanup(staffToken, request, o3.customerId);
    });
  });

  // ---------------------------------------------------------------------
  // GET /orders/:idOrCode
  // ---------------------------------------------------------------------

  test.describe('/orders/:idOrCode', () => {
    test('by id and by order_code return the same safe projection; status_timeline has only 3 fields; 404 for unknown', async ({ request }) => {
      const { orderId, orderCode, customerId } = await seedOrder(staffToken, request);
      await request.put(`${API_BASE}/orders/${orderId}/status`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: { status: 'DANG_KIEM_TRA', notes: 'n1' },
      });
      await request.put(`${API_BASE}/orders/${orderId}/status`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: { status: 'BAO_GIA', notes: 'n2' },
      });

      const byId = await (await request.get(`${AGENT_BASE}/orders/${orderId}`, { headers: agentHeaders() })).json();
      const byCode = await (await request.get(`${AGENT_BASE}/orders/${orderCode}`, { headers: agentHeaders() })).json();
      expect(byId.data).toEqual(byCode.data);
      expect(byId.data.order_code).toBe(orderCode);
      expect(byId.data.status).toBe('BAO_GIA');

      const timeline = byId.data.status_timeline as Array<Record<string, unknown>>;
      expect(timeline.length).toBeGreaterThanOrEqual(3); // TIEP_NHAN (initial) + 2 transitions
      for (const entry of timeline) {
        expect(Object.keys(entry).sort()).toEqual(['changed_at', 'new_status', 'old_status']);
      }

      // A non-existent, non-UUID-shaped code.
      const notFoundByCode = await request.get(`${AGENT_BASE}/orders/NONEXISTENT-CODE-${uniqueNow()}`, { headers: agentHeaders() });
      expect(notFoundByCode.status()).toBe(404);
      expect((await notFoundByCode.json()).error).toBe('Not found');

      // A well-formed but non-existent UUID — regression coverage for the
      // fix in backend 9298595 (previously 500'd: `id = $1 OR order_code =
      // $1` couldn't type-unify a uuid column and a varchar column across
      // the same parameter; now `id = $1::uuid OR order_code = $2`).
      const notFoundByUuid = await request.get(`${AGENT_BASE}/orders/00000000-0000-0000-0000-000000000000`, { headers: agentHeaders() });
      expect(notFoundByUuid.status(), 'a well-formed but non-existent UUID should 404, not 500').toBe(404);
      expect((await notFoundByUuid.json()).error).toBe('Not found');

      await cleanup(staffToken, request, customerId);
    });
  });

  // ---------------------------------------------------------------------
  // GET /featured
  // ---------------------------------------------------------------------

  test.describe('/featured', () => {
    test('invalid date -> 400', async ({ request }) => {
      const res = await request.get(`${AGENT_BASE}/featured?date=not-a-date`, { headers: agentHeaders() });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBe('Invalid date');
    });

    test('exact ranking, scores, reasons, variety guard, and backfill on a hand-computed fixture', async ({ request }) => {
      const D1 = uniqueFutureBaseDate();
      const createdAt = vnInstant(D1, '12:00:00');

      // Each entry: product_type, media stages/kinds, status, fault length,
      // hand-computed expected score/reasons. Created in this exact order so
      // ties (same score+mediaCount) break by ascending order_code, matching
      // creation sequence.
      const longFault = 'May bi hong loa nghiem trong can kiem tra va thay the linh kien moi';
      const plan = [
        { name: 'O-A', product_type: 'SPEAKER', media: [['INTAKE', 'photo'], ['COMPLETION', 'photo']], status: 'SUA_XONG', fault: 'Loi nho', score: 7, reasons: ['Có ảnh/video sau sửa', 'Có ảnh trước & sau', 'Đã sửa xong'] },
        { name: 'O-B', product_type: 'SPEAKER', media: [['COMPLETION', 'video']], status: 'SUA_XONG', fault: longFault, score: 7, reasons: ['Có ảnh/video sau sửa', 'Đã sửa xong', 'Có video', 'Mô tả lỗi chi tiết'] },
        { name: 'O-C', product_type: 'HEADPHONE', media: [['INTAKE', 'photo']], status: 'TIEP_NHAN', fault: 'Loi nho', score: 0, reasons: [] },
        { name: 'O-D', product_type: 'HEADPHONE', media: [['COMPLETION', 'photo']], status: 'SUA_XONG', fault: longFault, score: 6, reasons: ['Có ảnh/video sau sửa', 'Đã sửa xong', 'Mô tả lỗi chi tiết'] },
        { name: 'O-E', product_type: 'OTHER', media: [['INTAKE', 'photo'], ['COMPLETION', 'video']], status: 'DANG_SUA_CHUA', fault: 'Loi nho', score: 6, reasons: ['Có ảnh/video sau sửa', 'Có ảnh trước & sau', 'Có video'] },
        { name: 'O-F', product_type: 'SPEAKER', media: [['INTAKE', 'photo']], status: 'TIEP_NHAN', fault: 'Loi nho', score: 0, reasons: [] },
        { name: 'O-G', product_type: 'SPEAKER', media: [['COMPLETION', 'photo']], status: 'SUA_XONG', fault: 'Loi nho', score: 5, reasons: ['Có ảnh/video sau sửa', 'Đã sửa xong'] },
        { name: 'O-WARRANTY', product_type: 'OTHER', media: [['COMPLETION', 'photo']], status: 'SUA_XONG', fault: 'Loi nho', score: 4, reasons: ['Có ảnh/video sau sửa', 'Đã sửa xong', 'Đơn bảo hành'], warranty: true },
      ] as const;

      const seeded: Array<{ name: string; orderId: string; customerId: string; orderCode: string; mediaCount: number; score: number; reasons: readonly string[] }> = [];
      for (const p of plan) {
        const { orderId, orderCode, customerId } = await seedOrder(staffToken, request, { product_type: p.product_type, fault_description: p.fault });
        await setOrder(db, orderId, { status: p.status, createdAtIso: createdAt, ...(('warranty' in p && p.warranty) ? { orderCodeSuffix: '-BH' } : {}) });
        for (const [stage, kind] of p.media) {
          await insertMedia(db, adminUserId, orderId, stage as 'INTAKE' | 'COMPLETION', kind as 'photo' | 'video', createdAt);
        }
        seeded.push({ name: p.name, orderId, customerId, orderCode: ('warranty' in p && p.warranty) ? `${orderCode}-BH` : orderCode, mediaCount: p.media.length, score: p.score, reasons: p.reasons });
      }

      // Exclusions in the SAME window: HUY_TRA_MAY, TRA_HANG, and no-media —
      // none of these 3 should ever appear, and total_candidates must not count them.
      const excl1 = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, excl1.orderId, { status: 'HUY_TRA_MAY', createdAtIso: createdAt });
      await insertMedia(db, adminUserId, excl1.orderId, 'COMPLETION', 'photo', createdAt);

      const excl2 = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, excl2.orderId, { status: 'TRA_HANG', createdAtIso: createdAt });
      await insertMedia(db, adminUserId, excl2.orderId, 'COMPLETION', 'photo', createdAt);

      const excl3 = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, excl3.orderId, { status: 'SUA_XONG', createdAtIso: createdAt }); // no media at all

      // Expected pre-guard sort order (all latestActivity ties -> tie-break
      // by ascending order_code, which matches creation sequence since only
      // O-C/O-F actually tie on both score(0) and mediaCount(1)).
      const expectedPreGuardOrder = ['O-A', 'O-B', 'O-E', 'O-D', 'O-G', 'O-WARRANTY', 'O-C', 'O-F'];

      // limit=7: the variety guard (max 3 SPEAKER) must exclude the 4th
      // SPEAKER (O-F) — it is NOT backfilled because the capped list (7)
      // already meets the limit.
      const res7 = await request.get(`${AGENT_BASE}/featured?date=${D1}&limit=7`, { headers: agentHeaders() });
      expect(res7.status()).toBe(200);
      const body7 = await res7.json();
      expect(body7.data.date).toBe(D1);
      expect(body7.data.total_candidates, 'total_candidates counts before the guard/limit, excludes HUY_TRA_MAY/TRA_HANG/no-media').toBe(8);
      const codes7 = body7.data.orders.map((o: { order_code: string }) => o.order_code);
      expect(codes7).toEqual(expectedPreGuardOrder.slice(0, 7).map((n) => seeded.find((s) => s.name === n)!.orderCode));
      expect(codes7).not.toContain(seeded.find((s) => s.name === 'O-F')!.orderCode);

      for (const order of body7.data.orders) {
        const expected = seeded.find((s) => s.orderCode === order.order_code)!;
        expect(order.score, expected.name).toBe(expected.score);
        expect(order.reasons, expected.name).toEqual(expected.reasons);
      }

      // limit=8 (or above): the capped list (7) is now shorter than the
      // limit, so O-F is backfilled back in at the end (original sort order).
      const res8 = await request.get(`${AGENT_BASE}/featured?date=${D1}&limit=8`, { headers: agentHeaders() });
      const body8 = await res8.json();
      expect(body8.data.total_candidates).toBe(8);
      const codes8 = body8.data.orders.map((o: { order_code: string }) => o.order_code);
      expect(codes8).toEqual(expectedPreGuardOrder.map((n) => seeded.find((s) => s.name === n)!.orderCode));

      const excludedCodes = [excl1.orderCode, excl2.orderCode, excl3.orderCode];
      for (const code of excludedCodes) {
        expect(codes8, `${code} (HUY_TRA_MAY/TRA_HANG/no-media) must never appear`).not.toContain(code);
      }

      for (const s of seeded) await cleanup(staffToken, request, s.customerId);
      await cleanup(staffToken, request, excl1.customerId);
      await cleanup(staffToken, request, excl2.customerId);
      await cleanup(staffToken, request, excl3.customerId);
    });

    test('activity rules: created_at / real status change / media upload count; a notes-only history row does not', async ({ request }) => {
      const D2 = addDays(uniqueFutureBaseDate(), 40);
      const inWindow = vnInstant(D2, '10:00:00');
      const outsideWindow = vnInstant(addDays(D2, -10), '10:00:00');

      // Created inside the window directly -> counts.
      const oCreated = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oCreated.orderId, { status: 'SUA_XONG', createdAtIso: inWindow });
      await insertMedia(db, adminUserId, oCreated.orderId, 'COMPLETION', 'photo', outsideWindow);

      // Created outside, but a REAL status change inside the window -> counts.
      const oStatus = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oStatus.orderId, { status: 'SUA_XONG', createdAtIso: outsideWindow });
      await insertMedia(db, adminUserId, oStatus.orderId, 'COMPLETION', 'photo', outsideWindow);
      await insertStatusHistory(db, adminUserId, oStatus.orderId, 'TIEP_NHAN', 'DANG_SUA_CHUA', inWindow);

      // Created outside, no status change inside, but media uploaded inside -> counts.
      const oMedia = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oMedia.orderId, { status: 'SUA_XONG', createdAtIso: outsideWindow });
      await insertMedia(db, adminUserId, oMedia.orderId, 'COMPLETION', 'photo', inWindow);

      // Created outside, media outside, ONLY a notes-only (old_status ==
      // new_status) history row inside the window -> must NOT count.
      const oNotesOnly = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oNotesOnly.orderId, { status: 'SUA_XONG', createdAtIso: outsideWindow });
      await insertMedia(db, adminUserId, oNotesOnly.orderId, 'COMPLETION', 'photo', outsideWindow);
      await insertStatusHistory(db, adminUserId, oNotesOnly.orderId, 'SUA_XONG', 'SUA_XONG', inWindow, 'chi la ghi chu, khong doi trang thai');

      const res = await request.get(`${AGENT_BASE}/featured?date=${D2}&limit=20`, { headers: agentHeaders() });
      const body = await res.json();
      const codes = body.data.orders.map((o: { order_code: string }) => o.order_code);

      expect(codes).toContain(oCreated.orderCode);
      expect(codes).toContain(oStatus.orderCode);
      expect(codes).toContain(oMedia.orderCode);
      expect(codes, 'a notes-only status-history row (old_status === new_status) must not count as activity').not.toContain(oNotesOnly.orderCode);
      expect(body.data.total_candidates).toBe(3);

      for (const o of [oCreated, oStatus, oMedia, oNotesOnly]) await cleanup(staffToken, request, o.customerId);
    });

    test('date-window edges: 00:00:00 and 23:59:59 VN of the day are included; the adjacent days are not', async ({ request }) => {
      const D3 = addDays(uniqueFutureBaseDate(), 80);

      const oStart = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oStart.orderId, { status: 'SUA_XONG', createdAtIso: vnInstant(D3, '00:00:00') });
      await insertMedia(db, adminUserId, oStart.orderId, 'COMPLETION', 'photo', vnInstant(D3, '00:00:00'));

      const oEnd = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oEnd.orderId, { status: 'SUA_XONG', createdAtIso: vnInstant(D3, '23:59:59') });
      await insertMedia(db, adminUserId, oEnd.orderId, 'COMPLETION', 'photo', vnInstant(D3, '23:59:59'));

      const oBefore = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oBefore.orderId, { status: 'SUA_XONG', createdAtIso: vnInstant(addDays(D3, -1), '23:59:59') });
      await insertMedia(db, adminUserId, oBefore.orderId, 'COMPLETION', 'photo', vnInstant(addDays(D3, -1), '23:59:59'));

      const oAfter = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
      await setOrder(db, oAfter.orderId, { status: 'SUA_XONG', createdAtIso: vnInstant(addDays(D3, 1), '00:00:00') });
      await insertMedia(db, adminUserId, oAfter.orderId, 'COMPLETION', 'photo', vnInstant(addDays(D3, 1), '00:00:00'));

      const res = await request.get(`${AGENT_BASE}/featured?date=${D3}&limit=20`, { headers: agentHeaders() });
      const body = await res.json();
      const codes = body.data.orders.map((o: { order_code: string }) => o.order_code);

      expect(codes, '00:00:00 of the window date is included').toContain(oStart.orderCode);
      expect(codes, '23:59:59 of the window date is included').toContain(oEnd.orderCode);
      expect(codes, '23:59:59 of the PREVIOUS day is excluded').not.toContain(oBefore.orderCode);
      expect(codes, '00:00:00 of the NEXT day (the exclusive window end) is excluded').not.toContain(oAfter.orderCode);
      expect(body.data.total_candidates).toBe(2);
      expect(body.data.window.start).toBe(new Date(vnInstant(D3, '00:00:00')).toISOString());
      expect(body.data.window.end).toBe(new Date(vnInstant(addDays(D3, 1), '00:00:00')).toISOString());

      for (const o of [oStart, oEnd, oBefore, oAfter]) await cleanup(staffToken, request, o.customerId);
    });

    test('limit clamping: invalid/huge/zero limit never errors and never silently returns nothing', async ({ request }) => {
      const D4 = addDays(uniqueFutureBaseDate(), 120);
      const created: SeedResult[] = [];
      for (let i = 0; i < 2; i++) {
        const o = await seedOrder(staffToken, request, { product_type: 'SPEAKER' });
        await setOrder(db, o.orderId, { status: 'SUA_XONG', createdAtIso: vnInstant(D4, '10:00:00') });
        await insertMedia(db, adminUserId, o.orderId, 'COMPLETION', 'photo', vnInstant(D4, '10:00:00'));
        created.push(o);
      }

      for (const limit of ['0', '-5', 'abc', '999']) {
        const res = await request.get(`${AGENT_BASE}/featured?date=${D4}&limit=${limit}`, { headers: agentHeaders() });
        expect(res.status(), `limit=${limit} must not be rejected (only orders/limit is 400-validated)`).toBe(200);
        const body = await res.json();
        expect(body.data.orders.length, `limit=${limit}`).toBe(2);
      }

      for (const o of created) await cleanup(staffToken, request, o.customerId);
    });
  });

  // ---------------------------------------------------------------------
  // Security review follow-up (backend 9bf41c7): request logging, rate
  // limiting, widened phone masking
  // ---------------------------------------------------------------------

  test.describe('security', () => {
    test('PII: fully-spaced phone digits (e.g. "0 9 1 2 3 4 5 6 7 8") are masked too', async ({ request }) => {
      const spacedPhone = '0 9 1 2 3 4 5 6 7 8';
      const { orderId, customerId } = await seedOrder(staffToken, request, {
        fault_description: `May hong loa, goi lai so ${spacedPhone} khi xong`,
      });

      const detail = await (await request.get(`${AGENT_BASE}/orders/${orderId}`, { headers: agentHeaders() })).json();
      expect(detail.data.fault_description).toContain('[đã ẩn]');
      expect(detail.data.fault_description).not.toContain(spacedPhone);
      // None of the individual spaced digits should survive as a contiguous
      // run either — the whole spaced run must be replaced by the token.
      expect(detail.data.fault_description).not.toMatch(/\d(?:\s\d){9}/);

      await cleanup(staffToken, request, customerId);
    });

    test('failed-auth rate limit: bad-key requests are rejected with 429 once exceeded; good-key requests are governed by the separate, much higher global limit', async ({ request }) => {
      const port = process.env.E2E_AGENT_AUTH_FAIL_LIMIT_PORT;
      if (!port) {
        test.skip(true, 'E2E_AGENT_AUTH_FAIL_LIMIT_PORT not set — no low-auth-fail-limit backend instance running for this check');
        return;
      }
      const maxAttempts = Number(process.env.E2E_AGENT_AUTH_FAIL_LIMIT_MAX ?? 3);
      const base = `http://localhost:${port}/api/agent`;

      // Good-key traffic FIRST, more than maxAttempts worth of requests, all
      // succeeding — proves it isn't bottlenecked by the low auth-fail
      // budget, only by the separate (much higher, default 120/min) global
      // limiter. This has to run before deliberately tripping the auth-fail
      // limiter below: express-rate-limit's skipSuccessfulRequests still
      // increments the SAME per-IP counter for every request up front
      // (only decrementing afterward for ones that turn out successful) —
      // so once that counter is pegged at the limit, literally the very
      // next request on this IP (good key or not) is rejected by the
      // limiter itself before it even reaches auth, regardless of what its
      // own outcome would have been. That's correct, intentional behavior
      // (a temporary full block from an IP that just brute-forced the key),
      // not something a single subsequent "good" request can route around.
      for (let i = 0; i < maxAttempts + 2; i++) {
        const res = await request.get(`${base}/orders`, { headers: agentHeaders() });
        expect(res.status(), `good-key attempt ${i}`).toBe(200);
      }

      let sawRateLimit = false;
      for (let i = 0; i < maxAttempts + 3 && !sawRateLimit; i++) {
        const res = await request.get(`${base}/orders`, { headers: agentHeaders('not-the-real-key') });
        if (res.status() === 429) {
          sawRateLimit = true;
          expect(await res.json()).toEqual({ success: false, data: null, error: 'Too Many Requests' });
        } else {
          expect(res.status(), `bad-key attempt ${i}`).toBe(401);
        }
      }
      expect(sawRateLimit, `expected 429 within ${maxAttempts + 3} bad-key attempts (limit configured to ${maxAttempts})`).toBe(true);
    });

    test('request logging: a request produces one [agent-api] line, and the key never appears in stdout', async ({ request }) => {
      test.setTimeout(30_000);
      const port = '6066';
      const { child, getOutput } = await spawnBackendCapturingStdout(port, {
        AGENT_API_KEY,
        PUBLIC_MEDIA_BASE_URL: `http://localhost:${port}`,
      });
      try {
        const res = await request.get(`http://localhost:${port}/api/agent/orders?limit=5`, { headers: agentHeaders() });
        expect(res.status()).toBe(200);

        // The log line is written on the response 'finish' event, which can
        // land a beat after the HTTP response body itself.
        const deadline = Date.now() + 5_000;
        let output = getOutput();
        while (!output.includes('[agent-api]') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          output = getOutput();
        }

        expect(output).toContain('[agent-api]');
        expect(output, 'the X-Agent-Key value must never be logged').not.toContain(AGENT_API_KEY);

        const logLine = output.split('\n').find((l) => l.includes('[agent-api]'));
        expect(logLine).toBeTruthy();
        const parsed = JSON.parse(logLine!.slice(logLine!.indexOf('{')));
        expect(parsed.method).toBe('GET');
        expect(parsed.path).toBe('/api/agent/orders');
        expect(parsed.status).toBe(200);
        expect(parsed.outcome).toBe('ok');
        expect(typeof parsed.duration_ms).toBe('number');
        // The query string (limit=5) must never be logged either.
        expect(logLine).not.toContain('limit=5');
      } finally {
        child.kill();
      }
    });
  });

  // ---------------------------------------------------------------------
  // Disabled mode
  // ---------------------------------------------------------------------

  test.describe('disabled mode', () => {
    test('every /api/agent/* route returns 404 (never 401) when AGENT_API_KEY/PUBLIC_MEDIA_BASE_URL are unset', async ({ request }) => {
      // Started by disabled-agent-api-server.js (spawned in globalSetup-adjacent
      // helper) on DISABLED_AGENT_API_PORT — see helpers/disabledAgentApi.ts.
      const port = process.env.E2E_DISABLED_AGENT_API_PORT;
      if (!port) {
        test.skip(true, 'E2E_DISABLED_AGENT_API_PORT not set — disabled-mode server was not started for this run');
        return;
      }
      const base = `http://localhost:${port}/api/agent`;
      for (const path of ['/orders', '/orders/whatever', '/featured']) {
        const res = await request.get(`${base}${path}`, { headers: agentHeaders() });
        expect(res.status(), path).toBe(404);
        const body = await res.json();
        expect(body.error).toBe('Not found');
      }
    });
  });
});

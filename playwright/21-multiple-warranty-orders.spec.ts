/**
 * PW-21 — Multiple Warranty Orders per Source (feat/multiple-warranty-orders)
 *
 * Covers:
 *   - POST /orders/warranty-claim no longer 409s when a warranty already
 *     exists for the source order; repeated claims increment the code:
 *     <src>-BH, <src>-BH2, <src>-BH3, ...
 *   - A warranty order cannot itself be used as the source of another
 *     warranty claim → 400 "Không thể tạo bảo hành cho đơn bảo hành"
 *   - GET /warranty/search excludes warranty (BAO_HANH) orders from results
 *   - GET /orders/:id for a -BH2 order returns source_order_id equal to the
 *     original source order and a non-empty source_order_history
 *   - UI: order detail page for a -BH2 order shows the "Lịch sử đơn gốc"
 *     section
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 *                (backend must be running feat/multiple-warranty-orders)
 */

import { test, expect } from './helpers/fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { transitionStatus } from './helpers/images';
import { uniqueNow } from './helpers/ids';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

async function getFirstBranchId(token: string, request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get(`${API_BASE}/branches`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()).data[0].id as string;
}

/** Advance an order to DA_GIAO through the full status workflow. */
async function advanceToDelivered(
  token: string,
  orderId: string,
  request: import('@playwright/test').APIRequestContext,
) {
  // Matches the backend's STATUS_FLOW — CHO_LINH_KIEN/KIEM_TRA_LAI were removed in RH-31.
  const statuses = ['DANG_KIEM_TRA', 'BAO_GIA', 'DANG_SUA_CHUA', 'SUA_XONG', 'DA_GIAO'];
  for (const status of statuses) {
    // SUA_XONG / HUY_TRA_MAY require a fresh COMPLETION image + notes before
    // the status PUT is accepted (RH: status-rules-da-giao-huy-tra-may) —
    // transitionStatus() handles both; see playwright/helpers/images.ts.
    await transitionStatus(request, token, orderId, status, { notes: `Advancing to ${status} for PW-21 test` });
  }
}

/** Submit a warranty claim (multipart, matches the real FE payload shape). */
async function claimWarranty(
  token: string,
  sourceOrderId: string,
  branchId: string,
  faultDescription: string,
  request: import('@playwright/test').APIRequestContext,
  withImage = false,
) {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    source_order_id: sourceOrderId,
    branch_id: branchId,
    fault_description: faultDescription,
  };
  if (withImage) {
    multipart.images_1 = {
      name: 'img-a1.jpg',
      mimeType: 'image/jpeg',
      buffer: fs.readFileSync(FIXT('img-a1.jpg')),
    };
  }
  return request.post(`${API_BASE}/orders/warranty-claim`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart,
  });
}

test.describe('PW-21 Multiple Warranty Orders per Source', () => {
  let token: string;
  let branchId: string;
  let customerId: string;
  let customerPhone: string;
  let sourceOrderId: string;
  let sourceOrderCode: string;
  let bh1Id: string;
  let bh1Code: string;
  let bh2Id: string;
  let bh2Code: string;
  let bh3Code: string;
  const runId = uniqueNow();

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    branchId = await getFirstBranchId(token, request);

    customerPhone = `093${String(runId).slice(-7)}`;
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: customerPhone,
        name: `Khách PW-21 ${runId}`,
        address: 'PW-21 Street',
        type: 'RETAIL',
      },
    });
    customerId = (await cRes.json()).data.id;

    // Create source order and advance it to DA_GIAO so it is warranty-eligible
    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        customer_id: customerId,
        branch_id: branchId,
        product_type: 'HEADPHONE',
        device_name: `Tai nghe PW21-${runId}`,
        serial_imei: `SN-PW21-${runId}`,
        fault_description: 'Original fault for PW21',
        quotation: 250000,
      },
    });
    const oBody = await oRes.json();
    sourceOrderId = oBody.data.id;
    sourceOrderCode = oBody.data.order_code;

    await advanceToDelivered(token, sourceOrderId, request);
  });

  test.afterAll(async () => {
    // No per-test API cleanup call here — intentionally.
    //
    // This test creates 4 orders for the customer (the source order plus
    // -BH, -BH2, -BH3). orders.customer_id is `REFERENCES customers(id)`
    // with no `ON DELETE CASCADE` (migrations/001_initial_schema.sql), and
    // the backend exposes no order-delete/cancel endpoint (orders.ts only
    // has PATCH /:id and PUT /:id/status) — there is no way to remove the
    // orders first, so `DELETE /customers/:id` always 409s once they exist
    // (fix/customer-delete-with-orders) and would do nothing.
    //
    // The customer is still registered for cleanup though: `request.post`
    // is wrapped by playwright/helpers/fixtures.ts, which records its id to
    // the run registry regardless of which spec created it. The DB
    // teardown in playwright/global-teardown.ts deletes it (and its
    // orders/images/history) directly via E2E_DATABASE_URL at the end of
    // the run — see scripts/db-cleanup.js.
    console.info(
      `[PW-21] customer registered for DB teardown: customerId=${customerId}, ` +
      `phone=${customerPhone}, sourceOrderCode=${sourceOrderCode}`,
    );
  });

  test('first warranty claim on a source order creates code <src>-BH', async ({ request }) => {
    const res = await claimWarranty(token, sourceOrderId, branchId, 'Bảo hành lần 1', request, true);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.order_code).toBe(`${sourceOrderCode}-BH`);
    expect(body.data.product_type).toBe('BAO_HANH');
    bh1Id = body.data.id;
    bh1Code = body.data.order_code;
  });

  test('second warranty claim on the SAME source order does not 409 — creates <src>-BH2', async ({ request }) => {
    const res = await claimWarranty(token, sourceOrderId, branchId, 'Bảo hành lần 2', request);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.order_code).toBe(`${sourceOrderCode}-BH2`);
    bh2Id = body.data.id;
    bh2Code = body.data.order_code;
  });

  test('third warranty claim on the same source order creates <src>-BH3', async ({ request }) => {
    const res = await claimWarranty(token, sourceOrderId, branchId, 'Bảo hành lần 3', request);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.order_code).toBe(`${sourceOrderCode}-BH3`);
    bh3Code = body.data.order_code;
  });

  test('claiming warranty using a -BH order as the source returns 400', async ({ request }) => {
    expect(bh1Id, 'bh1Id set by earlier test').toBeTruthy();
    const res = await claimWarranty(token, bh1Id, branchId, 'Should be rejected', request);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Không thể tạo bảo hành cho đơn bảo hành');
  });

  test('warranty search for the customer phone returns the source order but not the BH orders', async ({ request }) => {
    const res = await request.get(`${API_BASE}/warranty/search?q=${customerPhone}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const codes: string[] = body.data.map((o: { order_code: string }) => o.order_code);

    expect(codes).toContain(sourceOrderCode);
    expect(codes).not.toContain(bh1Code);
    expect(codes).not.toContain(bh2Code);
    expect(codes).not.toContain(bh3Code);
    // Defensive: none of the returned results are warranty (BAO_HANH) orders
    for (const o of body.data as Array<{ product_type: string }>) {
      expect(o.product_type).not.toBe('BAO_HANH');
    }
  });

  test('GET /orders/:id for the -BH2 order returns source_order_id and non-empty source_order_history', async ({ request }) => {
    expect(bh2Id, 'bh2Id set by earlier test').toBeTruthy();
    const res = await request.get(`${API_BASE}/orders/${bh2Id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.order_code).toBe(bh2Code);
    expect(body.data.source_order_id).toBe(sourceOrderId);
    expect(Array.isArray(body.data.source_order_history)).toBeTruthy();
    expect(body.data.source_order_history.length).toBeGreaterThan(0);
  });

  test('order detail page of the -BH2 order shows the "Lịch sử đơn gốc" section', async ({ page }) => {
    expect(bh2Id, 'bh2Id set by earlier test').toBeTruthy();
    await loginViaUI(page);
    await page.goto(`/orders/${bh2Id}`);

    await expect(page.getByText(bh2Code)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Lịch sử đơn gốc')).toBeVisible({ timeout: 8_000 });

    await page.screenshot({ path: '.playwright-mcp/pw21-bh2-source-history-section.png' });
  });
});

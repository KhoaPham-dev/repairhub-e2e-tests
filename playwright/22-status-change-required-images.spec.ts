/**
 * PW-22 — Status Change Required Images (feat/status-change-required-images)
 *
 * Covers the new rule: transitioning an order to DA_GIAO ("Đã giao") or
 * TRA_HANG ("Trả hàng") requires at least one COMPLETION image uploaded
 * AFTER the order's most recent status change.
 *
 *   API:
 *     TC-01: DA_GIAO without any image → 400 with the guidance message
 *     TC-02: TRA_HANG without any image → 400
 *     TC-03: Only an INTAKE image present → 400 (COMPLETION specifically required)
 *     TC-04: Upload a COMPLETION image, then DA_GIAO → 200
 *     TC-05: A COMPLETION image uploaded BEFORE the latest status change does
 *            not count — upload, transition to a non-required status, then
 *            attempt DA_GIAO → 400
 *     TC-06: Non-required status transitions still work without any image
 *     TC-09: A warranty-duration PATCH (old_status = new_status history row)
 *            after the image upload does not make it stale — DA_GIAO still 200
 *     TC-10: A notes-only PATCH (same administrative history row shape) after
 *            the image upload does not make it stale — TRA_HANG still 200
 *
 *   UI:
 *     TC-07: Selecting "Đã giao" shows the required-image note and disables Save
 *     TC-08: Attaching an image enables Save; saving transitions the order and
 *            the new image appears under "Ảnh đã lưu"
 *     TC-11: Changing the warranty duration and selecting "Đã giao" in the same
 *            save (no new image attached) succeeds using an existing fresh image
 *
 * Prerequisites: backend running at http://localhost:6061
 *                frontend running at http://localhost:6060
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { COMPLETION_IMAGE_FIXTURE } from './helpers/images';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const REQUIRED_MSG = 'Vui lòng tải ảnh khi chuyển sang trạng thái Trả hàng / Đã giao';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

interface SeedResult {
  orderId: string;
  orderCode: string;
  customerId: string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  opts: { phone?: string; warrantyMonths?: number } = {},
): Promise<SeedResult> {
  const runId = Date.now() + Math.floor(Math.random() * 1000);
  const phone = opts.phone ?? `096${String(runId).slice(-7)}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-22 ${runId}`,
      address: 'Test Address PW-22',
      type: 'RETAIL',
    },
  });
  const cBody = await cRes.json();
  const customerId = cBody.data.id as string;

  const bRes = await request.get(`${API_BASE}/branches`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bBody = await bRes.json();
  const branchId = bBody.data[0].id as string;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: 'SPEAKER',
      device_name: `Loa PW-22-${runId}`,
      serial_imei: `SN-PW22-${runId}`,
      fault_description: 'E2E status-change-required-images test',
      quotation: 200000,
      ...(opts.warrantyMonths !== undefined ? { warranty_period_months: opts.warrantyMonths } : {}),
    },
  });
  const oBody = await oRes.json();
  return {
    orderId: oBody.data.id as string,
    orderCode: oBody.data.order_code as string,
    customerId,
  };
}

async function patchOrder(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
  data: Record<string, unknown>,
) {
  return request.patch(`${API_BASE}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
}

async function uploadImage(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
  imageType: 'INTAKE' | 'COMPLETION',
) {
  return request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      image_type: imageType,
      images: {
        name: `${imageType.toLowerCase()}.jpg`,
        mimeType: 'image/jpeg',
        buffer: fs.readFileSync(FIXT('img-a1.jpg')),
      },
    },
  });
}

async function putStatus(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
  status: string,
) {
  return request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status, notes: `PW-22 attempt ${status}` },
  });
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request
    .delete(`${API_BASE}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

test.describe('PW-22 API — DA_GIAO / TRA_HANG require a fresh COMPLETION image', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-01: DA_GIAO without any image returns 400 with the guidance message', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe(REQUIRED_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-02: TRA_HANG without any image returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'TRA_HANG');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(REQUIRED_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-03: an INTAKE-only image does not satisfy the requirement — DA_GIAO still 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'INTAKE');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(REQUIRED_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-04: a fresh COMPLETION image allows DA_GIAO (200)', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');
    await cleanup(token, request, customerId);
  });

  test('TC-05: a COMPLETION image uploaded before the latest status change does not count', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    // Upload a COMPLETION image while still at TIEP_NHAN.
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // Transition to a non-required status — this creates a NEWER status_history
    // row, so the image above is now stale relative to the order's latest change.
    const midway = await putStatus(request, token, orderId, 'DANG_KIEM_TRA');
    expect(midway.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(REQUIRED_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-06: non-required status transitions work without any image', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'BAO_GIA');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('BAO_GIA');
    await cleanup(token, request, customerId);
  });

  test('TC-09: a warranty-duration PATCH after the image upload does not make it stale — DA_GIAO still 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request, { warrantyMonths: 3 });
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // PATCH /orders/:id records an administrative history row
    // (old_status === new_status) for the warranty-duration change — this
    // must NOT count as a newer status change for the freshness check.
    const patchRes = await patchOrder(request, token, orderId, { warranty_period_months: 6 });
    expect(patchRes.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');
    await cleanup(token, request, customerId);
  });

  test('TC-10: a notes-only PATCH after the image upload does not make it stale — TRA_HANG still 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // A notes-only PATCH also records an administrative history row
    // (old_status === new_status) and must not invalidate the fresh image.
    const patchRes = await patchOrder(request, token, orderId, { notes: 'Ghi chú kiểm tra PW-22' });
    expect(patchRes.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'TRA_HANG');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('TRA_HANG');
    await cleanup(token, request, customerId);
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test.describe('PW-22 UI — order detail enforces the required-image rule', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('TC-07: selecting "Đã giao" shows the required-image note and disables Save', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });

    await expect(
      page.getByText('Bắt buộc tải lên ít nhất 1 ảnh khi chuyển sang trạng thái này')
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-08: attaching an image enables Save and completes the transition', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();

    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByText(/Đã chọn 1 ảnh/)).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // DA_GIAO is a terminal status — the editable section (including the
    // success toast) is hidden immediately once load() re-fetches the order
    // as terminal, so assert the stable post-transition indicators instead
    // (mirrors the same race handled in 05-order-status-flow.spec.ts TC-05).
    const badge = page.locator('span.bg-accent\\/10');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    // Order is now terminal — editable section is gone, and the saved image
    // gallery shows the newly-uploaded completion photo.
    await expect(page.getByText(/Ảnh đã lưu \(1\)/)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-11: changing warranty duration and selecting "Đã giao" in the same save succeeds using an existing fresh image', async ({ page, request }) => {
    // Seed a separate order (3-month warranty, like RH-133's test) with a
    // COMPLETION image already uploaded — no new image will be attached here.
    const { orderId: freshOrderId, customerId: freshCustomerId } = await seedOrder(token, request, {
      warrantyMonths: 3,
    });
    const upload = await uploadImage(request, token, freshOrderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    await loginViaUI(page);
    await page.goto(`/orders/${freshOrderId}`);

    // Change warranty duration (order starts at 3 tháng) — this queues a
    // PATCH that will insert an administrative history row alongside the
    // DA_GIAO status PUT in the same "Lưu thay đổi" save.
    await page.getByRole('button', { name: '6 tháng' }).click();

    // Select Đã giao — no new image is attached; the existing COMPLETION
    // image (uploaded after order creation) should still count as fresh.
    await page.locator('select').selectOption({ label: 'Đã giao' });
    await expect(page.getByText(/đã có ảnh mới/)).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const badge = page.locator('span.bg-accent\\/10');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    await cleanup(token, request, freshCustomerId);
  });
});

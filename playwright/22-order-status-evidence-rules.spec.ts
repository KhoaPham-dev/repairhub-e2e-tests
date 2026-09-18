/**
 * PW-22 — Order Status Evidence Rules (feat/status-rules-da-giao-huy-tra-may)
 *
 * Covers the evidence rule for PUT /orders/:id/status:
 *   - DA_GIAO ("Đã giao") and HUY_TRA_MAY ("Huỷ trả máy") require BOTH a
 *     non-blank `notes` and a fresh COMPLETION photo (uploaded after the
 *     order's most recent REAL status transition). Notes are checked first.
 *   - TRA_HANG ("Trả hàng") requires neither.
 *
 *   API:
 *     TC-01: TRA_HANG works with no photo and no notes → 200
 *     TC-02: DA_GIAO with no notes at all → 400 (notes message)
 *     TC-03: DA_GIAO with blank/whitespace-only notes → 400 (notes message)
 *     TC-04: DA_GIAO with notes but no photo → 400 (photo message)
 *     TC-05: DA_GIAO with notes and only an INTAKE image → 400 (photo message,
 *            COMPLETION specifically required)
 *     TC-06: DA_GIAO with notes and a fresh COMPLETION image → 200
 *     TC-07: HUY_TRA_MAY with no notes → 400 (notes message)
 *     TC-08: HUY_TRA_MAY with notes but no photo → 400 (photo message)
 *     TC-09: HUY_TRA_MAY with notes and a fresh COMPLETION image → 200
 *     TC-10: A COMPLETION image uploaded BEFORE the latest REAL status change
 *            does not count — upload, transition to a non-required status,
 *            then attempt DA_GIAO (with notes) → 400 (photo message)
 *     TC-11: A warranty-duration PATCH (administrative history row,
 *            old_status = new_status) after the image upload does not make
 *            it stale — DA_GIAO with notes still 200
 *     TC-12: A notes-only PATCH (same administrative row shape) after the
 *            image upload does not make it stale — HUY_TRA_MAY with notes
 *            still 200
 *     TC-13: Non-required status transitions (e.g. BAO_GIA) work without any
 *            evidence
 *
 *   UI:
 *     TC-14: Selecting "Đã giao" shows the combined evidence note; Save is
 *            disabled with neither notes nor a photo provided
 *     TC-15: Save stays disabled with only a photo attached (no notes)
 *     TC-16: Save stays disabled with only notes filled in (no photo)
 *     TC-17: Save is enabled once both are provided; saving transitions the
 *            order and the new image appears under "Ảnh đã lưu"
 *     TC-18: Changing the warranty duration and selecting "Đã giao" in the
 *            same save (notes filled, no new image) succeeds using an
 *            existing fresh image
 *     TC-19: On a TRA_HANG order, the "Huỷ trả máy" shortcut selects
 *            HUY_TRA_MAY without opening the ConfirmModal; filling notes and
 *            attaching a photo enables Save, which opens the ConfirmModal —
 *            confirming transitions the order to Huỷ trả máy
 *
 * Prerequisites: backend running at http://localhost:6061
 *                frontend running at http://localhost:6060
 */

import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { COMPLETION_IMAGE_FIXTURE } from './helpers/images';
import { uniqueNow } from './helpers/ids';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const NOTES_MSG = 'Vui lòng nhập ghi chú khi chuyển sang trạng thái Đã giao / Huỷ trả máy';
const PHOTO_MSG = 'Vui lòng tải ảnh khi chuyển sang trạng thái Đã giao / Huỷ trả máy';
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
  const runId = uniqueNow();
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
      fault_description: 'E2E order-status-evidence-rules test',
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

/**
 * PUT the status directly, with full control over the `notes` field:
 *  - omit `notes` (undefined) → body has no notes key at all
 *  - pass a string (including blank/whitespace) → sent as-is
 */
async function putStatus(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
  status: string,
  notes?: string,
) {
  const data: Record<string, unknown> = { status };
  if (notes !== undefined) data.notes = notes;
  return request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
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

test.describe('PW-22 API — DA_GIAO / HUY_TRA_MAY require notes + a fresh COMPLETION image', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-01: TRA_HANG works with no photo and no notes', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'TRA_HANG');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('TRA_HANG');
    await cleanup(token, request, customerId);
  });

  test('TC-02: DA_GIAO with no notes returns 400 with the notes-guidance message', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-03: DA_GIAO with blank (whitespace-only) notes returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'DA_GIAO', '   ');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-04: DA_GIAO with notes but no photo returns 400 with the photo-guidance message', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'DA_GIAO', 'Đã giao cho khách');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-05: DA_GIAO with notes and only an INTAKE image still returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'INTAKE');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'DA_GIAO', 'Đã giao cho khách');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-06: DA_GIAO with notes and a fresh COMPLETION image returns 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'DA_GIAO', 'Đã giao cho khách');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');
    await cleanup(token, request, customerId);
  });

  test('TC-07: HUY_TRA_MAY with no notes returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-08: HUY_TRA_MAY with notes but no photo returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY', 'Khách huỷ trả máy');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-09: HUY_TRA_MAY with notes and a fresh COMPLETION image returns 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY', 'Khách huỷ trả máy');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('HUY_TRA_MAY');
    await cleanup(token, request, customerId);
  });

  test('TC-10: a COMPLETION image uploaded before the latest status change does not count', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    // Upload a COMPLETION image while still at TIEP_NHAN.
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // Transition to a non-required status — this creates a NEWER status_history
    // row, so the image above is now stale relative to the order's latest change.
    const midway = await putStatus(request, token, orderId, 'DANG_KIEM_TRA');
    expect(midway.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'DA_GIAO', 'Đã giao cho khách');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-11: a warranty-duration PATCH after the image upload does not make it stale — DA_GIAO still 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request, { warrantyMonths: 3 });
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // PATCH /orders/:id records an administrative history row
    // (old_status === new_status) for the warranty-duration change — this
    // must NOT count as a newer status change for the freshness check.
    const patchRes = await patchOrder(request, token, orderId, { warranty_period_months: 6 });
    expect(patchRes.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'DA_GIAO', 'Đã giao cho khách');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');
    await cleanup(token, request, customerId);
  });

  test('TC-12: a notes-only PATCH after the image upload does not make it stale — HUY_TRA_MAY still 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // A notes-only PATCH also records an administrative history row
    // (old_status === new_status) and must not invalidate the fresh image.
    const patchRes = await patchOrder(request, token, orderId, { notes: 'Ghi chú kiểm tra PW-22' });
    expect(patchRes.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY', 'Khách huỷ trả máy');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('HUY_TRA_MAY');
    await cleanup(token, request, customerId);
  });

  test('TC-13: non-required status transitions work without any evidence', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'BAO_GIA');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('BAO_GIA');
    await cleanup(token, request, customerId);
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test.describe('PW-22 UI — order detail enforces the evidence rule', () => {
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

  test('TC-14: selecting "Đã giao" shows the combined evidence note and disables Save', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });

    await expect(
      page.getByText('Bắt buộc tải lên ít nhất 1 ảnh và nhập ghi chú khi chuyển sang trạng thái này')
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-15: Save stays disabled with only a photo attached (no notes)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByText(/Đã chọn 1 ảnh/)).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-16: Save stays disabled with only notes filled in (no photo)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });
    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã giao cho khách');

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-17: Save is enabled with both notes and a photo; saving completes the transition', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();

    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã giao cho khách');
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

  test('TC-18: changing warranty duration and selecting "Đã giao" in the same save succeeds using an existing fresh image', async ({ page, request }) => {
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
    // Notes must still be filled — the evidence rule now also requires them.
    await page.locator('select').selectOption({ label: 'Đã giao' });
    await expect(page.getByText(/đã có ảnh mới/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();

    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã giao cho khách');

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const badge = page.locator('span.bg-accent\\/10');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    await cleanup(token, request, freshCustomerId);
  });

  test('TC-19: on a TRA_HANG order, the shortcut selects HUY_TRA_MAY without a modal; Save then opens it and confirming transitions the order', async ({ page, request }) => {
    // Seed a fresh order and advance it to TRA_HANG via the API — TRA_HANG
    // requires no evidence at all.
    const { orderId: traHangOrderId, customerId: traHangCustomerId } = await seedOrder(token, request);
    const traHangRes = await putStatus(request, token, traHangOrderId, 'TRA_HANG');
    expect(traHangRes.status()).toBe(200);

    await loginViaUI(page);
    await page.goto(`/orders/${traHangOrderId}`);

    let nativeDialogFired = false;
    page.on('dialog', () => { nativeDialogFired = true; });

    const shortcutBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(shortcutBtn).toBeVisible({ timeout: 10_000 });
    await shortcutBtn.click();

    // The shortcut only selects HUY_TRA_MAY and scrolls to the evidence
    // section — it must NOT open the ConfirmModal or a native dialog.
    await expect(page.locator('select')).toHaveValue('HUY_TRA_MAY');
    await expect(page.getByRole('button', { name: 'Xác nhận' })).toHaveCount(0);
    expect(nativeDialogFired).toBe(false);

    // Fill notes + attach a photo to satisfy the evidence rule.
    await page.getByPlaceholder('Thêm ghi chú...').fill('Khách không đồng ý, huỷ đơn');
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // Save opens the ConfirmModal for HUY_TRA_MAY — confirm the update.
    const confirmBtn = page.getByRole('button', { name: 'Xác nhận' });
    await expect(confirmBtn).toBeVisible({ timeout: 8_000 });
    await confirmBtn.click();

    const badge = page.locator('span.bg-accent\\/10');
    await expect(badge).toContainText('Huỷ trả máy', { timeout: 10_000 });
    await expect(page.locator('select')).toHaveCount(0);

    await cleanup(token, request, traHangCustomerId);
  });
});

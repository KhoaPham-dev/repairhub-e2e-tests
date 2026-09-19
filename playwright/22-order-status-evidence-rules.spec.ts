/**
 * PW-22 — Order Status Evidence Rules (feat/evidence-at-sua-xong)
 *
 * Covers the evidence rule for PUT /orders/:id/status:
 *   - SUA_XONG ("Sửa xong") and HUY_TRA_MAY ("Huỷ trả máy") require BOTH a
 *     non-blank `notes` and a fresh COMPLETION photo or video (uploaded
 *     after the order's most recent REAL status transition). Notes are
 *     checked first.
 *   - DA_GIAO ("Đã giao") requires NOTHING — even when the order skipped
 *     SUA_XONG entirely — and still sets warranty_end_date.
 *   - TRA_HANG ("Trả hàng") requires neither.
 *   - Warranty orders (DANG_BAO_HANH → SUA_XONG) follow the same rule as
 *     regular orders.
 *
 *   API:
 *     TC-01: SUA_XONG with no notes at all → 400 (notes message)
 *     TC-02: SUA_XONG with blank/whitespace-only notes → 400 (notes message)
 *     TC-03: SUA_XONG with notes but no photo → 400 (photo message)
 *     TC-04: SUA_XONG with notes and only an INTAKE image → 400 (photo
 *            message, COMPLETION specifically required)
 *     TC-05: SUA_XONG with notes and a fresh COMPLETION photo → 200
 *     TC-06: SUA_XONG with notes and a fresh COMPLETION video → 200
 *     TC-07: DA_GIAO from DANG_SUA_CHUA with no notes and no photo → 200,
 *            and warranty_end_date is set
 *     TC-08: HUY_TRA_MAY with no notes → 400 (notes message)
 *     TC-09: HUY_TRA_MAY with notes but no photo → 400 (photo message)
 *     TC-10: HUY_TRA_MAY with notes and a fresh COMPLETION image → 200
 *     TC-11: A COMPLETION image uploaded BEFORE the latest REAL status
 *            change does not count for SUA_XONG — upload, transition to a
 *            non-required status, then attempt SUA_XONG (with notes) → 400
 *            (photo message)
 *     TC-12: A warranty-duration PATCH (administrative history row,
 *            old_status = new_status) after the image upload does not make
 *            it stale — SUA_XONG with notes still 200
 *     TC-13: A notes-only PATCH (same administrative row shape) after the
 *            image upload does not make it stale — HUY_TRA_MAY with notes
 *            still 200
 *     TC-14: Non-required status transitions (e.g. BAO_GIA) work without
 *            any evidence
 *     TC-15: A warranty order (DANG_BAO_HANH) transitioning to SUA_XONG
 *            without evidence → 400 (notes message)
 *
 *   UI:
 *     TC-16: Selecting "Sửa xong" shows the combined evidence note; Save is
 *            disabled with neither notes nor a photo provided
 *     TC-17: Save stays disabled with only a photo attached (no notes)
 *     TC-18: Save stays disabled with only notes filled in (no photo)
 *     TC-19: Save is enabled once both are provided; saving transitions the
 *            order to Sửa xong and the new image appears under "Ảnh đã lưu"
 *     TC-20: Selecting "Đã giao" shows no evidence note; Save works with
 *            nothing filled in
 *     TC-21: Changing the warranty duration and selecting "Sửa xong" in the
 *            same save (notes filled, no new image) succeeds using an
 *            existing fresh image
 *     TC-22: On a TRA_HANG order, the "Huỷ trả máy" shortcut selects
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
const NOTES_MSG = 'Vui lòng nhập ghi chú khi chuyển sang trạng thái Sửa xong / Huỷ trả máy';
const PHOTO_MSG = 'Vui lòng tải ảnh hoặc video khi chuyển sang trạng thái Sửa xong / Huỷ trả máy';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);
const MP4_FIXTURE = FIXT('tiny.mp4');

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

/**
 * Submit a warranty claim against `sourceOrderId` (multipart, matches the
 * real FE payload shape). The resulting BAO_HANH order starts at
 * DANG_BAO_HANH — the endpoint does not require the source order to be at
 * any particular status.
 */
async function claimWarranty(
  token: string,
  sourceOrderId: string,
  branchId: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<{ orderId: string; orderCode: string }> {
  const res = await request.post(`${API_BASE}/orders/warranty-claim`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      source_order_id: sourceOrderId,
      branch_id: branchId,
      fault_description: 'PW-22 warranty claim test',
    },
  });
  const body = await res.json();
  return { orderId: body.data.id as string, orderCode: body.data.order_code as string };
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

async function uploadCompletionVideo(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
) {
  return request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      image_type: 'COMPLETION',
      images: {
        name: 'completion.mp4',
        mimeType: 'video/mp4',
        buffer: fs.readFileSync(MP4_FIXTURE),
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

test.describe('PW-22 API — SUA_XONG / HUY_TRA_MAY require notes + a fresh COMPLETION image or video', () => {
  let token: string;
  let branchId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const bBody = await (await request.get(`${API_BASE}/branches`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    branchId = bBody.data[0].id as string;
  });

  test('TC-01: SUA_XONG with no notes returns 400 with the notes-guidance message', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'SUA_XONG');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-02: SUA_XONG with blank (whitespace-only) notes returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'SUA_XONG', '   ');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-03: SUA_XONG with notes but no photo returns 400 with the photo-guidance message', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-04: SUA_XONG with notes and only an INTAKE image still returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'INTAKE');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-05: SUA_XONG with notes and a fresh COMPLETION photo returns 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('SUA_XONG');
    await cleanup(token, request, customerId);
  });

  test('TC-06: SUA_XONG with notes and a fresh COMPLETION video returns 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const upload = await uploadCompletionVideo(request, token, orderId);
    expect(upload.status()).toBe(201);

    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy, kèm video');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('SUA_XONG');
    await cleanup(token, request, customerId);
  });

  test('TC-07: DA_GIAO from DANG_SUA_CHUA with no notes and no photo returns 200 and sets warranty_end_date', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const midway = await putStatus(request, token, orderId, 'DANG_SUA_CHUA');
    expect(midway.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'DA_GIAO');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');
    expect(body.data.warranty_end_date).toBeTruthy();
    await cleanup(token, request, customerId);
  });

  test('TC-08: HUY_TRA_MAY with no notes returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(NOTES_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-09: HUY_TRA_MAY with notes but no photo returns 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'HUY_TRA_MAY', 'Khách huỷ trả máy');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-10: HUY_TRA_MAY with notes and a fresh COMPLETION image returns 200', async ({ request }) => {
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

  test('TC-11: a COMPLETION image uploaded before the latest status change does not count for SUA_XONG', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    // Upload a COMPLETION image while still at TIEP_NHAN.
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // Transition to a non-required status — this creates a NEWER status_history
    // row, so the image above is now stale relative to the order's latest change.
    const midway = await putStatus(request, token, orderId, 'DANG_KIEM_TRA');
    expect(midway.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(PHOTO_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-12: a warranty-duration PATCH after the image upload does not make it stale — SUA_XONG still 200', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request, { warrantyMonths: 3 });
    const upload = await uploadImage(request, token, orderId, 'COMPLETION');
    expect(upload.status()).toBe(201);

    // PATCH /orders/:id records an administrative history row
    // (old_status === new_status) for the warranty-duration change — this
    // must NOT count as a newer status change for the freshness check.
    const patchRes = await patchOrder(request, token, orderId, { warranty_period_months: 6 });
    expect(patchRes.status()).toBe(200);

    const res = await putStatus(request, token, orderId, 'SUA_XONG', 'Đã sửa xong máy');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('SUA_XONG');
    await cleanup(token, request, customerId);
  });

  test('TC-13: a notes-only PATCH after the image upload does not make it stale — HUY_TRA_MAY still 200', async ({ request }) => {
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

  test('TC-14: non-required status transitions work without any evidence', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await putStatus(request, token, orderId, 'BAO_GIA');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('BAO_GIA');
    await cleanup(token, request, customerId);
  });

  test('TC-15: a warranty order (DANG_BAO_HANH) transitioning to SUA_XONG without evidence returns 400', async ({ request }) => {
    const { orderId: sourceOrderId, customerId } = await seedOrder(token, request);
    const { orderId: warrantyOrderId } = await claimWarranty(token, sourceOrderId, branchId, request);

    const detail = await (await request.get(`${API_BASE}/orders/${warrantyOrderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    expect(detail.data.status).toBe('DANG_BAO_HANH');

    const res = await putStatus(request, token, warrantyOrderId, 'SUA_XONG');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(NOTES_MSG);
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

  test('TC-16: selecting "Sửa xong" shows the combined evidence note and disables Save', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Sửa xong' });

    await expect(
      page.getByText('Bắt buộc tải lên ít nhất 1 ảnh hoặc video và nhập ghi chú khi chuyển sang trạng thái này')
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-17: Save stays disabled with only a photo attached (no notes)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Sửa xong' });
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByText(/Đã chọn 1 ảnh/)).toBeVisible({ timeout: 5_000 });

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-18: Save stays disabled with only notes filled in (no photo)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Sửa xong' });
    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã sửa xong máy');

    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();
  });

  test('TC-19: Save is enabled with both notes and a photo; saving completes the transition', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Sửa xong' });
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();

    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã sửa xong máy');
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByText(/Đã chọn 1 ảnh/)).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });
    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Sửa xong', { timeout: 10_000 });

    // Saved image gallery shows the newly-uploaded completion photo.
    await expect(page.getByText(/Ảnh đã lưu \(1\)/)).toBeVisible({ timeout: 10_000 });
  });

  test('TC-20: selecting "Đã giao" shows no evidence note; Save works with nothing filled in', async ({ page, request }) => {
    // Seed a separate order (still at TIEP_NHAN) — DA_GIAO requires nothing,
    // even skipping SUA_XONG entirely.
    const { orderId: daGiaoOrderId, customerId: daGiaoCustomerId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${daGiaoOrderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });

    await expect(
      page.getByText('Bắt buộc tải lên ít nhất 1 ảnh hoặc video và nhập ghi chú khi chuyển sang trạng thái này')
    ).toHaveCount(0);

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // DA_GIAO is a terminal status — the editable section (including the
    // success toast) is hidden immediately once load() re-fetches the order
    // as terminal, so assert the stable post-transition indicator instead
    // (mirrors the same race handled in 05-order-status-flow.spec.ts TC-05).
    const badge = page.locator('span.bg-accent\\/10');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    await cleanup(token, request, daGiaoCustomerId);
  });

  test('TC-21: changing warranty duration and selecting "Sửa xong" in the same save succeeds using an existing fresh image', async ({ page, request }) => {
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
    // SUA_XONG status PUT in the same "Lưu thay đổi" save.
    await page.getByRole('button', { name: '6 tháng' }).click();

    // Select Sửa xong — no new image is attached; the existing COMPLETION
    // image (uploaded after order creation) should still count as fresh.
    // Notes must still be filled — the evidence rule requires them.
    await page.locator('select').selectOption({ label: 'Sửa xong' });
    await expect(page.getByText(/đã có ảnh mới/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeDisabled();

    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã sửa xong máy');

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });
    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Sửa xong', { timeout: 10_000 });

    await cleanup(token, request, freshCustomerId);
  });

  test('TC-22: on a TRA_HANG order, the shortcut selects HUY_TRA_MAY without a modal; Save then opens it and confirming transitions the order', async ({ page, request }) => {
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

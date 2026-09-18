/**
 * PW-07 — UI Polish (feat/ui-polish-cancel-button)
 *
 * Covers the UI polish changes:
 *   TC-01: DANG_BAO_HANH filter tab — "Đang bảo hành" tab is visible in orders list
 *   TC-02: TRA_HANG cancel button — visible only when order.status === 'TRA_HANG'
 *   TC-03: Clicking the cancel button selects HUY_TRA_MAY and scrolls to the
 *          evidence (notes + photo) section, without opening the ConfirmModal
 *          or a native browser dialog (RH: status-rules-da-giao-huy-tra-may)
 *   TC-04: ConfirmModal cancel keeps status unchanged
 *   TC-05: ConfirmModal confirm transitions order to HUY_TRA_MAY
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 */

import { test, expect } from './helpers/fixtures';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { EVIDENCE_REQUIRED_STATUSES, uploadCompletionImage, COMPLETION_IMAGE_FIXTURE } from './helpers/images';
import { uniqueNow } from './helpers/ids';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

// ---------------------------------------------------------------------------
// API helpers (mirrored from 05-order-status-flow.spec.ts)
// ---------------------------------------------------------------------------

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
  opts: { phone?: string } = {},
): Promise<SeedResult> {
  const runId = uniqueNow();
  const phone = opts.phone ?? `090${String(runId).slice(-7)}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-07 ${runId}`,
      address: 'Test Address PW-07',
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
      device_name: `Loa PW-07-${runId}`,
      serial_imei: `SN-PW07-${runId}`,
      fault_description: 'E2E test fault PW-07',
      quotation: 150000,
    },
  });
  const oBody = await oRes.json();
  return {
    orderId: oBody.data.id as string,
    orderCode: oBody.data.order_code as string,
    customerId,
  };
}

async function advanceStatus(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  orderId: string,
  status: string,
): Promise<void> {
  // DA_GIAO / HUY_TRA_MAY require a fresh COMPLETION image already on the
  // order before the status PUT is accepted (RH: status-rules-da-giao-huy-tra-may).
  // Notes are always sent below, satisfying the notes half of the rule.
  if (EVIDENCE_REQUIRED_STATUSES.includes(status)) {
    await uploadCompletionImage(request, token, orderId);
  }
  await request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status, notes: `E2E advance to ${status}` },
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
// TC-01: DANG_BAO_HANH filter tab exists in orders list
// ---------------------------------------------------------------------------

test.describe('TC-01: DANG_BAO_HANH filter tab appears in orders list', () => {
  test('filter tab "Đang bảo hành" is visible on /orders', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // The filter tab for DANG_BAO_HANH must be visible
    const tab = page.getByRole('button', { name: 'Đang bảo hành' });
    await expect(tab).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-02: TRA_HANG cancel button visible only for TRA_HANG orders
// ---------------------------------------------------------------------------

test.describe('TC-02: "Huỷ trả máy" cancel button visibility', () => {
  let token: string;
  let traHangOrderId: string;
  let traHangCustomerId: string;
  let tiepNhanOrderId: string;
  let tiepNhanCustomerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    // Seed and advance first order to TRA_HANG
    ({ orderId: traHangOrderId, customerId: traHangCustomerId } = await seedOrder(token, request));
    await advanceStatus(token, request, traHangOrderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, traHangOrderId, 'BAO_GIA');
    await advanceStatus(token, request, traHangOrderId, 'TRA_HANG');

    // Seed second order — leave at TIEP_NHAN
    ({ orderId: tiepNhanOrderId, customerId: tiepNhanCustomerId } = await seedOrder(token, request));
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, traHangCustomerId);
    await cleanup(token, request, tiepNhanCustomerId);
  });

  test('"Huỷ trả máy" button is visible for a TRA_HANG order', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${traHangOrderId}`);

    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  });

  test('"Huỷ trả máy" button is NOT visible for a TIEP_NHAN order', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${tiepNhanOrderId}`);

    // Wait for order to load (status badge must be present)
    await expect(page.getByTestId('order-status-badge')).toBeVisible({ timeout: 10_000 });

    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// TC-03: Clicking cancel button opens ConfirmModal (no browser dialog)
// ---------------------------------------------------------------------------

test.describe('TC-03: Clicking "Huỷ trả máy" selects the status without opening a dialog', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'TRA_HANG');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('selects HUY_TRA_MAY and scrolls to evidence fields; no modal or native dialog until Save', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Track whether a native browser dialog was triggered
    let nativeDialogFired = false;
    page.on('dialog', () => { nativeDialogFired = true; });

    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();

    // RH: status-rules-da-giao-huy-tra-may — the shortcut now only selects
    // HUY_TRA_MAY and scrolls the notes/photo evidence section into view; it
    // no longer jumps straight to the ConfirmModal (which would always fail
    // without evidence).
    await expect(page.locator('select')).toHaveValue('HUY_TRA_MAY');
    await expect(page.getByRole('button', { name: 'Xác nhận' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Thêm ghi chú...')).toBeInViewport();
    expect(nativeDialogFired).toBe(false);

    // Badge is unchanged — no update has been sent yet
    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Trả hàng', { timeout: 5_000 });

    // Save stays disabled until both notes and a photo are provided...
    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeDisabled();

    // ...then Save opens the ConfirmModal, same as before.
    await page.getByPlaceholder('Thêm ghi chú...').fill('Khách không đồng ý, huỷ đơn');
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const confirmBtn = page.getByRole('button', { name: 'Xác nhận' });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    expect(nativeDialogFired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TC-04: ConfirmModal cancel keeps status unchanged
// ---------------------------------------------------------------------------

test.describe('TC-04: ConfirmModal "Huỷ" keeps order status unchanged', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'TRA_HANG');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('clicking "Huỷ" in modal dismisses it and leaves badge as "Trả hàng"', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Select HUY_TRA_MAY, fill the required notes + photo evidence, then
    // Save to open the modal (RH: status-rules-da-giao-huy-tra-may).
    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await page.getByPlaceholder('Thêm ghi chú...').fill('Khách không đồng ý, huỷ đơn');
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeEnabled();
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();

    // Modal is open — click the "Huỷ" dismiss button
    const dismissBtn = page.getByRole('button', { name: 'Huỷ' }).last();
    await expect(dismissBtn).toBeVisible({ timeout: 5_000 });
    await dismissBtn.click();

    // Modal must be gone
    await expect(page.getByRole('button', { name: 'Xác nhận' })).toHaveCount(0);

    // Badge must still read "Trả hàng"
    await expect(badge).toContainText('Trả hàng');

    // The "Huỷ trả máy" cancel button must still be visible (status unchanged)
    await expect(cancelBtn).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// TC-05: ConfirmModal confirm transitions to HUY_TRA_MAY
// ---------------------------------------------------------------------------

test.describe('TC-05: ConfirmModal "Xác nhận" transitions order to HUY_TRA_MAY', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'TRA_HANG');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('confirming in modal updates badge to "Huỷ trả máy" and hides select dropdown', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Select HUY_TRA_MAY, fill the required notes + photo evidence, then
    // Save to open the modal (RH: status-rules-da-giao-huy-tra-may).
    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();
    await page.getByPlaceholder('Thêm ghi chú...').fill('Khách không đồng ý, huỷ đơn');
    await page.locator('input[type="file"]').setInputFiles(COMPLETION_IMAGE_FIXTURE);
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toBeEnabled();
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();

    // Click the red "Xác nhận" button inside the modal
    const confirmBtn = page.getByRole('button', { name: 'Xác nhận' });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();

    // Badge must update to "Huỷ trả máy"
    await expect(badge).toContainText('Huỷ trả máy', { timeout: 10_000 });

    // HUY_TRA_MAY is a terminal status — the select dropdown must be gone
    await expect(page.locator('select')).toHaveCount(0);
  });
});

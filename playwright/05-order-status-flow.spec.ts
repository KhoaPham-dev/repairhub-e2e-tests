/**
 * PW-06 — Order Status Flow v2 (RH-30)
 *
 * Covers the branching workflow redesign:
 *   TC-01: Flow 1 status progression — all six Flow 1 statuses appear in
 *          the dropdown and the badge updates correctly after each transition
 *   TC-02: Flow 2 TRA_HANG path — from BAO_GIA status, selecting Trả hàng
 *          and saving updates the status badge to Trả hàng
 *   TC-03: HUY_TRA_MAY confirmation dialog — dismiss cancels, accept applies
 *   TC-04: Phone tel: link — valid phone number renders as <a href="tel:...">
 *   TC-05: Terminal status (DA_GIAO) — status dropdown is not shown
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';

// ---------------------------------------------------------------------------
// API helpers
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

/**
 * Seed a customer + order and return their IDs.
 * @param phone  Override phone; defaults to a generated unique number.
 */
async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  opts: { phone?: string } = {},
): Promise<SeedResult> {
  const runId = Date.now();
  const phone = opts.phone ?? `090${String(runId).slice(-7)}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-06 ${runId}`,
      address: 'Test Address PW-06',
      type: 'RETAIL',
    },
  });
  const cBody = await cRes.json();
  const customerId = cBody.data.id as string;

  // Fetch first existing branch
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
      device_name: `Loa PW-06-${runId}`,
      serial_imei: `SN-PW06-${runId}`,
      fault_description: 'E2E test fault PW-06',
      quotation: 200000,
    },
  });
  const oBody = await oRes.json();
  return {
    orderId: oBody.data.id as string,
    orderCode: oBody.data.order_code as string,
    customerId,
  };
}

/** Advance an order to a target status via the API. */
async function advanceStatus(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  orderId: string,
  status: string,
): Promise<void> {
  await request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status, notes: `E2E advance to ${status}` },
  });
}

/** Best-effort customer deletion (cascades to orders). */
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
// TC-01: Flow 1 status progression
// ---------------------------------------------------------------------------

test.describe('TC-01: Flow 1 — status progression (RH-30 AC-1)', () => {
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

  test('all Flow 1 statuses appear in the status dropdown', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // The status dropdown is inside "Cập nhật trạng thái" card
    const select = page.locator('select');
    await expect(select).toBeVisible({ timeout: 10_000 });

    const flow1Labels = [
      'Tiếp nhận',
      'Kiểm tra',
      'Báo giá',
      'Đang sửa',
      'Sửa xong',
      'Đã giao',
    ];

    for (const label of flow1Labels) {
      await expect(select.locator(`option:has-text("${label}")`)).toHaveCount(1);
    }
  });

  test('status badge updates after transitioning TIEP_NHAN → DANG_KIEM_TRA', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Initial status badge: Tiếp nhận
    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Tiếp nhận', { timeout: 10_000 });

    // Select DANG_KIEM_TRA
    await page.locator('select').selectOption({ label: 'Kiểm tra' });

    // Save
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();

    // Success message appears
    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });

    // Badge now shows Kiểm tra
    await expect(badge).toContainText('Kiểm tra', { timeout: 10_000 });
  });

  test('status badge updates after transitioning DANG_KIEM_TRA → BAO_GIA', async ({
    page,
    request,
  }) => {
    // Ensure order is at DANG_KIEM_TRA before this test
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Kiểm tra', { timeout: 10_000 });

    await page.locator('select').selectOption({ label: 'Báo giá' });
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();
    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText('Báo giá', { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-02: Flow 2 — TRA_HANG path
// ---------------------------------------------------------------------------

test.describe('TC-02: Flow 2 — TRA_HANG path from BAO_GIA (RH-30 AC-2)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    // Advance to BAO_GIA so Flow 2 branch is available
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('selecting Trả hàng from BAO_GIA updates status badge', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Báo giá', { timeout: 10_000 });

    // Select TRA_HANG — label is "Trả hàng"
    await page.locator('select').selectOption({ label: 'Trả hàng' });
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();
    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-03: HUY_TRA_MAY confirmation dialog
// ---------------------------------------------------------------------------

test.describe('TC-03: HUY_TRA_MAY confirmation dialog (RH-30 AC-3)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    // Advance to TRA_HANG so HUY_TRA_MAY is the logical next step
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'TRA_HANG');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('dismissing the confirm dialog leaves status unchanged', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Set up dialog handler to DISMISS (cancel)
    page.once('dialog', (dialog) => dialog.dismiss());

    // Select HUY_TRA_MAY
    await page.locator('select').selectOption({ label: 'Huỷ trả máy' });
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();

    // After dismiss, status should remain Trả hàng
    // Wait briefly to confirm no success message and badge unchanged
    await page.waitForTimeout(1500);
    await expect(badge).toContainText('Trả hàng');
    // No success banner should appear
    await expect(page.getByText('Cập nhật thành công')).toHaveCount(0);
  });

  test('accepting the confirm dialog changes status to Huỷ trả máy', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Set up dialog handler to ACCEPT
    page.once('dialog', (dialog) => dialog.accept());

    await page.locator('select').selectOption({ label: 'Huỷ trả máy' });
    await page.getByRole('button', { name: /Lưu thay đổi/i }).click();

    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText('Huỷ trả máy', { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-04: Phone tel: link
// ---------------------------------------------------------------------------

test.describe('TC-04: phone number renders as tel: link (RH-30 AC-4)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;
  const validPhone = '0901234567';

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request, { phone: validPhone }));
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('valid phone number is rendered as <a href="tel:..."> link', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Wait for order data to load (device name is a reliable sentinel)
    await expect(page.getByText(/Loa PW-06/)).toBeVisible({ timeout: 10_000 });

    // The phone anchor must have href starting with tel:
    const telLink = page.locator(`a[href="tel:${validPhone}"]`);
    await expect(telLink).toBeVisible({ timeout: 8_000 });
    await expect(telLink).toContainText(validPhone);
  });
});

// ---------------------------------------------------------------------------
// TC-05: Terminal status — dropdown not shown
// ---------------------------------------------------------------------------

test.describe('TC-05: terminal status DA_GIAO hides status dropdown (RH-30 AC-1)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request));
    // Advance through Flow 1 to DA_GIAO
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'DANG_SUA_CHUA');
    await advanceStatus(token, request, orderId, 'SUA_XONG');
    await advanceStatus(token, request, orderId, 'DA_GIAO');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('status dropdown is not rendered when order is at terminal status DA_GIAO', async ({
    page,
  }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Badge shows Đã giao
    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    // The editable section (including the select dropdown) must be absent
    await expect(page.locator('select')).toHaveCount(0);

    // "Lưu thay đổi" save button must also be absent
    await expect(page.getByRole('button', { name: /Lưu thay đổi/i })).toHaveCount(0);
  });
});

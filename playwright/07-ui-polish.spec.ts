/**
 * PW-07 — UI Polish (feat/ui-polish-cancel-button)
 *
 * Covers the UI polish changes:
 *   TC-01: DANG_BAO_HANH filter tab — "Đang bảo hành" tab is visible in orders list
 *   TC-02: TRA_HANG cancel button — visible only when order.status === 'TRA_HANG'
 *   TC-03: Clicking cancel button opens ConfirmModal (not a browser dialog)
 *   TC-04: ConfirmModal cancel keeps status unchanged
 *   TC-05: ConfirmModal confirm transitions order to HUY_TRA_MAY
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';

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
  const runId = Date.now();
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
    await expect(page.locator('span.bg-blue-100')).toBeVisible({ timeout: 10_000 });

    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// TC-03: Clicking cancel button opens ConfirmModal (no browser dialog)
// ---------------------------------------------------------------------------

test.describe('TC-03: Clicking "Huỷ trả máy" opens ConfirmModal, not a browser dialog', () => {
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

  test('ConfirmModal appears with "Xác nhận" button; no native browser dialog fires', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Track whether a native browser dialog was triggered
    let nativeDialogFired = false;
    page.on('dialog', () => { nativeDialogFired = true; });

    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();

    // The custom ConfirmModal must appear — it contains an "Xác nhận" button
    const confirmBtn = page.getByRole('button', { name: 'Xác nhận' });
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });

    // No native browser dialog should have been triggered
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

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Open modal
    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();

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

    const badge = page.locator('span.bg-blue-100');
    await expect(badge).toContainText('Trả hàng', { timeout: 10_000 });

    // Open the ConfirmModal via the cancel button
    const cancelBtn = page.getByRole('button', { name: 'Huỷ trả máy' });
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await cancelBtn.click();

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

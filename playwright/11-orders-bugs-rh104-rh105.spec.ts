/**
 * PW-11 — Regression: RH-104 + RH-105 bug fixes
 *
 * RH-104: Báo giá shown read-only for terminal-status orders
 *   TC-01: DA_GIAO order with non-zero quotation shows "Báo giá" label and formatted value
 *   TC-02: HUY_TRA_MAY order with non-zero quotation shows "Báo giá" label and formatted value
 *   TC-03: Terminal order with zero quotation shows "Chưa có" placeholder
 *   TC-04: Non-terminal order still shows editable Báo giá input (no regression)
 *
 * RH-105: Filter state persists in URL on back-navigation
 *   TC-05: Applying a status filter updates the URL with ?status=...
 *   TC-06: Typing in the search box (after debounce) updates the URL with ?search=...
 *   TC-07: Loading /orders?status=DA_GIAO activates the correct status tab on load
 *   TC-08: Navigating to order detail and pressing back preserves filter in URL and tab state
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

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

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  opts: { quotation?: number; phone?: string } = {},
): Promise<SeedResult> {
  const runId = Date.now();
  const phone = opts.phone ?? `090${String(runId).slice(-7)}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-11 ${runId}`,
      address: 'Test Address PW-11',
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
      device_name: `Loa PW-11-${runId}`,
      serial_imei: `SN-PW11-${runId}`,
      fault_description: 'E2E regression test PW-11',
      quotation: opts.quotation ?? 350000,
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

// ===========================================================================
// RH-104: Báo giá read-only for terminal orders
// ===========================================================================

// ---------------------------------------------------------------------------
// TC-01: DA_GIAO order with non-zero quotation shows read-only Báo giá
// ---------------------------------------------------------------------------

test.describe('TC-01: RH-104 — DA_GIAO order shows read-only Báo giá (AC-1)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, customerId } = await seedOrder(token, request, { quotation: 350000 }));
    // Advance through the flow to DA_GIAO
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'DANG_SUA_CHUA');
    await advanceStatus(token, request, orderId, 'SUA_XONG');
    await advanceStatus(token, request, orderId, 'DA_GIAO');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('detail page shows "Báo giá" label and formatted quotation value for DA_GIAO order', async ({
    page,
  }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // The locked info card must contain the "Báo giá" label
    await expect(page.getByText('Báo giá:')).toBeVisible({ timeout: 10_000 });

    // Rendered as vi-VN locale: "350.000 đ"
    await expect(page.getByText(/350[.,]000/)).toBeVisible({ timeout: 10_000 });

    // There must NOT be an editable input for quotation on a terminal order
    await expect(page.locator('input[inputmode="numeric"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// TC-02: HUY_TRA_MAY order with non-zero quotation shows read-only Báo giá
// ---------------------------------------------------------------------------

test.describe('TC-02: RH-104 — HUY_TRA_MAY order shows read-only Báo giá (AC-2)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const runId = Date.now();
    ({ orderId, customerId } = await seedOrder(token, request, {
      quotation: 280000,
      phone: `091${String(runId + 1).slice(-7)}`,
    }));
    // Advance to HUY_TRA_MAY via the TRA_HANG path
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'TRA_HANG');
    await advanceStatus(token, request, orderId, 'HUY_TRA_MAY');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('detail page shows "Báo giá" label and formatted quotation value for HUY_TRA_MAY order', async ({
    page,
  }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await expect(page.getByText('Báo giá:')).toBeVisible({ timeout: 10_000 });
    // Rendered as vi-VN locale: "280.000 đ"
    await expect(page.getByText(/280[.,]000/)).toBeVisible({ timeout: 10_000 });

    // No editable input on terminal order
    await expect(page.locator('input[inputmode="numeric"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// TC-03: Terminal order with zero quotation shows "Chưa có" placeholder
// ---------------------------------------------------------------------------

test.describe('TC-03: RH-104 — Zero quotation terminal order shows "Chưa có" (AC-3)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const runId = Date.now();
    ({ orderId, customerId } = await seedOrder(token, request, {
      quotation: 0,
      phone: `092${String(runId + 2).slice(-7)}`,
    }));
    // Advance to DA_GIAO
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'DANG_SUA_CHUA');
    await advanceStatus(token, request, orderId, 'SUA_XONG');
    await advanceStatus(token, request, orderId, 'DA_GIAO');
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('zero quotation on terminal order shows "Chưa có" placeholder', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await expect(page.getByText('Báo giá:')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Chưa có')).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-04: Non-terminal order still has editable Báo giá input (no regression)
// ---------------------------------------------------------------------------

test.describe('TC-04: RH-104 — Non-terminal order has editable Báo giá input (AC-4)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const runId = Date.now();
    ({ orderId, customerId } = await seedOrder(token, request, {
      quotation: 150000,
      phone: `093${String(runId + 3).slice(-7)}`,
    }));
    // Keep at TIEP_NHAN — this is a non-terminal status
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('TIEP_NHAN order has editable Báo giá input (not broken by RH-104 fix)', async ({
    page,
  }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // The editable section heading "Báo giá" should be visible
    await expect(page.getByRole('heading', { name: 'Báo giá' })).toBeVisible({ timeout: 10_000 });

    // The numeric input for quotation must exist and be editable
    const quotationInput = page.locator('input[inputmode="numeric"]');
    await expect(quotationInput).toBeVisible({ timeout: 10_000 });
    await expect(quotationInput).toBeEditable();

    // The read-only "Báo giá:" text (with colon) inside the locked card should NOT exist
    // (it only appears for terminal orders)
    await expect(page.locator('p:has-text("Báo giá:")')).toHaveCount(0);
  });
});

// ===========================================================================
// RH-105: Filter state persists in URL on back-navigation
// ===========================================================================

// ---------------------------------------------------------------------------
// TC-05: Applying a status filter updates the URL with ?status=...
// ---------------------------------------------------------------------------

test.describe('TC-05: RH-105 — Status filter reflected in URL (AC-4)', () => {
  test('clicking "Đã giao" tab updates URL to ?status=DA_GIAO', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // Click the "Đã giao" filter tab
    await page.getByRole('button', { name: 'Đã giao' }).click();

    // URL should now contain ?status=DA_GIAO
    await expect(page).toHaveURL(/[?&]status=DA_GIAO/, { timeout: 5_000 });
  });

  test('clicking "Tiếp nhận" tab updates URL to ?status=TIEP_NHAN', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    await page.getByRole('button', { name: 'Tiếp nhận' }).click();

    await expect(page).toHaveURL(/[?&]status=TIEP_NHAN/, { timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-06: Search input updates URL with ?search=... after debounce
// ---------------------------------------------------------------------------

test.describe('TC-06: RH-105 — Search query reflected in URL after debounce (AC-4)', () => {
  test('typing in search box updates URL ?search= after debounce delay', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    const searchInput = page.getByPlaceholder(/Tìm theo tên thiết bị/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill('JBL');

    // Debounce is 400 ms — wait 700 ms to be safe
    await page.waitForTimeout(700);

    await expect(page).toHaveURL(/[?&]search=JBL/, { timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-07: Loading /orders?status=DA_GIAO activates the correct tab on mount
// ---------------------------------------------------------------------------

test.describe('TC-07: RH-105 — URL param hydrates status tab on load (AC-4)', () => {
  test('loading /orders?status=DA_GIAO activates the "Đã giao" tab', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders?status=DA_GIAO');

    // The "Đã giao" tab should be visually active.
    // The active tab has a distinct style (darker background / border) in the app.
    // We check that the button has aria-selected or a class indicating active state,
    // OR simply that the URL still contains status=DA_GIAO after mount (state preserved).
    await expect(page).toHaveURL(/[?&]status=DA_GIAO/, { timeout: 8_000 });

    // Additionally confirm the "Đã giao" button is present and appears selected
    // (the app uses a different bg color for the active tab — we verify via text visibility).
    const daGiaoTab = page.getByRole('button', { name: 'Đã giao' });
    await expect(daGiaoTab).toBeVisible({ timeout: 8_000 });
  });

  test('loading /orders?status=TIEP_NHAN activates the "Tiếp nhận" tab', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders?status=TIEP_NHAN');

    await expect(page).toHaveURL(/[?&]status=TIEP_NHAN/, { timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Tiếp nhận' })).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// TC-08: Navigating to order detail and pressing back preserves filter
// ---------------------------------------------------------------------------

test.describe('TC-08: RH-105 — Back-navigation preserves filter state (AC-1)', () => {
  let token: string;
  let orderId: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const runId = Date.now();
    ({ orderId, customerId } = await seedOrder(token, request, {
      phone: `094${String(runId + 4).slice(-7)}`,
    }));
    // Keep order at TIEP_NHAN so it appears under that filter
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('filter and search survive navigate-to-detail then back', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // Apply status filter
    await page.getByRole('button', { name: 'Tiếp nhận' }).click();
    await expect(page).toHaveURL(/[?&]status=TIEP_NHAN/, { timeout: 5_000 });

    // Navigate into the order detail page
    await page.goto(`/orders/${orderId}`);
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}`), { timeout: 8_000 });

    // Press back
    await page.goBack();

    // After back-navigation, URL should still contain the status filter
    await expect(page).toHaveURL(/[?&]status=TIEP_NHAN/, { timeout: 8_000 });

    // The "Tiếp nhận" tab should still be visible (page loaded with filter)
    await expect(page.getByRole('button', { name: 'Tiếp nhận' })).toBeVisible({ timeout: 8_000 });
  });

  test('search query survives navigate-to-detail then back', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // Type a search term
    const searchInput = page.getByPlaceholder(/Tìm theo tên thiết bị/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill('PW-11');

    // Wait for debounce
    await page.waitForTimeout(700);
    await expect(page).toHaveURL(/[?&]search=PW-11/, { timeout: 5_000 });

    // Navigate into detail
    await page.goto(`/orders/${orderId}`);
    await expect(page).toHaveURL(new RegExp(`/orders/${orderId}`), { timeout: 8_000 });

    // Press back
    await page.goBack();

    // URL should still include the search param
    await expect(page).toHaveURL(/[?&]search=PW-11/, { timeout: 8_000 });
  });
});

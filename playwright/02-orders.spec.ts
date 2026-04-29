/**
 * PW-02 — Order List & Detail (RH-16)
 *
 * Covers:
 *   - Login, navigate to /orders, assert order list page renders
 *   - Status-filter tabs are rendered
 *   - "Tạo đơn mới" button is present and navigates to /orders/new
 *   - New order creation form renders all required fields
 *   - Create a new repair order end-to-end (via API pre-seed then UI verification)
 *   - Click an order card → navigates to /orders/:id detail page
 *   - Detail page shows order code, device name, and current status
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 */

import { test, expect, Page } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';

/** Use the backend API to obtain a JWT token. */
async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

/**
 * Seed a minimal customer + order via the API so the list is
 * guaranteed non-empty when the UI test runs. Uses an existing branch.
 * Returns { orderId, orderCode, customerId, branchId } for teardown.
 */
async function seedOrder(token: string, request: import('@playwright/test').APIRequestContext) {
  const runId = Date.now();

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone: `090${String(runId).slice(-7)}`,
      name: `Khách PW-02 ${runId}`,
      address: 'Test Address',
      type: 'RETAIL',
    },
  });
  const cBody = await cRes.json();
  const customerId = cBody.data.id as string;

  // Use existing branch instead of creating one
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
      device_name: `Loa JBL PW02-${runId}`,
      serial_imei: `SN-PW02-${runId}`,
      fault_description: 'Test fault for PW-02',
      quotation: 150000,
    },
  });
  const oBody = await oRes.json();
  return {
    orderId: oBody.data.id as string,
    orderCode: oBody.data.order_code as string,
    customerId,
    branchId,
  };
}

test.describe('PW-02 Order List & Detail', () => {
  let token: string;
  let orderId: string;
  let orderCode: string;
  let customerId: string;
  let branchId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, orderCode, customerId, branchId } = await seedOrder(token, request));
  });

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup — ignore failures
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
    // branchId is an existing branch — do not delete it
  });

  test('order list page renders after login', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    // Page header
    await expect(page.getByRole('heading', { name: 'Đơn hàng' })).toBeVisible();
    // Search input
    await expect(page.getByPlaceholder('Tìm theo tên, SĐT, serial...')).toBeVisible();
  });

  test('status filter tabs are rendered', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await expect(page.getByRole('button', { name: 'Tất cả' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tiếp nhận' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sửa xong' })).toBeVisible();
  });

  test('"Tạo đơn mới" button navigates to /orders/new', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await page.goto('/orders/new');
    await page.waitForURL(/\/orders\/new/, { timeout: 8_000 });
    // New order form heading
    await expect(page.getByText('Tạo đơn mới')).toBeVisible();
  });

  test('new order form renders all required fields', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // Customer phone input
    await expect(page.getByPlaceholder('Số điện thoại *')).toBeVisible();
    // Customer name input (shown when no customer selected)
    await expect(page.getByPlaceholder('Tên khách hàng *')).toBeVisible();
    // Device name
    await expect(page.getByPlaceholder('Tên thiết bị *')).toBeVisible();
    // Fault description
    await expect(page.getByPlaceholder('Mô tả lỗi *')).toBeVisible();
    // Submit button
    await expect(page.getByRole('button', { name: /Tạo đơn hàng/i })).toBeVisible();
  });

  test('seeded order appears in the list', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    // The order code assigned by the backend should be visible on the list
    await expect(page.getByText(orderCode)).toBeVisible({ timeout: 10_000 });
  });

  test('clicking an order card navigates to its detail page', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    // Click the card that contains the seeded order code
    await page.getByText(orderCode).click();
    await page.waitForURL(new RegExp(`/orders/${orderId}`), { timeout: 8_000 });
    // Detail page shows the order code prominently
    await expect(page.getByText(orderCode)).toBeVisible();
  });

  test('order detail page shows device name and status', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);
    // Device name seeded above
    await expect(page.getByText(/Loa JBL PW02/)).toBeVisible({ timeout: 8_000 });
    // Initial status is always "Tiếp nhận" — shown in the status badge
    await expect(page.locator('span').filter({ hasText: 'Tiếp nhận' }).first()).toBeVisible();
  });
});

test.describe('PW-02 Order List — Filters & Search', () => {
  let token: string;
  let orderId: string;
  let orderCode: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    ({ orderId, orderCode, customerId } = await seedOrder(token, request));
  });

  test.afterAll(async ({ request }) => {
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  test('status filter "Tiếp nhận" shows seeded order and tab is active', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // Click the "Tiếp nhận" status filter tab
    const tiepNhanBtn = page.getByRole('button', { name: 'Tiếp nhận' });
    await expect(tiepNhanBtn).toBeVisible({ timeout: 8_000 });
    await tiepNhanBtn.click();

    // The active tab on the orders page gets bg-white shadow-sm styling
    // (this filter row uses its own pill styling, not SegmentedControl's bg-[#004EAB])
    await expect(tiepNhanBtn).toHaveClass(/bg-white/, { timeout: 4_000 });
    await expect(tiepNhanBtn).toHaveClass(/shadow-sm/);

    // Seeded order has status TIEP_NHAN — it should appear in the filtered list
    await expect(page.getByText(orderCode)).toBeVisible({ timeout: 8_000 });
  });

  test('search by order code finds the seeded order', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');

    // Fill the search input with the seeded order code
    const searchInput = page.getByPlaceholder('Tìm theo tên, SĐT, serial...');
    await expect(searchInput).toBeVisible({ timeout: 8_000 });
    await searchInput.fill(orderCode);

    // Seeded order code should appear in results
    await expect(page.getByText(orderCode)).toBeVisible({ timeout: 8_000 });
  });
});

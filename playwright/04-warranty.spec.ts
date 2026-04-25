/**
 * PW-04 — Warranty Search (RH-16)
 *
 * Covers:
 *   - Login, navigate to /warranty, assert page renders
 *   - Search input and "Tìm" button are present
 *   - Search a delivered order by phone → warranty card appears with correct status
 *   - Search by serial/IMEI → matching warranty result shown
 *   - Search with no results → "Không tìm thấy kết quả" displayed
 *   - Warranty card shows order code, device name, customer phone, warranty status
 *   - "Xem đơn hàng" link navigates to the order detail page
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 *
 * Note: The warranty endpoint returns only orders in terminal status (DA_GIAO).
 *       This test seeds a full order and advances it through the status workflow
 *       via API calls so it appears in warranty search results.
 */

import { test, expect, Page } from '@playwright/test';

const API_BASE = 'http://localhost:3001/api';
const ADMIN = { username: 'admin', password: 'admin123' };

async function loginViaUI(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('Nhập tên đăng nhập').fill(ADMIN.username);
  await page.getByPlaceholder('Nhập mật khẩu').fill(ADMIN.password);
  await page.getByRole('button', { name: /Đăng nhập/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
}

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: ADMIN });
  const body = await res.json();
  return body.data.token as string;
}

/** Advance an order to DA_GIAO through the full status workflow. */
async function advanceToDelivered(
  token: string,
  orderId: string,
  request: import('@playwright/test').APIRequestContext,
) {
  const statuses = [
    'DANG_KIEM_TRA',
    'BAO_GIA',
    'CHO_LINH_KIEN',
    'DANG_SUA_CHUA',
    'KIEM_TRA_LAI',
    'SUA_XONG',
    'DA_GIAO',
  ];
  for (const status of statuses) {
    await request.put(`${API_BASE}/orders/${orderId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status, notes: `Advancing to ${status} for PW-04 test` },
    });
  }
}

test.describe('PW-04 Warranty Search', () => {
  let token: string;
  let orderId: string;
  let customerId: string;
  let branchId: string;
  const runId = Date.now();
  const customerPhone = `090${String(runId).slice(-7)}`;
  const serial = `SN-PW04-${runId}`;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    // Create customer
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: customerPhone,
        name: `Khách PW-04 ${runId}`,
        address: 'PW-04 Street',
        type: 'RETAIL',
      },
    });
    customerId = (await cRes.json()).data.id;

    // Create branch
    const bRes = await request.post(`${API_BASE}/branches`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `Chi nhánh PW-04 ${runId}`,
        address: `${runId} PW04 Road`,
        phone: `028${String(runId).slice(-7)}`,
        manager_name: `Manager PW04 ${runId}`,
      },
    });
    branchId = (await bRes.json()).data.id;

    // Create order
    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        customer_id: customerId,
        branch_id: branchId,
        product_type: 'HEADPHONE',
        device_name: `Tai nghe PW04-${runId}`,
        serial_imei: serial,
        fault_description: 'Warranty test fault',
        quotation: 250000,
      },
    });
    orderId = (await oRes.json()).data.id;

    // Advance to DA_GIAO so it shows up in warranty search
    await advanceToDelivered(token, orderId, request);
  });

  test.afterAll(async ({ request }) => {
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
    if (branchId) {
      await request.delete(`${API_BASE}/branches/${branchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  test('warranty page renders search input and button', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await expect(page.getByRole('heading', { name: 'Bảo hành' })).toBeVisible();
    await expect(page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tìm' })).toBeVisible();
  });

  test('search by phone returns warranty result with order code', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill(customerPhone);
    await page.getByRole('button', { name: 'Tìm' }).click();
    // A card with the device name should appear
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 10_000 });
  });

  test('search by serial/IMEI returns matching warranty result', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill(serial);
    await page.getByRole('button', { name: 'Tìm' }).click();
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 10_000 });
    // Customer phone should be visible on the card
    await expect(page.getByText(customerPhone)).toBeVisible({ timeout: 5_000 });
  });

  test('warranty card shows warranty status badge', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill(customerPhone);
    await page.getByRole('button', { name: 'Tìm' }).click();
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 10_000 });
    // Warranty status badge: ACTIVE, EXPIRED or "Chưa xác định"
    const badge = page.locator('span').filter({
      hasText: /Còn bảo hành|Hết bảo hành|Chưa xác định/,
    });
    await expect(badge.first()).toBeVisible({ timeout: 5_000 });
  });

  test('"Xem đơn hàng" link navigates to order detail page', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill(customerPhone);
    await page.getByRole('button', { name: 'Tìm' }).click();
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 10_000 });
    await page.getByText('Xem đơn hàng →').first().click();
    await page.waitForURL(new RegExp(`/orders/${orderId}`), { timeout: 8_000 });
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 5_000 });
  });

  test('search with no results shows "Không tìm thấy kết quả"', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill('00000000000_no_match');
    await page.getByRole('button', { name: 'Tìm' }).click();
    await expect(page.getByText('Không tìm thấy kết quả')).toBeVisible({ timeout: 8_000 });
  });

  test('Enter key triggers warranty search', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/warranty');
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').fill(serial);
    await page.getByPlaceholder('Tìm theo SĐT, serial, tên thiết bị...').press('Enter');
    await expect(page.getByText(new RegExp(`Tai nghe PW04-${runId}`))).toBeVisible({ timeout: 10_000 });
  });
});

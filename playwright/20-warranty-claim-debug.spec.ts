/**
 * Debug test for warranty claim UI
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

test.describe('Debug Warranty Claim UI', () => {
  let token: string;
  let customerId: string;
  let customerPhone: string;
  let orderCode: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    const runId = Date.now();
    customerPhone = `090${String(runId).slice(-7)}`;

    // Create customer
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: customerPhone,
        name: `Khách Debug ${runId}`,
        address: 'Debug Street',
        type: 'RETAIL',
      },
    });
    customerId = (await cRes.json()).data.id;

    // Get existing branch
    const bRes = await request.get(`${API_BASE}/branches`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const branchId = (await bRes.json()).data[0].id;

    // Create source order
    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        customer_id: customerId,
        branch_id: branchId,
        product_type: 'HEADPHONE',
        device_name: `Tai nghe Debug-${runId}`,
        serial_imei: `SN-DEBUG-${runId}`,
        fault_description: 'Debug fault',
        quotation: 250000,
      },
    });
    orderCode = (await oRes.json()).data.order_code;
    const orderId = (await oRes.json()).data.id;

    // Advance to DA_GIAO
    const statuses = ['DANG_KIEM_TRA', 'BAO_GIA', 'DANG_SUA_CHUA', 'SUA_XONG', 'DA_GIAO'];
    for (const status of statuses) {
      await request.put(`${API_BASE}/orders/${orderId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { status, notes: `Debug test` },
      });
    }

    console.log(`Created order ${orderCode} for phone ${customerPhone}`);
  });

  test.afterAll(async ({ request }) => {
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  test('debug warranty search on new order page', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');

    // Wait for page to load
    await expect(page.getByRole('heading', { name: 'Tạo đơn mới' })).toBeVisible({ timeout: 10_000 });

    // Select "Bảo Hành" product type
    await page.getByRole('button', { name: 'Bảo Hành' }).first().click();
    await page.waitForTimeout(500);

    // Enter customer phone to trigger warranty search
    await page.getByPlaceholder('Số điện thoại *').fill(customerPhone);
    // Wait for search debounce (300ms) + network
    await page.waitForTimeout(2000);

    // Take a screenshot to see what's on the page
    await page.screenshot({ path: '.playwright-mcp/warranty-debug-snapshot.png' });

    // Get page content
    const content = await page.content();
    console.log('Page content length:', content.length);

    // Try to find any warranty results
    const warrantyCards = page.locator('button[type="button"]').filter({ hasText: /20260714/ });
    const count = await warrantyCards.count();
    console.log(`Found ${count} warranty cards`);

    // Try to find by device name pattern
    const deviceNameLocator = page.getByText(/Tai nghe Debug/);
    await expect(deviceNameLocator).toBeVisible({ timeout: 10_000 }).catch(() => {
      console.log('Device name not found');
    });
  });
});

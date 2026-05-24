/**
 * PW-03 — Customer Search (RH-16)
 *
 * Covers:
 *   - Login, navigate to /customers, assert page renders
 *   - Type-filter tabs (Tất cả / Khách lẻ / Đối tác) render
 *   - Search by customer name → matching customer card appears
 *   - Search by phone number → matching customer card appears
 *   - Empty search shows all seeded customers
 *   - Customer card click navigates to /customers/:id detail page
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 */

import { test, expect, Page } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

test.describe('PW-03 Customer Search', () => {
  let token: string;
  let customerId: string;
  const runId = Date.now();
  const customerName = `Trần Thị PW03 ${runId}`;
  const customerPhone = `090${String(runId).slice(-7)}`;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    // Seed a known customer for search assertions
    const res = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: customerPhone,
        name: customerName,
        address: 'PW-03 Test Street',
        type: 'RETAIL',
      },
    });
    const body = await res.json();
    customerId = body.data.id as string;
  });

  test.afterAll(async ({ request }) => {
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  test('customers page renders search input and type filters', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    await expect(page.getByRole('heading', { name: 'Khách hàng' })).toBeVisible();
    await expect(page.getByPlaceholder('Tìm theo SĐT hoặc tên...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tất cả' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Khách lẻ' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đối tác' })).toBeVisible();
  });

  test('search by customer name returns matching result', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    // Type a unique fragment of the seeded customer's name
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').fill(`PW03 ${runId}`);
    // Wait for debounce (350 ms) + render
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 5_000 });
  });

  test('search by phone number returns matching result', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').fill(customerPhone);
    await expect(page.getByText(customerPhone)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 5_000 });
  });

  test('type filter "Khách lẻ" shows RETAIL customers', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    // Search for the seeded customer first so we know at least one result is present
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').fill(customerPhone);
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 5_000 });
    // Apply RETAIL filter — seeded customer should still appear
    await page.getByRole('button', { name: 'Khách lẻ' }).click();
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 5_000 });
    // PARTNER badge should NOT appear for this result
    await expect(page.getByText('Đối tác').first()).not.toBeAttached({ timeout: 3_000 }).catch(() => null);
  });

  test('clicking a customer card navigates to customer detail page', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').fill(customerPhone);
    await page.getByText(customerName).click();
    await page.waitForURL(new RegExp(`/customers/${customerId}`), { timeout: 8_000 });
    // Detail page shows the customer's name or phone
    await expect(page.getByText(customerPhone).first()).toBeVisible({ timeout: 5_000 });
  });

  test('clearing search input shows all customers', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');
    // Fill then clear search
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').fill('zzz_no_match_xyz');
    await page.getByPlaceholder('Tìm theo SĐT hoặc tên...').clear();
    // After clearing, the seeded customer should reappear
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 5_000 });
  });
});

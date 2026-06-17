/**
 * 16-edit-customer-type.spec.ts — Edit customer type (feat/edit-customer-type)
 *
 * Covers:
 *   TC-01 (UI+API): On the customer detail page, the edit form exposes a Loại
 *                   (Khách lẻ / Đối tác) toggle; switching RETAIL → PARTNER and saving
 *                   persists the new type (verified via API and in the read-only view).
 *
 * Prerequisites:
 *   - Backend running at http://localhost:6061
 *   - Frontend running at http://localhost:6060
 *   - Admin user: admin / admin123
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

test.describe('Edit customer type', () => {
  let token: string;
  let customerId: string;
  const runId = Date.now();

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const res = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone: `082${String(runId).slice(-7)}`, name: `Doi Loai E2E ${runId}`, type: 'RETAIL' },
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

  test('TC-01: switching Khách lẻ → Đối tác persists', async ({ page, request }) => {
    await loginViaUI(page);
    await page.goto(`/customers/${customerId}`);

    await expect(page.getByRole('button', { name: 'Chỉnh sửa' })).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Chỉnh sửa' }).click();

    // The Loại toggle is now interactive — pick Đối tác (PARTNER)
    const partnerToggle = page.getByRole('button', { name: 'Đối tác' });
    await expect(partnerToggle).toBeVisible({ timeout: 5_000 });
    await partnerToggle.click();

    await page.getByRole('button', { name: 'Lưu' }).click();

    // Read-only view should reflect the new type
    await expect(page.getByText('Loại:')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('p', { hasText: 'Loại:' })).toContainText('Đối tác');

    // Verify persisted server-side
    const getRes = await request.get(`${API_BASE}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const getBody = await getRes.json();
    expect(getBody.data.type).toBe('PARTNER');
  });
});

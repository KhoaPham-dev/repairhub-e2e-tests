/**
 * 15-duplicate-phone-add.spec.ts — Duplicate phone on Add Customer (feat/duplicate-phone-error)
 *
 * Covers:
 *   TC-01 (API): POST /customers with an existing phone returns 409 with
 *                { success: false, data: { existingCustomerId }, error: "Số điện thoại đã tồn tại" }
 *   TC-02 (UI):  Adding a customer (Đối tác) with an existing phone on /customers shows the
 *                mobile popup "Số điện thoại đã tồn tại" with a "Cập nhật thông tin" action
 *   TC-03 (UI):  Clicking "Cập nhật thông tin" navigates to the existing customer's update page,
 *                and the "Chỉnh sửa" edit button is available even for a Khách lẻ (RETAIL) customer
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

test.describe('Duplicate phone on Add Customer', () => {
  let token: string;
  let existingId: string;
  let existingPhone: string;
  const runId = Date.now();

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    // Seed a RETAIL (Khách lẻ) customer with no address/notes — the common case
    existingPhone = `081${String(runId).slice(-7)}`;
    const res = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone: existingPhone, name: `Khach Le E2E ${runId}`, type: 'RETAIL' },
    });
    const body = await res.json();
    existingId = body.data.id as string;
  });

  test.afterAll(async ({ request }) => {
    if (existingId) {
      await request.delete(`${API_BASE}/customers/${existingId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  // ---------------------------------------------------------------------------
  // TC-01: API returns 409 + existingCustomerId on duplicate phone create
  // ---------------------------------------------------------------------------
  test('TC-01: POST /customers with duplicate phone returns 409 + existingCustomerId', async ({ request }) => {
    const res = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone: existingPhone, name: 'Trung SDT', type: 'PARTNER' },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Số điện thoại đã tồn tại');
    expect(body.data?.existingCustomerId).toBe(existingId);
  });

  // ---------------------------------------------------------------------------
  // TC-02: Adding a Đối tác with an existing phone shows the duplicate popup
  // ---------------------------------------------------------------------------
  test('TC-02: Add form shows duplicate-phone popup', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');

    // Open the add form (header "+" button)
    await page.locator('button:has(svg.lucide-plus)').first().click();

    const form = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Thêm khách hàng' }) }).last();
    await expect(form.getByPlaceholder('Số điện thoại *')).toBeVisible({ timeout: 5_000 });

    await form.getByPlaceholder('Số điện thoại *').fill(existingPhone);
    await form.getByPlaceholder('Họ tên *').fill(`Doi Tac Trung ${runId}`);
    await form.getByRole('button', { name: 'Đối tác' }).click();
    await form.getByRole('button', { name: 'Lưu' }).click();

    // Popup must appear
    await expect(page.getByRole('heading', { name: 'Số điện thoại đã tồn tại' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole('button', { name: 'Cập nhật thông tin' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đóng' })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // TC-03: "Cập nhật thông tin" navigates to the update page; Khách lẻ is editable
  // ---------------------------------------------------------------------------
  test('TC-03: Navigate to update page and edit a Khách lẻ customer', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/customers');

    await page.locator('button:has(svg.lucide-plus)').first().click();
    const form = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Thêm khách hàng' }) }).last();
    await expect(form.getByPlaceholder('Số điện thoại *')).toBeVisible({ timeout: 5_000 });
    await form.getByPlaceholder('Số điện thoại *').fill(existingPhone);
    await form.getByPlaceholder('Họ tên *').fill(`Doi Tac Trung ${runId}`);
    await form.getByRole('button', { name: 'Lưu' }).click();

    await expect(page.getByRole('button', { name: 'Cập nhật thông tin' })).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Cập nhật thông tin' }).click();

    // Navigated to the existing customer's update page
    await expect(page).toHaveURL(new RegExp(`/customers/${existingId}$`), { timeout: 8_000 });

    // RETAIL (Khách lẻ) customers now expose the edit button + the edit form opens with the
    // correct dynamic "Loại" label (regression: it used to be hardcoded to "Đối tác")
    await expect(page.getByText('Khách lẻ')).toBeVisible({ timeout: 5_000 });
    const editBtn = page.getByRole('button', { name: 'Chỉnh sửa' });
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();
    await expect(page.getByRole('button', { name: 'Lưu' })).toBeVisible({ timeout: 5_000 });
  });
});

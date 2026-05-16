/**
 * partner-update.spec.ts — Partner Customer Update (feat/partner-update)
 *
 * Covers:
 *   TC-01: Admin can open a PARTNER customer detail page and see the "Chỉnh sửa" button
 *   TC-02: Admin edits name/phone/address/notes and saves — changes persist (re-fetch shows updated data)
 *   TC-03: Saving with a phone that belongs to another customer shows inline error
 *          "Số điện thoại đã tồn tại"
 *
 * KNOWN BUG (TC-02 FAIL):
 *   After a successful PUT save, saveEditing() calls setCustomer(res.data) where the PUT
 *   response does not include the 'orders' array. The page immediately crashes with:
 *     TypeError: Cannot read properties of undefined (reading 'length')
 *   at page.tsx (customer.orders.length in the order history card).
 *   The component shows no content after save.
 *   Fix required: preserve orders from previous state, or re-fetch full customer after save.
 *
 * Prerequisites:
 *   - Backend running at http://localhost:3001
 *   - Frontend running at http://localhost:3000
 *   - Admin user: admin / admin123
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

test.describe('Partner Customer Update', () => {
  let token: string;
  let partnerId: string;
  let partnerPhone: string;
  let otherCustomerId: string;
  let otherPhone: string;
  const runId = Date.now();

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    // Create the primary PARTNER customer used across TC-01 and TC-02
    partnerPhone = `091${String(runId).slice(-7)}`;
    const partnerRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: partnerPhone,
        name: `Doi Tac E2E ${runId}`,
        address: 'Dia chi ban dau',
        notes: 'Ghi chu ban dau',
        type: 'PARTNER',
      },
    });
    const partnerBody = await partnerRes.json();
    partnerId = partnerBody.data.id as string;

    // Create a second customer whose phone TC-03 will attempt to reuse
    otherPhone = `092${String(runId).slice(-7)}`;
    const otherRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: otherPhone,
        name: `Khach Khac E2E ${runId}`,
        address: '',
        notes: '',
        type: 'RETAIL',
      },
    });
    const otherBody = await otherRes.json();
    otherCustomerId = otherBody.data.id as string;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [partnerId, otherCustomerId]) {
      if (id) {
        await request.delete(`${API_BASE}/customers/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // TC-01: PARTNER detail page shows "Chỉnh sửa" button
  // ---------------------------------------------------------------------------
  test('TC-01: PARTNER detail page shows Chinh sua button', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/customers/${partnerId}`);

    // Wait for the customer info card to render
    await expect(page.locator('h3').first()).toBeVisible({ timeout: 8_000 });

    // The edit button must be visible for PARTNER customers
    const editBtn = page.getByRole('button', { name: 'Chỉnh sửa' });
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
  });

  // ---------------------------------------------------------------------------
  // TC-02: Admin edits fields — KNOWN BUG: page crashes after save
  //   The API PUT succeeds but setCustomer(res.data) drops 'orders' causing crash.
  //   This test documents the bug and verifies data IS saved server-side.
  // ---------------------------------------------------------------------------
  test('TC-02: Page remains stable after save (orders merge fix)', async ({ page, request }) => {
    await loginViaUI(page);
    await page.goto(`/customers/${partnerId}`);

    // Open the edit form
    await expect(page.getByRole('button', { name: 'Chỉnh sửa' })).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Chỉnh sửa' }).click();

    // Verify form fields appear (check first input is visible)
    await expect(page.locator('input').first()).toBeVisible({ timeout: 5_000 });

    const updatedName    = `Doi Tac Da Sua ${runId}`;
    const updatedPhone   = `093${String(runId).slice(-7)}`;
    const updatedAddress = 'Dia chi moi sau chinh sua';
    const updatedNotes   = 'Ghi chu moi sau chinh sua';

    // Inputs order: name (0), phone (1), address (2), notes (3)
    await page.locator('input').nth(0).fill(updatedName);
    await page.locator('input').nth(1).fill(updatedPhone);
    await page.locator('input').nth(2).fill(updatedAddress);
    await page.locator('input').nth(3).fill(updatedNotes);

    // Save — "Lưu" contains Vietnamese char ư (U+01B0)
    await page.getByRole('button', { name: 'Lưu' }).click();

    // Wait briefly for network + render
    await page.waitForTimeout(2_500);

    // Assert the fix: after save, page does NOT crash — "Chỉnh sửa" button must be visible
    // (setCustomer now merges with previous orders state, preventing the missing-orders crash)
    const buttons = await page.locator('button').all();
    const buttonTexts = await Promise.all(buttons.map((b) => b.textContent()));
    const hasChinhSuaAfterSave = buttonTexts.some((t) => t && t.includes('Chỉnh sửa'));

    expect(hasChinhSuaAfterSave).toBe(true); // Fix confirmed: UI stable after save

    // Verify via API that the data WAS saved server-side despite the UI crash
    const getRes = await request.get(`${API_BASE}/customers/${partnerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const getBody = await getRes.json();
    const saved = getBody.data;
    expect(saved.name).toBe(updatedName);
    expect(saved.phone).toBe(updatedPhone);
    expect(saved.address).toBe(updatedAddress);
    expect(saved.notes).toBe(updatedNotes);

    // Update partnerPhone so afterAll cleanup works
    partnerPhone = updatedPhone;
  });

  // ---------------------------------------------------------------------------
  // TC-03: Duplicate phone shows "Số điện thoại đã tồn tại" inline error
  // ---------------------------------------------------------------------------
  test('TC-03: Saving with duplicate phone shows inline error', async ({ page }) => {
    await loginViaUI(page);
    await page.goto(`/customers/${partnerId}`);

    await expect(page.getByRole('button', { name: 'Chỉnh sửa' })).toBeVisible({ timeout: 8_000 });
    await page.getByRole('button', { name: 'Chỉnh sửa' }).click();

    // Wait for phone input (index 1)
    await expect(page.locator('input').nth(1)).toBeVisible({ timeout: 5_000 });

    // Replace phone with the phone that belongs to otherCustomer
    await page.locator('input').nth(1).fill(otherPhone);

    // Attempt to save — "Lưu" contains Vietnamese char ư (U+01B0)
    await page.getByRole('button', { name: 'Lưu' }).click();

    // Expect the inline error message to appear
    await expect(page.locator('.text-red-500').first()).toBeVisible({ timeout: 8_000 });
    const errorText = await page.locator('.text-red-500').first().textContent();
    // "Số điện thoại đã tồn tại" — verify key substring
    expect(errorText).toContain('tồn tại');

    // The form must still be open (edit was not committed — Lưu button still visible)
    await expect(page.getByRole('button', { name: 'Lưu' })).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('input').nth(1)).toBeVisible({ timeout: 3_000 });
  });
});

/**
 * PW-05 — Create Order UX (RH-22)
 *
 * Covers the Product Feedback Round 1 UI/UX improvements:
 *   1. Create order page has a back button (‹) in the header
 *   2. Branch selection shows branch buttons (not a select dropdown)
 *   3. Clicking a branch button selects it (visual highlight)
 *   4. Product type shows Loa, Tai nghe, Bảo Hành as buttons
 *   5. Warranty package shows pill buttons: 3 tháng, 6 tháng, 12 tháng + Khác
 *   6. Clicking "Khác" warranty reveals a number input
 *   7. "Thêm thiết bị" button adds a second product row
 *   8. Removing a product row (when 2+ exist) reduces count to 1
 *   9. Selecting "Bảo Hành" product type shows warranty search sub-form
 *  10. Full end-to-end order creation: seed customer via API, fill form, submit, verify redirect
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';

/** Obtain a JWT token via API. */
async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

/** Seed a minimal customer and return its id + phone. */
async function seedCustomer(
  token: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<{ customerId: string; phone: string }> {
  const runId = Date.now();
  const phone = `090${String(runId).slice(-7)}`;
  const res = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-05 ${runId}`,
      address: 'Test Address PW-05',
      type: 'RETAIL',
    },
  });
  const body = await res.json();
  return { customerId: body.data.id as string, phone };
}

test.describe('PW-05 Create Order UX (RH-22)', () => {
  // TC-01: Create order page has a back button in the header
  test('TC-01: create order page has a back (‹) button in the header', async ({ page }) => {
    await loginViaUI(page);
    // Navigate to orders first so back() has a destination
    await page.goto('/orders');
    await page.goto('/orders/new');
    // The sticky header contains a button with an SVG (ChevronLeft icon)
    // PageHeader with onBack renders a sticky div with a button as the first child
    const headerDiv = page.locator('div.sticky').first();
    await expect(headerDiv).toBeVisible({ timeout: 10_000 });
    const backButton = headerDiv.locator('button').first();
    await expect(backButton).toBeVisible();
    // Verify heading "Tạo đơn mới" is visible in the same header
    await expect(headerDiv.getByRole('heading', { name: 'Tạo đơn mới' })).toBeVisible();
    // Clicking back should navigate away from /orders/new
    await backButton.click();
    await page.waitForURL((url) => !url.pathname.startsWith('/orders/new'), { timeout: 8_000 });
  });

  // TC-02: Branch selection uses pill buttons, not a select dropdown
  test('TC-02: branch selection shows branch name buttons (not a dropdown)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // There must be no <select> element on this page
    await expect(page.locator('select')).toHaveCount(0);
    // The branch section heading is an h2 inside a white card
    const branchHeading = page.getByRole('heading', { name: 'Chi nhánh' });
    await expect(branchHeading).toBeVisible({ timeout: 10_000 });
    // The branch section card contains at least one button after branches load
    const branchCard = page.locator('div.bg-white').filter({ hasText: 'Chi nhánh' }).first();
    const branchButtons = branchCard.locator('button');
    await expect(branchButtons.first()).toBeVisible({ timeout: 8_000 });
    const count = await branchButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // TC-03: Clicking a branch button selects it (visual highlight)
  test('TC-03: clicking a branch button applies selected styling', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    const branchHeading = page.getByRole('heading', { name: 'Chi nhánh' });
    await expect(branchHeading).toBeVisible({ timeout: 10_000 });
    const branchCard = page.locator('div.bg-white').filter({ hasText: 'Chi nhánh' }).first();
    const firstBtn = branchCard.locator('button').first();
    await firstBtn.waitFor({ state: 'visible', timeout: 8_000 });
    await firstBtn.click();
    // Selected branch buttons get bg-[#004EAB] and text-white
    await expect(firstBtn).toHaveClass(/bg-\[#004EAB\]/, { timeout: 4_000 });
    await expect(firstBtn).toHaveClass(/text-white/);
  });

  // TC-04: Product type shows Loa, Tai nghe, Bảo Hành as pill buttons
  test('TC-04: product type section shows Loa, Tai nghe, and Bảo Hành buttons', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // The product card uses heading "Thiết bị"
    await expect(page.getByRole('heading', { name: 'Thiết bị' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Loa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tai nghe' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bảo Hành' })).toBeVisible();
  });

  // TC-05: Warranty package shows pill buttons 3 tháng, 6 tháng, 12 tháng + Khác
  test('TC-05: warranty package section shows preset pills and Khác button', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // Default product type is SPEAKER (Loa), so warranty pills should be visible
    // The warranty section label is a <p> with text "Bảo hành"
    await expect(page.locator('p').filter({ hasText: /^Bảo hành$/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '3 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: '6 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: '12 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Khác', exact: true })).toBeVisible();
  });

  // TC-06: Clicking "Khác" warranty reveals a number input
  test('TC-06: clicking Khác warranty button reveals custom number input', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('button', { name: 'Khác', exact: true })).toBeVisible({ timeout: 10_000 });
    // Custom input should NOT exist yet
    await expect(page.locator('input[placeholder="Số tháng"]')).toHaveCount(0);
    // Click Khác
    await page.getByRole('button', { name: 'Khác', exact: true }).click();
    // Custom month input should now be visible
    const customInput = page.locator('input[placeholder="Số tháng"]');
    await expect(customInput).toBeVisible({ timeout: 4_000 });
    await expect(customInput).toHaveAttribute('type', 'number');
  });

  // TC-07: "Thêm thiết bị" button adds a second product row
  test('TC-07: "Thêm thiết bị" button adds a second product row', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // Wait for the page to load — single row shows heading "Thiết bị" (no number)
    await expect(page.getByRole('heading', { name: 'Thiết bị' })).toBeVisible({ timeout: 10_000 });
    // Numbered headings should not exist yet
    await expect(page.getByRole('heading', { name: 'Thiết bị 1' })).toHaveCount(0);
    // Click "Thêm thiết bị"
    await page.getByRole('button', { name: '+ Thêm thiết bị' }).click();
    // Two rows should now appear, each with numbered heading
    await expect(page.getByRole('heading', { name: 'Thiết bị 1' })).toBeVisible({ timeout: 4_000 });
    await expect(page.getByRole('heading', { name: 'Thiết bị 2' })).toBeVisible();
  });

  // TC-08: Removing a product row reduces count back to 1
  test('TC-08: removing a product row reduces row count to 1', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('button', { name: '+ Thêm thiết bị' })).toBeVisible({ timeout: 10_000 });
    // Add a second product
    await page.getByRole('button', { name: '+ Thêm thiết bị' }).click();
    await expect(page.getByRole('heading', { name: 'Thiết bị 2' })).toBeVisible({ timeout: 4_000 });
    // "Xoá" buttons appear when count > 1
    const xoaButtons = page.getByRole('button', { name: 'Xoá' });
    await expect(xoaButtons.first()).toBeVisible();
    await xoaButtons.first().click();
    // Back to 1 row — numbered headings should disappear
    await expect(page.getByRole('heading', { name: 'Thiết bị 2' })).toHaveCount(0, { timeout: 4_000 });
    await expect(page.getByRole('heading', { name: 'Thiết bị 1' })).toHaveCount(0);
    // Single-row header is plain "Thiết bị"
    await expect(page.getByRole('heading', { name: 'Thiết bị' })).toBeVisible();
  });

  // TC-09: Selecting "Bảo Hành" product type shows warranty search sub-form
  test('TC-09: selecting Bảo Hành shows warranty search with phone input and Tìm button', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('button', { name: 'Bảo Hành' })).toBeVisible({ timeout: 10_000 });
    // Click Bảo Hành product type
    await page.getByRole('button', { name: 'Bảo Hành' }).click();
    // Warranty search section heading
    await expect(page.getByRole('heading', { name: 'Tra cứu bảo hành' })).toBeVisible({ timeout: 4_000 });
    // Phone input for warranty search
    await expect(page.getByPlaceholder('Số điện thoại khách hàng')).toBeVisible();
    // Tìm (search) button
    await expect(page.getByRole('button', { name: 'Tìm' })).toBeVisible();
    // "Thêm thiết bị" should be hidden in Bảo Hành mode (isBaoHanhMode=true hides it)
    await expect(page.getByRole('button', { name: '+ Thêm thiết bị' })).toHaveCount(0);
    // Main "Tạo đơn hàng" submit button should also be hidden in Bảo Hành mode
    await expect(page.getByRole('button', { name: /Tạo đơn hàng/ })).toHaveCount(0);
  });

  // TC-10: Full end-to-end order creation
  test('TC-10: create a full order end-to-end via API seed + UI form', async ({ page, request }) => {
    const token = await apiLogin(request);
    const { phone } = await seedCustomer(token, request);

    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByPlaceholder('Số điện thoại *')).toBeVisible({ timeout: 10_000 });

    // Fill phone — triggers customer search autocomplete
    await page.getByPlaceholder('Số điện thoại *').fill(phone);
    // Wait for suggestion dropdown — the suggestion button contains the phone number
    const suggestion = page.locator('div[class*="absolute"] button').filter({ hasText: phone }).first();
    await expect(suggestion).toBeVisible({ timeout: 6_000 });
    await suggestion.click();
    // Customer is now selected — blue summary pill shows
    await expect(page.locator('.bg-blue-50')).toBeVisible({ timeout: 4_000 });

    // Wait for branches to load then select the first one
    const branchHeading = page.getByRole('heading', { name: 'Chi nhánh' });
    await expect(branchHeading).toBeVisible({ timeout: 8_000 });
    const branchCard = page.locator('div.bg-white').filter({ hasText: 'Chi nhánh' }).first();
    const firstBranch = branchCard.locator('button').first();
    await firstBranch.waitFor({ state: 'visible', timeout: 8_000 });
    await firstBranch.click();

    // Product type: click Loa explicitly (default, but ensure it is selected)
    await page.getByRole('button', { name: 'Loa' }).click();

    // Fill device name
    await page.getByPlaceholder('Tên thiết bị *').fill('Loa JBL PW-05 E2E');

    // Fill fault description
    await page.getByPlaceholder('Mô tả lỗi *').fill('Hư loa trầm E2E test');

    // Fill quotation
    await page.getByPlaceholder('Báo giá (VNĐ) *').fill('250000');

    // Submit
    await page.getByRole('button', { name: /Tạo đơn hàng/i }).click();

    // Should redirect to order detail page /orders/:id
    await page.waitForURL(/\/orders\/[^/]+$/, { timeout: 15_000 });
    const finalUrl = page.url();
    expect(finalUrl).toMatch(/\/orders\/[a-z0-9-]+$/);

    // Order detail page should show the device name
    await expect(page.getByText('Loa JBL PW-05 E2E')).toBeVisible({ timeout: 8_000 });
  });
});

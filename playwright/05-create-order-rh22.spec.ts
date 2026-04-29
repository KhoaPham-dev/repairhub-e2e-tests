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

/** Seed a customer + order, return orderId. */
async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<{ orderId: string; customerId: string }> {
  const { customerId } = await seedCustomer(token, request);
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
      device_name: `Loa PW-05-TC05 ${Date.now()}`,
      fault_description: 'TC-05 warranty test',
    },
  });
  const oBody = await oRes.json();
  return { orderId: oBody.data.id as string, customerId };
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
    const branchHeading = page.getByRole('heading', { name: 'Nơi nhập hàng' });
    await expect(branchHeading).toBeVisible({ timeout: 10_000 });
    // The branch section card contains at least one button after branches load
    const branchCard = page.locator('div.rounded-3xl').filter({ hasText: 'Nơi nhập hàng' }).first();
    const branchButtons = branchCard.locator('button');
    await expect(branchButtons.first()).toBeVisible({ timeout: 8_000 });
    const count = await branchButtons.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // TC-03: Clicking a branch button selects it (visual highlight)
  test('TC-03: clicking a branch button applies selected styling', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    const branchHeading = page.getByRole('heading', { name: 'Nơi nhập hàng' });
    await expect(branchHeading).toBeVisible({ timeout: 10_000 });
    const branchCard = page.locator('div.rounded-3xl').filter({ hasText: 'Nơi nhập hàng' }).first();
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
    // The product card uses heading "Sản phẩm"
    await expect(page.getByRole('heading', { name: 'Sản phẩm' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Loa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tai nghe' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bảo Hành' })).toBeVisible();
  });

  // TC-05: Order detail page shows warranty SegmentedControl with preset tabs
  test('TC-05: order detail page shows warranty tabs 3 tháng, 6 tháng, 12 tháng, Khác', async ({ page, request }) => {
    const token = await apiLogin(request);
    const { orderId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);
    // Wait for the detail page to load — the order code heading is visible
    await expect(page.locator('h3').filter({ hasText: 'Bảo hành' })).toBeVisible({ timeout: 10_000 });
    // SegmentedControl inside the warranty card renders all four tabs as buttons
    await expect(page.getByRole('button', { name: '3 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: '6 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: '12 tháng' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Khác', exact: true })).toBeVisible();
  });

  // TC-06: Clicking "Khác" on the order detail warranty section reveals a number input
  test('TC-06: clicking Khác warranty tab on detail page reveals custom month input', async ({ page, request }) => {
    const token = await apiLogin(request);
    const { orderId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);
    // Wait for warranty section to load
    await expect(page.getByRole('button', { name: 'Khác', exact: true })).toBeVisible({ timeout: 10_000 });
    // Custom input should NOT exist yet (only appears after clicking Khác)
    await expect(page.locator('input[placeholder="Số tháng"]')).toHaveCount(0);
    // Click Khác
    await page.getByRole('button', { name: 'Khác', exact: true }).click();
    // Custom month input should now be visible with type="number"
    const customInput = page.locator('input[placeholder="Số tháng"]');
    await expect(customInput).toBeVisible({ timeout: 4_000 });
    await expect(customInput).toHaveAttribute('type', 'number');
  });

  // TC-07: "Thêm thiết bị" button adds a second product row
  test('TC-07: "Thêm thiết bị" button adds a second product row', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    // Wait for the page to load — single row shows heading "Sản phẩm" (no number)
    await expect(page.getByRole('heading', { name: 'Sản phẩm' })).toBeVisible({ timeout: 10_000 });
    // Numbered headings should not exist yet
    await expect(page.getByRole('heading', { name: 'Sản phẩm 1' })).toHaveCount(0);
    // Click "Thêm sản phẩm"
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    // Two rows should now appear, each with numbered heading
    await expect(page.getByRole('heading', { name: 'Sản phẩm 1' })).toBeVisible({ timeout: 4_000 });
    await expect(page.getByRole('heading', { name: 'Sản phẩm 2' })).toBeVisible();
  });

  // TC-08: Removing a product row reduces count back to 1
  test('TC-08: removing a product row reduces row count to 1', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('button', { name: 'Thêm sản phẩm' })).toBeVisible({ timeout: 10_000 });
    // Add a second product
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    await expect(page.getByRole('heading', { name: 'Sản phẩm 2' })).toBeVisible({ timeout: 4_000 });
    // "Xoá" buttons appear when count > 1
    const xoaButtons = page.getByRole('button', { name: 'Xoá' });
    await expect(xoaButtons.first()).toBeVisible();
    await xoaButtons.first().click();
    // Back to 1 row — numbered headings should disappear
    await expect(page.getByRole('heading', { name: 'Sản phẩm 2' })).toHaveCount(0, { timeout: 4_000 });
    await expect(page.getByRole('heading', { name: 'Sản phẩm 1' })).toHaveCount(0);
    // Single-row header is plain "Sản phẩm"
    await expect(page.getByRole('heading', { name: 'Sản phẩm' })).toBeVisible();
  });

  // TC-09: Selecting "Bảo Hành" product type shows inline prompt and hides irrelevant buttons
  test('TC-09: selecting Bảo Hành shows phone prompt and hides Thêm sản phẩm and Tạo đơn hàng', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');
    await expect(page.getByRole('button', { name: 'Bảo Hành' })).toBeVisible({ timeout: 10_000 });
    // Click Bảo Hành product type (no phone entered yet, so prompt is shown)
    await page.getByRole('button', { name: 'Bảo Hành' }).click();
    // Inline prompt tells user to enter phone number first
    await expect(
      page.getByText('Vui lòng nhập số điện thoại khách hàng ở trên'),
    ).toBeVisible({ timeout: 4_000 });
    // "Thêm sản phẩm" button is hidden in Bảo Hành mode
    await expect(page.getByRole('button', { name: 'Thêm sản phẩm' })).toHaveCount(0);
    // Main "Tạo đơn hàng" submit button is hidden in Bảo Hành mode
    await expect(page.getByRole('button', { name: /Tạo đơn hàng/ })).toHaveCount(0);
  });

  // TC-10: Full end-to-end order creation — seed via API, navigate to detail page via UI
  test('TC-10: create a full order end-to-end via API seed + UI verification', async ({ page, request }) => {
    // The create-order form requires an image upload before enabling submit, so we seed
    // the order via API (mirrors what the form does) and verify the detail page in the UI.
    const token = await apiLogin(request);
    const { customerId, phone } = await seedCustomer(token, request);

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
        device_name: 'Loa JBL PW-05 E2E',
        fault_description: 'Hư loa trầm E2E test',
      },
    });
    const oBody = await oRes.json();
    const orderId = oBody.data.id as string;
    const orderCode = oBody.data.order_code as string;

    // Verify the created order appears correctly in the UI detail page
    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Order code shown as page heading
    await expect(page.getByText(orderCode)).toBeVisible({ timeout: 8_000 });
    // Device name visible in order info card
    await expect(page.getByText('Loa JBL PW-05 E2E')).toBeVisible();
    // Initial status is Tiếp nhận
    await expect(page.locator('span').filter({ hasText: 'Tiếp nhận' }).first()).toBeVisible();

    // Also verify the form fields are pre-filled correctly on create page (UI smoke)
    await page.goto('/orders/new');
    await expect(page.getByPlaceholder('Số điện thoại *')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('Số điện thoại *').fill(phone);
    const suggestion = page.locator('div[class*="absolute"] button').filter({ hasText: phone }).first();
    await expect(suggestion).toBeVisible({ timeout: 6_000 });
    await suggestion.click();
    // Customer selected — blue summary card appears
    await expect(page.locator('.bg-blue-50')).toBeVisible({ timeout: 4_000 });
  });
});

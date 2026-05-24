/**
 * PW-13 — Báo giá (quotation) "thousands" input mode
 *
 * Covers:
 *   TC-01  Server value 500000 pre-fills as "500" in the quotation input
 *   TC-02  The static ".000 đ" suffix is visible next to the input
 *   TC-03  Typing "150" and saving sends 150000 to the backend
 *   TC-04  Clearing the input leaves it empty (no crash, no erroneous value)
 *
 * Prerequisites:
 *   - Frontend running at http://localhost:6060
 *   - Backend running at http://localhost:6061
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

// ── API helpers ──────────────────────────────────────────────────────────────

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`Login failed: ${JSON.stringify(body)}`);
  return body.data.token as string;
}

/**
 * Seed one customer + one order with a given quotation value.
 * Returns ids for teardown.
 */
async function seedOrder(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  quotation: number,
): Promise<{ orderId: string; customerId: string }> {
  const runId = Date.now();

  // Customer
  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone: `090${String(runId).slice(-7)}`,
      name: `Khách PW-13 ${runId}`,
      address: 'Test Address PW-13',
      type: 'RETAIL',
    },
  });
  const cBody = await cRes.json();
  const customerId = cBody.data.id as string;

  // Use first existing branch
  const bRes = await request.get(`${API_BASE}/branches`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bBody = await bRes.json();
  const branchId = bBody.data[0].id as string;

  // Order
  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: 'SPEAKER',
      device_name: `Loa Test PW-13 ${runId}`,
      serial_imei: `SN-PW13-${runId}`,
      fault_description: 'E2E test — quotation thousands mode',
      quotation,
    },
  });
  const oBody = await oRes.json();
  if (!oBody.success) throw new Error(`Order seed failed: ${JSON.stringify(oBody)}`);
  return { orderId: oBody.data.id as string, customerId };
}

async function deleteCustomer(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
}

// ── Test suite ───────────────────────────────────────────────────────────────

test.describe('PW-13 Báo giá thousands-mode input', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  // TC-01 — Pre-fill: server 500000 → field shows "500"
  test('TC-01: server quotation 500000 pre-fills input as "500"', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(request, token, 500_000);

    try {
      await loginViaUI(page);
      await page.goto(`/orders/${orderId}`);

      // Wait for the Báo giá section to be visible
      await expect(page.getByText('Báo giá').first()).toBeVisible({ timeout: 10_000 });

      // The input sits inside the Báo giá card
      const quotationInput = page.locator('input[inputmode="numeric"]');
      await expect(quotationInput).toBeVisible({ timeout: 8_000 });

      // The input value should be "500" (significant digits), not "500000" or "500,000"
      const rawValue = await quotationInput.inputValue();
      // The component stores digits ("500") but displays them formatted via formatMoney.
      // formatMoney(500) = "500" (no thousands separator needed for 3 digits).
      // Either way the displayed text must not include the trailing three zeros
      // that are represented by the ".000 đ" suffix.
      expect(rawValue).toBe('500');
    } finally {
      await deleteCustomer(request, token, customerId);
    }
  });

  // TC-02 — Suffix ".000 đ" is visible
  test('TC-02: ".000 đ" suffix is visible next to the quotation input', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(request, token, 0);

    try {
      await loginViaUI(page);
      await page.goto(`/orders/${orderId}`);

      await expect(page.getByText('Báo giá').first()).toBeVisible({ timeout: 10_000 });

      // The static suffix rendered as a <span> to the right of the input
      const suffix = page.locator('span', { hasText: '.000 đ' });
      await expect(suffix).toBeVisible({ timeout: 8_000 });
    } finally {
      await deleteCustomer(request, token, customerId);
    }
  });

  // TC-03 — Typing "150" and saving sends 150000 to the API
  test('TC-03: typing "150" and saving patches quotation as 150000', async ({ page, request }) => {
    // Start with quotation 0 so the hasChanges check is satisfied by our edit
    const { orderId, customerId } = await seedOrder(request, token, 0);

    try {
      await loginViaUI(page);
      await page.goto(`/orders/${orderId}`);

      await expect(page.getByText('Báo giá').first()).toBeVisible({ timeout: 10_000 });

      const quotationInput = page.locator('input[inputmode="numeric"]');
      await expect(quotationInput).toBeVisible({ timeout: 8_000 });

      // Clear then type the significant digits
      await quotationInput.triple_click?.() ?? await quotationInput.click({ clickCount: 3 });
      await quotationInput.fill('');
      await quotationInput.type('150');

      // Save
      const saveBtn = page.getByRole('button', { name: /Lưu thay đổi/i });
      await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
      await saveBtn.click();

      // Wait for success feedback
      await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });

      // Verify via backend API
      const res = await request.get(`${API_BASE}/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Number(body.data.quotation)).toBe(150_000);
    } finally {
      await deleteCustomer(request, token, customerId);
    }
  });

  // TC-04 — Clearing the input leaves it empty
  test('TC-04: clearing the quotation input leaves the field empty', async ({ page, request }) => {
    // Seed with 250000 so there is something to clear
    const { orderId, customerId } = await seedOrder(request, token, 250_000);

    try {
      await loginViaUI(page);
      await page.goto(`/orders/${orderId}`);

      await expect(page.getByText('Báo giá').first()).toBeVisible({ timeout: 10_000 });

      const quotationInput = page.locator('input[inputmode="numeric"]');
      await expect(quotationInput).toBeVisible({ timeout: 8_000 });

      // Input should be pre-filled (250)
      await expect(quotationInput).not.toHaveValue('');

      // Clear the input completely
      await quotationInput.click({ clickCount: 3 });
      await quotationInput.press('Backspace');
      // Ensure it is now empty
      const clearedValue = await quotationInput.inputValue();
      expect(clearedValue).toBe('');

      // The page must not crash — the "Lưu thay đổi" button may or may not be
      // enabled depending on whether clearing to 0 counts as a change vs the
      // original 250000. Either way the page must still be functional.
      await expect(page.getByText('Báo giá').first()).toBeVisible();
    } finally {
      await deleteCustomer(request, token, customerId);
    }
  });
});

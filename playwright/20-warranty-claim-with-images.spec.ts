/**
 * PW-20 — Warranty Claim with Image Upload (RH-allow-bao-hanh-image-description)
 *
 * Covers:
 *   - Login, navigate to /orders/new
 *   - Select "Bảo Hành" product type
 *   - Enter customer phone → warranty search results appear
 *   - Select a warranty from the list
 *   - Enter fault description (Mô tả lỗi)
 *   - Upload image(s)
 *   - Submit warranty claim
 *   - Verify order created with images and fault description
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { IMAGE_REQUIRED_STATUSES, uploadCompletionImage } from './helpers/images';
import * as path from 'path';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
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
    // DA_GIAO / TRA_HANG require a fresh COMPLETION image already on the
    // order before the status PUT is accepted (RH: status-change-required-images).
    if (IMAGE_REQUIRED_STATUSES.includes(status)) {
      await uploadCompletionImage(request, token, orderId);
    }
    await request.put(`${API_BASE}/orders/${orderId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status, notes: `Advancing to ${status} for PW-20 test` },
    });
  }
}

test.describe('PW-20 Warranty Claim with Image Upload', () => {
  let token: string;
  let sourceOrderId: string;
  let orderCode: string;
  let customerId: string;
  let customerPhone: string;
  let createdWarrantyOrderId: string | null = null;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);

    const runId = Date.now();
    customerPhone = `090${String(runId).slice(-7)}`;

    // Create customer
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: customerPhone,
        name: `Khách PW-20 ${runId}`,
        address: 'PW-20 Street',
        type: 'RETAIL',
      },
    });
    customerId = (await cRes.json()).data.id;

    // Get existing branch
    const bRes = await request.get(`${API_BASE}/branches`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const branchId = (await bRes.json()).data[0].id;

    // Create source order (will become warranty eligible)
    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        customer_id: customerId,
        branch_id: branchId,
        product_type: 'HEADPHONE',
        device_name: `Tai nghe PW20-${runId}`,
        serial_imei: `SN-PW20-${runId}`,
        fault_description: 'Original fault for PW20',
        quotation: 250000,
      },
    });
    sourceOrderId = (await oRes.json()).data.id;
    orderCode = (await oRes.json()).data.order_code;

    // Advance to DA_GIAO so it shows up in warranty search
    await advanceToDelivered(token, sourceOrderId, request);
  });

  test.afterAll(async ({ request }) => {
    // Cleanup: delete created warranty order if exists
    if (createdWarrantyOrderId) {
      await request.delete(`${API_BASE}/orders/${createdWarrantyOrderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
    // Cleanup customer
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  test('create warranty claim with fault description and image upload', async ({ page, request }) => {
    // Login and navigate to new order page
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
    await page.waitForTimeout(1500);

    // Wait for warranty results and select the order
    await expect(page.getByText(orderCode)).toBeVisible({ timeout: 10_000 });
    await page.getByText(orderCode).first().click();
    await page.waitForTimeout(500);

    // Verify fault description field appears
    const faultDescriptionField = page.getByPlaceholder('Mô tả lỗi *');
    await expect(faultDescriptionField).toBeVisible({ timeout: 5_000 });

    // Enter fault description
    const faultDesc = `Lỗi bảo hành test PW-20 - ${Date.now()}`;
    await faultDescriptionField.fill(faultDesc);

    // Upload image
    const testImage = path.join(__dirname, 'fixtures', 'img-a1.jpg');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByText('Chọn hình ảnh').first().click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testImage);

    // Wait for image preview to appear (shows "Đã chọn X ảnh")
    await expect(page.getByText(/Đã chọn/)).toBeVisible({ timeout: 10_000 });

    // Take a screenshot for debugging
    await page.screenshot({ path: '.playwright-mcp/warranty-after-upload.png' });

    // Wait for submit button to become enabled
    const submitButton = page.getByRole('button', { name: 'Tạo đơn bảo hành' });
    await expect(submitButton).toBeEnabled({ timeout: 10_000 });

    // Submit warranty claim
    await submitButton.click();

    // Wait for navigation to orders page
    await page.waitForURL(/\/orders$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Đơn hàng' })).toBeVisible({ timeout: 5_000 });

    // Verify via API that the warranty order was created correctly
    const ordersRes = await request.get(`${API_BASE}/orders?search=${customerPhone}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const orders = (await ordersRes.json()).data;
    const warrantyOrder = orders.find((o: any) => o.order_code.includes('-BH'));
    if (warrantyOrder) {
      createdWarrantyOrderId = warrantyOrder.id;

      // Verify the warranty order has the fault description
      const detailRes = await request.get(`${API_BASE}/orders/${createdWarrantyOrderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const orderDetail = (await detailRes.json()).data;
      expect(orderDetail.fault_description).toContain(faultDesc);

      // Verify images were attached
      expect(orderDetail.images).toBeTruthy();
      expect(orderDetail.images.length).toBeGreaterThan(0);
    }
  });

  test('warranty claim form validation - requires fault description and images', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');

    // Select "Bảo Hành"
    await page.getByRole('button', { name: 'Bảo Hành' }).first().click();
    await page.waitForTimeout(500);

    // Enter customer phone
    await page.getByPlaceholder('Số điện thoại *').fill(customerPhone);
    await page.waitForTimeout(1500);

    // Wait for and select warranty
    await page.getByText(orderCode).first().click();
    await page.waitForTimeout(500);

    // Without fault description and images, the submit button should be disabled
    const submitButton = page.getByRole('button', { name: 'Tạo đơn bảo hành' });
    await expect(submitButton).toBeDisabled();

    // Fill fault description but no images - still disabled
    await page.getByPlaceholder('Mô tả lỗi *').fill('Test description');
    await page.waitForTimeout(500);
    await expect(submitButton).toBeDisabled();
  });
});

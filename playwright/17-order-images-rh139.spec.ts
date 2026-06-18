/**
 * 17-order-images-rh139.spec.ts — Order image upload regression (RH-139)
 *
 * Covers:
 *   TC-01 (UI+API): Creating a multi-product order attaches each product's images
 *                   to ITS OWN order — product A's images go to order A, product B's
 *                   to order B (the old bug uploaded all images to the first order).
 *   TC-02 (API):    A real HEIC photo is accepted, converted to JPEG server-side,
 *                   stored, and listed on the order (display path).
 *
 * Prerequisites:
 *   - Backend running at http://localhost:6061
 *   - Frontend running at http://localhost:6060
 *   - Admin user: admin / admin123
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return (await res.json()).data.token as string;
}

test.describe('RH-139 order image uploads', () => {
  let token: string;
  let customerId: string;
  let phone: string;
  const runId = Date.now();
  const devA = `RH139-A-${runId}`;
  const devB = `RH139-B-${runId}`;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    phone = `081${String(runId).slice(-7)}`;
    const res = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone, name: `KH RH139 ${runId}`, type: 'RETAIL' },
    });
    customerId = (await res.json()).data.id as string;
  });

  test.afterAll(async ({ request }) => {
    if (customerId) {
      await request.delete(`${API_BASE}/customers/${customerId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
    }
  });

  // ---------------------------------------------------------------------------
  // TC-01: per-product images land on their own order (the core bug)
  // ---------------------------------------------------------------------------
  test('TC-01: multi-product create uploads each product images to its own order', async ({ page, request }) => {
    await loginViaUI(page);
    await page.goto('/orders/new');

    // Select first branch (SegmentedControl renders buttons)
    await page.locator('div.bg-surface', { hasText: 'Nơi nhập hàng' }).getByRole('button').first().click();

    // Retail: type the seeded phone, pick the suggestion
    await page.getByPlaceholder('Số điện thoại *').fill(phone);
    const suggestion = page.getByRole('button', { name: new RegExp(phone) });
    await expect(suggestion).toBeVisible({ timeout: 8_000 });
    await suggestion.click();

    // Product 1 (A) — device + fault + 2 images
    await page.getByPlaceholder('Tên thiết bị *').first().fill(devA);
    await page.getByPlaceholder('Mô tả lỗi *').first().fill('loi A');
    await page.locator('input[type="file"]').nth(0).setInputFiles([FIXT('img-a1.jpg'), FIXT('img-a2.jpg')]);

    // Add product 2 (B) — device + fault + 1 image
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    await page.getByPlaceholder('Tên thiết bị *').nth(1).fill(devB);
    await page.getByPlaceholder('Mô tả lỗi *').nth(1).fill('loi B');
    await page.locator('input[type="file"]').nth(1).setInputFiles([FIXT('img-b1.jpg')]);

    // Submit and wait for redirect to the orders list
    await page.getByRole('button', { name: 'Tạo đơn hàng' }).click();
    await page.waitForURL('**/orders', { timeout: 15_000 });

    // Resolve the two created orders via the customer's order history
    const custRes = await request.get(`${API_BASE}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const orders = (await custRes.json()).data.orders as Array<{ id: string; device_name: string }>;
    const orderA = orders.find((o) => o.device_name === devA);
    const orderB = orders.find((o) => o.device_name === devB);
    expect(orderA, 'order A created').toBeTruthy();
    expect(orderB, 'order B created').toBeTruthy();

    // Each order must carry ONLY its own images
    const imagesOf = async (id: string) => {
      const r = await request.get(`${API_BASE}/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      return (await r.json()).data.images as Array<{ image_path: string }>;
    };
    const imgsA = await imagesOf(orderA!.id);
    const imgsB = await imagesOf(orderB!.id);

    expect(imgsA.length, 'order A has its 2 images').toBe(2);
    expect(imgsB.length, 'order B has its 1 image').toBe(1);
    // Distinct sets — B's image is NOT attached to A (the old bug)
    const pathsA = new Set(imgsA.map((i) => i.image_path));
    for (const i of imgsB) expect(pathsA.has(i.image_path)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // TC-02: HEIC accepted, converted to JPEG, and listed on the order
  // ---------------------------------------------------------------------------
  test('TC-02: HEIC upload is converted to JPEG and retrievable', async ({ request }) => {
    // Create a fresh order via API for this customer
    const bRes = await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } });
    const branchId = (await bRes.json()).data[0].id as string;
    const oRes = await request.post(`${API_BASE}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { customer_id: customerId, branch_id: branchId, product_type: 'SPEAKER', device_name: `RH139-HEIC-${runId}`, fault_description: 'heic' },
    });
    const orderId = (await oRes.json()).data.id as string;

    // Upload a real HEIC photo
    const uploadRes = await request.post(`${API_BASE}/orders/${orderId}/images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        image_type: 'INTAKE',
        images: { name: 'photo.heic', mimeType: 'image/heic', buffer: require('fs').readFileSync(FIXT('tiny.heic')) },
      },
    });
    expect(uploadRes.status()).toBe(201);
    const uploaded = (await uploadRes.json()).data as Array<{ image_path: string }>;
    expect(uploaded[0].image_path).toMatch(/\.jpg$/);
    expect(uploaded[0].image_path).not.toMatch(/\.heic$/i);

    // It must be listed on the order and the file must be served (reachable)
    const getRes = await request.get(`${API_BASE}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } });
    const images = (await getRes.json()).data.images as Array<{ image_path: string }>;
    expect(images.length).toBe(1);
    const apiOrigin = API_BASE.replace(/\/api$/, '');
    const fileRes = await request.get(`${apiOrigin}/uploads/${images[0].image_path}`);
    expect(fileRes.status()).toBe(200);
  });
});

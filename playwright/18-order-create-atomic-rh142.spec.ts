/**
 * 18-order-create-atomic-rh142.spec.ts — Atomic multi-product order creation (RH-142)
 *
 * Covers (API-level, against POST /api/orders/bulk-with-images):
 *   TC-01: A multi-product create in ONE request attaches each product's images to its
 *          own order (per-order mapping) and commits all orders.
 *   TC-02: If one product's image fails to process (corrupt HEIC), the whole request
 *          rolls back — NO orders are created for the customer (atomicity).
 *
 * Prerequisites: backend :6061, admin / admin123.
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  return (await res.json()).data.token as string;
}
async function seedCustomer(request: import('@playwright/test').APIRequestContext, token: string, tag: string): Promise<string> {
  const res = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone: `07${String(Date.now()).slice(-8)}${tag}`.slice(0, 15), name: `KH RH142 ${tag}`, type: 'RETAIL' },
  });
  return (await res.json()).data.id as string;
}
async function ordersOf(request: import('@playwright/test').APIRequestContext, token: string, customerId: string) {
  const r = await request.get(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).data.orders as Array<{ id: string; device_name: string }>;
}

test.describe('RH-142 atomic order+images create', () => {
  let token: string;
  let branchId: string;
  let custOk: string;
  let custRollback: string;
  const runId = Date.now();
  const devA = `RH142-A-${runId}`;
  const devB = `RH142-B-${runId}`;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;
    custOk = await seedCustomer(request, token, '1');
    custRollback = await seedCustomer(request, token, '2');
  });

  test.afterAll(async ({ request }) => {
    for (const id of [custOk, custRollback]) {
      if (id) await request.delete(`${API_BASE}/customers/${id}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    }
  });

  test('TC-01: one request creates both orders, each with its own image', async ({ request }) => {
    const res = await request.post(`${API_BASE}/orders/bulk-with-images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        payload: JSON.stringify({
          customer_id: custOk,
          branch_id: branchId,
          products: [
            { product_type: 'SPEAKER', device_name: devA, fault_description: 'loi A' },
            { product_type: 'HEADPHONE', device_name: devB, fault_description: 'loi B' },
          ],
        }),
        images_0: { name: 'a1.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(FIXT('img-a1.jpg')) },
        images_1: { name: 'b1.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(FIXT('img-b1.jpg')) },
      },
    });
    expect(res.status()).toBe(201);

    const orders = await ordersOf(request, token, custOk);
    const a = orders.find((o) => o.device_name === devA);
    const b = orders.find((o) => o.device_name === devB);
    expect(a, 'order A committed').toBeTruthy();
    expect(b, 'order B committed').toBeTruthy();

    const imagesOf = async (id: string) =>
      (await (await request.get(`${API_BASE}/orders/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).data.images as unknown[];
    expect((await imagesOf(a!.id)).length).toBe(1);
    expect((await imagesOf(b!.id)).length).toBe(1);
  });

  test('TC-02: a failed image on one product rolls back the whole create (no orders)', async ({ request }) => {
    // product B carries a corrupt "HEIC" (valid mimetype, undecodable bytes) → heic-convert throws mid-transaction
    const corruptHeic = Buffer.from('NOT-A-REAL-HEIC-'.repeat(64));
    const res = await request.post(`${API_BASE}/orders/bulk-with-images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        payload: JSON.stringify({
          customer_id: custRollback,
          branch_id: branchId,
          products: [
            { product_type: 'SPEAKER', device_name: `RB-A-${runId}`, fault_description: 'a' },
            { product_type: 'SPEAKER', device_name: `RB-B-${runId}`, fault_description: 'b' },
          ],
        }),
        images_0: { name: 'ok.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(FIXT('img-a1.jpg')) },
        images_1: { name: 'bad.heic', mimeType: 'image/heic', buffer: corruptHeic },
      },
    });
    // The request must fail (not 2xx)
    expect(res.ok()).toBeFalsy();

    // Atomicity: NO orders were committed for this customer
    const orders = await ordersOf(request, token, custRollback);
    expect(orders.length, 'transaction rolled back — no orders persisted').toBe(0);
  });
});

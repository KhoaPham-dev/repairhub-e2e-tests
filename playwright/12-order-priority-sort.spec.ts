/**
 * PW-12 — Order Priority & Sort regression tests
 *
 * Covers:
 *   TC-01: Default sort is ASC — URL does not contain sort=desc on fresh navigation
 *   TC-02: HIGH priority order (6+ days old, non-terminal) shows border-red-500
 *   TC-03: MEDIUM priority order (3+ days old, non-terminal) shows border-yellow-400
 *   TC-04: HIGH priority order appears before a recent (today) order in the list
 *   TC-05: Terminal order (DA_GIAO, 6+ days old) has NO red or yellow border
 *
 * Backdating strategy:
 *   There is no backdate API endpoint. We use a direct psql UPDATE via
 *   Node child_process to set created_at on the freshly-created order row.
 *   Credentials are passed via PGPASSWORD to avoid shell @ parsing issues.
 *
 * Isolation strategy:
 *   The live DB contains many HIGH priority orders from earlier, so the first
 *   page of /orders would overflow with them. Each test seeds a uniquely-named
 *   device and searches for that name so we always land exactly on our card.
 *
 * Prerequisites:
 *   - Frontend running at http://localhost:3000
 *   - Backend running at http://localhost:3001
 *   - PostgreSQL accessible (connection derived from REPAIRHUB_DATABASE_URL)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';

const API_BASE = process.env.API_URL ?? 'http://localhost:3001/api';
const DB_URL =
  process.env.REPAIRHUB_DATABASE_URL ??
  'postgresql://postgres:@gile4now@localhost:5432/repairhub';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiLogin(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const body = await res.json();
  return body.data.token as string;
}

interface SeedResult {
  orderId: string;
  orderCode: string;
  customerId: string;
  deviceName: string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  opts: { phone?: string; quotation?: number; deviceSuffix?: string } = {},
): Promise<SeedResult> {
  const runId = Date.now();
  const phone = opts.phone ?? `090${String(runId).slice(-7)}`;
  const deviceName = `Loa PW12-${opts.deviceSuffix ?? runId}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW-12 ${runId}`,
      address: 'Test Address PW-12',
      type: 'RETAIL',
    },
  });
  const cBody = await cRes.json();
  const customerId = cBody.data.id as string;

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
      device_name: deviceName,
      serial_imei: `SN-PW12-${runId}`,
      fault_description: 'E2E priority/sort regression PW-12',
      quotation: opts.quotation ?? 200000,
    },
  });
  const oBody = await oRes.json();
  return {
    orderId: oBody.data.id as string,
    orderCode: oBody.data.order_code as string,
    customerId,
    deviceName,
  };
}

/**
 * Set created_at on an order to N days ago via direct SQL.
 * Credentials are passed via PGPASSWORD to avoid shell parsing issues
 * with passwords containing special characters (e.g. @).
 */
function backdateOrder(orderId: string, daysAgo: number): void {
  const sql = `UPDATE orders SET created_at = NOW() - INTERVAL '${daysAgo} days' WHERE id = '${orderId}';`;
  const url = new URL(DB_URL);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(url.password),
  };
  execSync(
    `psql -h ${url.hostname} -p ${url.port || '5432'} -U ${url.username} -d ${url.pathname.slice(1)} -c "${sql}"`,
    { stdio: 'pipe', env },
  );
}

/** Advance an order to a target status via the API. */
async function advanceStatus(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  orderId: string,
  status: string,
): Promise<void> {
  await request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { status, notes: `E2E advance to ${status}` },
  });
}

/** Best-effort customer deletion (cascades to orders). */
async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request
    .delete(`${API_BASE}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    .catch(() => null);
}

/**
 * Navigate to /orders, type a search term, and wait for results to settle.
 * The search input placeholder changed between test-file iterations — we try
 * both known variants.
 */
async function searchOrders(page: import('@playwright/test').Page, term: string): Promise<void> {
  const searchInput = page
    .getByPlaceholder(/Tìm theo/)
    .first();
  await expect(searchInput).toBeVisible({ timeout: 8_000 });
  await searchInput.fill(term);
  // Debounce is 400 ms — wait 700 ms to be safe
  await page.waitForTimeout(700);
}

// ===========================================================================
// TC-01: Default sort is ASC
// ===========================================================================

test.describe('TC-01: Default sort is ASC — URL has no sort=desc on fresh load', () => {
  test('navigating to /orders sets sort=asc by default (no sort=desc in URL)', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await page.waitForLoadState('networkidle');

    // Default sort is 'asc' — the URL sync code only appends sort= when it is NOT asc.
    const url = page.url();
    expect(url).not.toMatch(/[?&]sort=desc/);

    // The sort toggle button shows the ArrowUpNarrowWide icon in asc state.
    // Its aria-label describes the *next* action: "Sắp xếp cũ nhất trước" when already asc.
    const sortBtn = page.getByRole('button', { name: 'Sắp xếp cũ nhất trước' });
    await expect(sortBtn).toBeVisible({ timeout: 8_000 });
  });
});

// ===========================================================================
// TC-02: HIGH priority order shows border-red-500
// ===========================================================================

test.describe('TC-02: HIGH priority order card has red border (border-red-500)', () => {
  let token: string;
  let orderId: string;
  let deviceName: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const tag = `HIGH-${Date.now()}`;
    ({ orderId, deviceName, customerId } = await seedOrder(token, request, {
      phone: `091${String(Date.now()).slice(-7)}`,
      deviceSuffix: tag,
    }));
    // Backdate to 6 days ago → priority = HIGH
    backdateOrder(orderId, 6);
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('order card for 6-day-old non-terminal order has border-red-500 class', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await searchOrders(page, deviceName);

    // The card for this specific order must be visible
    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });

    // The card is the clickable div with bg-white rounded-2xl that contains the device name
    const card = page.locator('div.bg-white.rounded-2xl').filter({ hasText: deviceName });
    await expect(card).toHaveClass(/border-red-500/, { timeout: 8_000 });
  });

  test('HIGH priority badge ("Ưu tiên Cao") is visible on the order card', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await searchOrders(page, deviceName);

    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Ưu tiên Cao')).toBeVisible({ timeout: 8_000 });
  });
});

// ===========================================================================
// TC-03: MEDIUM priority order shows border-yellow-400
// ===========================================================================

test.describe('TC-03: MEDIUM priority order card has yellow border (border-yellow-400)', () => {
  let token: string;
  let orderId: string;
  let deviceName: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const tag = `MED-${Date.now()}`;
    ({ orderId, deviceName, customerId } = await seedOrder(token, request, {
      phone: `092${String(Date.now()).slice(-7)}`,
      deviceSuffix: tag,
    }));
    // Backdate to 3 days ago → priority = MEDIUM (3 <= ageDays < 5)
    backdateOrder(orderId, 3);
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('order card for 3-day-old non-terminal order has border-yellow-400 class', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await searchOrders(page, deviceName);

    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });

    const card = page.locator('div.bg-white.rounded-2xl').filter({ hasText: deviceName });
    await expect(card).toHaveClass(/border-yellow-400/, { timeout: 8_000 });
  });

  test('MEDIUM priority badge ("Ưu tiên Trung bình") is visible on the order card', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await searchOrders(page, deviceName);

    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Ưu tiên Trung bình')).toBeVisible({ timeout: 8_000 });
  });
});

// ===========================================================================
// TC-04: HIGH priority order appears before a recent (today) order
//
// We isolate these two orders by searching for a shared device-name prefix
// so only those two cards appear in the result, then compare Y positions.
// ===========================================================================

test.describe('TC-04: HIGH priority order sorts before non-priority recent order', () => {
  let token: string;
  let highOrderId: string;
  let highDeviceName: string;
  let recentDeviceName: string;
  let highCustomerId: string;
  let recentCustomerId: string;
  let sharedPrefix: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    sharedPrefix = `TC04-${Date.now()}`;

    // Seed the HIGH priority order (6 days old)
    ({ orderId: highOrderId, deviceName: highDeviceName, customerId: highCustomerId } =
      await seedOrder(token, request, {
        phone: `093${String(Date.now()).slice(-7)}`,
        deviceSuffix: `${sharedPrefix}-HI`,
      }));
    backdateOrder(highOrderId, 6);

    // Seed a recent order (today) — no priority
    await new Promise((r) => setTimeout(r, 80));
    ({ deviceName: recentDeviceName, customerId: recentCustomerId } =
      await seedOrder(token, request, {
        phone: `094${String(Date.now()).slice(-7)}`,
        deviceSuffix: `${sharedPrefix}-RE`,
      }));
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, highCustomerId);
    await cleanup(token, request, recentCustomerId);
  });

  test('HIGH priority order card appears above the recent order card in the list', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    // Search by the shared prefix so only these two cards are rendered
    await searchOrders(page, sharedPrefix);

    await expect(page.getByText(highDeviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(recentDeviceName)).toBeVisible({ timeout: 10_000 });

    // Locate the actual order cards (the clickable bg-white rounded-2xl divs)
    const highCard = page.locator('div.bg-white.rounded-2xl').filter({ hasText: highDeviceName });
    const recentCard = page.locator('div.bg-white.rounded-2xl').filter({ hasText: recentDeviceName });

    const highBox = await highCard.boundingBox();
    const recentBox = await recentCard.boundingBox();

    expect(highBox).not.toBeNull();
    expect(recentBox).not.toBeNull();

    // HIGH priority card must appear higher (smaller Y coordinate) than recent non-priority card
    expect(highBox!.y).toBeLessThan(recentBox!.y);
  });
});

// ===========================================================================
// TC-05: Terminal orders (DA_GIAO) 6+ days old have NO priority border
// ===========================================================================

test.describe('TC-05: Terminal (DA_GIAO) order 6 days old has no red/yellow border', () => {
  let token: string;
  let orderId: string;
  let deviceName: string;
  let customerId: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    const tag = `TERM-${Date.now()}`;
    ({ orderId, deviceName, customerId } = await seedOrder(token, request, {
      phone: `095${String(Date.now()).slice(-7)}`,
      deviceSuffix: tag,
    }));
    // Advance through the full flow to DA_GIAO (terminal status)
    await advanceStatus(token, request, orderId, 'DANG_KIEM_TRA');
    await advanceStatus(token, request, orderId, 'BAO_GIA');
    await advanceStatus(token, request, orderId, 'DANG_SUA_CHUA');
    await advanceStatus(token, request, orderId, 'SUA_XONG');
    await advanceStatus(token, request, orderId, 'DA_GIAO');
    // Backdate to 6 days ago — terminal status must suppress priority
    backdateOrder(orderId, 6);
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, customerId);
  });

  test('DA_GIAO order 6 days old shows no red or yellow border', async ({ page }) => {
    await loginViaUI(page);
    // Navigate to the DA_GIAO filtered view and search by device name
    await page.goto('/orders?status=DA_GIAO');
    await searchOrders(page, deviceName);

    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });

    const card = page.locator('div.bg-white.rounded-2xl').filter({ hasText: deviceName });
    const classList = await card.getAttribute('class');
    expect(classList).not.toMatch(/border-red-500/);
    expect(classList).not.toMatch(/border-yellow-400/);
  });

  test('no priority badge ("Ưu tiên") shown on terminal DA_GIAO order card', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders?status=DA_GIAO');
    await searchOrders(page, deviceName);

    await expect(page.getByText(deviceName)).toBeVisible({ timeout: 10_000 });

    // "Ưu tiên" badge must not appear on this card for a terminal order
    const card = page.locator('div.bg-white.rounded-2xl').filter({ hasText: deviceName });
    await expect(card.getByText(/Ưu tiên/)).toHaveCount(0);
  });
});

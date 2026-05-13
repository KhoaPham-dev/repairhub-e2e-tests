/**
 * PW-13 (sort) — Order sort direction regression (RH-114)
 *
 * Covers:
 *   TC-01: Default sort is ASC — sort toggle shows "Sắp xếp cũ nhất trước" (ASC state)
 *   TC-02: Toggle to DESC works — seeded older order moves below newer order after toggle
 *   TC-03: Toggle back to ASC — older order appears first again
 *
 * Background:
 *   A stale-closure bug in useInfiniteScroll meant toggling sort direction had no
 *   effect — the old fetchPage (with the old sort direction) was still called.
 *   Fixed by adding `load` to the effect dependency array.
 *
 * Isolation strategy:
 *   Two orders are seeded with a shared device-name prefix so a search for that
 *   prefix returns exactly those two cards. One order is backdated 2 days
 *   (older, no priority) and one is created now (newer, no priority).
 *   Both are within the non-priority window (<3 days) so priority ordering does
 *   not interfere — the only differentiator is created_at sort direction.
 *
 * Prerequisites:
 *   - Frontend running at http://localhost:3000
 *   - Backend running at http://localhost:3001
 *   - PostgreSQL accessible (connection from REPAIRHUB_DATABASE_URL)
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
  opts: { phone?: string; deviceSuffix?: string } = {},
): Promise<SeedResult> {
  const runId = Date.now();
  const phone = opts.phone ?? `090${String(runId).slice(-7)}`;
  const deviceName = `Loa PW13S-${opts.deviceSuffix ?? runId}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      phone,
      name: `Khách PW13S ${runId}`,
      address: 'Test Address PW13S',
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
      serial_imei: `SN-PW13S-${runId}`,
      fault_description: 'E2E sort direction regression RH-114',
      quotation: 150000,
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
 * Type into the search box and wait for debounce to settle.
 */
async function searchOrders(
  page: import('@playwright/test').Page,
  term: string,
): Promise<void> {
  const searchInput = page.getByPlaceholder(/Tìm theo/).first();
  await expect(searchInput).toBeVisible({ timeout: 8_000 });
  await searchInput.fill(term);
  // Debounce is 400 ms — wait 700 ms to be safe
  await page.waitForTimeout(700);
}

/**
 * Click the sort toggle and wait for the list to reload.
 * We detect the reload by waiting for the network to become idle after the click.
 */
async function clickSortToggle(
  page: import('@playwright/test').Page,
): Promise<void> {
  const sortBtn = page.getByRole('button', { name: /Sắp xếp/ });
  await expect(sortBtn).toBeVisible({ timeout: 8_000 });
  await sortBtn.click();
  // Give React time to update state, re-fetch, and re-render
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

// ===========================================================================
// TC-01: Default sort is ASC
// ===========================================================================

test.describe('TC-01: Default sort is ASC on fresh navigation to /orders', () => {
  test('sort toggle shows ASC state (aria-label "Sắp xếp cũ nhất trước") by default', async ({
    page,
  }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await page.waitForLoadState('networkidle');

    // Default sort is 'asc' — URL must not contain sort=desc
    const url = page.url();
    expect(url).not.toMatch(/[?&]sort=desc/);

    // When sortDir === 'asc', the aria-label reads "Sắp xếp cũ nhất trước"
    const sortBtn = page.getByRole('button', { name: 'Sắp xếp cũ nhất trước' });
    await expect(sortBtn).toBeVisible({ timeout: 8_000 });
  });
});

// ===========================================================================
// TC-02 & TC-03: Toggle to DESC, then back to ASC — verify card order changes
//
// Two orders share a unique prefix so the search isolates exactly two cards:
//   - "OLDER": backdated 2 days (non-priority, created earlier)
//   - "NEWER": created now     (non-priority, created later)
//
// ASC  (oldest first): OLDER card appears above NEWER card (smaller Y)
// DESC (newest first): NEWER card appears above OLDER card (smaller Y)
// ASC again:           OLDER card appears above NEWER card again
// ===========================================================================

test.describe('TC-02 & TC-03: Sort toggle changes card order (stale-closure regression)', () => {
  let token: string;
  let olderCustomerId: string;
  let newerCustomerId: string;
  let olderDeviceName: string;
  let newerDeviceName: string;
  let sharedPrefix: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
    sharedPrefix = `SORT114-${Date.now()}`;

    // Seed the OLDER order first
    const older = await seedOrder(token, request, {
      phone: `096${String(Date.now()).slice(-7)}`,
      deviceSuffix: `${sharedPrefix}-OLD`,
    });
    olderDeviceName = older.deviceName;
    olderCustomerId = older.customerId;

    // Backdate by 2 days — keeps it non-priority (<3 days) so priority sort
    // does not interfere; only created_at sort matters
    backdateOrder(older.orderId, 2);

    // Small delay to guarantee the NEWER order has a later timestamp
    await new Promise((r) => setTimeout(r, 100));

    // Seed the NEWER order (created just now — no backdate)
    const newer = await seedOrder(token, request, {
      phone: `097${String(Date.now()).slice(-7)}`,
      deviceSuffix: `${sharedPrefix}-NEW`,
    });
    newerDeviceName = newer.deviceName;
    newerCustomerId = newer.customerId;
  });

  test.afterAll(async ({ request }) => {
    await cleanup(token, request, olderCustomerId);
    await cleanup(token, request, newerCustomerId);
  });

  test('TC-02: toggling to DESC moves newer order above older order', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/orders');
    await searchOrders(page, sharedPrefix);

    // Confirm both cards are visible
    await expect(page.getByText(olderDeviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(newerDeviceName)).toBeVisible({ timeout: 10_000 });

    // ASC baseline: OLDER card must appear above NEWER card
    const olderCard = page
      .locator('div.bg-white.rounded-2xl')
      .filter({ hasText: olderDeviceName });
    const newerCard = page
      .locator('div.bg-white.rounded-2xl')
      .filter({ hasText: newerDeviceName });

    const olderBoxAsc = await olderCard.boundingBox();
    const newerBoxAsc = await newerCard.boundingBox();
    expect(olderBoxAsc).not.toBeNull();
    expect(newerBoxAsc).not.toBeNull();
    expect(olderBoxAsc!.y).toBeLessThan(newerBoxAsc!.y);

    // Toggle to DESC
    await clickSortToggle(page);

    // Re-search to ensure the filtered list is still scoped
    await searchOrders(page, sharedPrefix);

    // Confirm both cards are still visible after reload
    await expect(page.getByText(newerDeviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(olderDeviceName)).toBeVisible({ timeout: 10_000 });

    // DESC: NEWER card must now appear above OLDER card
    const olderBoxDesc = await olderCard.boundingBox();
    const newerBoxDesc = await newerCard.boundingBox();
    expect(olderBoxDesc).not.toBeNull();
    expect(newerBoxDesc).not.toBeNull();
    expect(newerBoxDesc!.y).toBeLessThan(olderBoxDesc!.y);

    // The URL must now reflect sort=desc
    expect(page.url()).toMatch(/[?&]sort=desc/);
  });

  test('TC-03: toggling back to ASC restores older order above newer order', async ({ page }) => {
    await loginViaUI(page);
    // Start in DESC by navigating with sort=desc in the URL
    await page.goto('/orders?sort=desc');
    await searchOrders(page, sharedPrefix);

    await expect(page.getByText(olderDeviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(newerDeviceName)).toBeVisible({ timeout: 10_000 });

    // DESC baseline: NEWER card must be above OLDER card
    const olderCard = page
      .locator('div.bg-white.rounded-2xl')
      .filter({ hasText: olderDeviceName });
    const newerCard = page
      .locator('div.bg-white.rounded-2xl')
      .filter({ hasText: newerDeviceName });

    const olderBoxDesc = await olderCard.boundingBox();
    const newerBoxDesc = await newerCard.boundingBox();
    expect(olderBoxDesc).not.toBeNull();
    expect(newerBoxDesc).not.toBeNull();
    expect(newerBoxDesc!.y).toBeLessThan(olderBoxDesc!.y);

    // Toggle back to ASC
    await clickSortToggle(page);

    // Re-search to keep filter active
    await searchOrders(page, sharedPrefix);

    await expect(page.getByText(olderDeviceName)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(newerDeviceName)).toBeVisible({ timeout: 10_000 });

    // ASC restored: OLDER card must again appear above NEWER card
    const olderBoxAsc = await olderCard.boundingBox();
    const newerBoxAsc = await newerCard.boundingBox();
    expect(olderBoxAsc).not.toBeNull();
    expect(newerBoxAsc).not.toBeNull();
    expect(olderBoxAsc!.y).toBeLessThan(newerBoxAsc!.y);

    // URL must not contain sort=desc when back to ASC
    expect(page.url()).not.toMatch(/[?&]sort=desc/);
  });
});

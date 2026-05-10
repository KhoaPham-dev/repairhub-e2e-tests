/**
 * TC-08 — Settings, Auth UX & Role Permissions (RH-73 Epic)
 *
 * Covers API-level scenarios for:
 *   RH-74  Settings page & bottom nav (API-level only; UI rendering = manual)
 *   RH-75  Logout (API-level; dialog rendering = manual)
 *   RH-76  Technician role BE permissions
 *   RH-77  Change password PATCH /api/users/:id/password
 *   RH-78  Infinite scroll — pagination on orders and customers
 *
 * Frontend-only acceptance criteria (settings page rendering, logout dialog,
 * bottom nav visibility) are marked as MANUAL in the test plan and are NOT
 * executed here because the frontend is not available in this test environment.
 */

const { api, login, buildImageFormData } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS, makeCustomer, makeBranch, makeOrder } = require('../fixtures/test-data');

const RUN = Date.now().toString().slice(-5);

// Dedicated password-change test user credentials — created fresh per run
// so password change tests never touch the seed technician account.
const PASSWD_TEST_USER = {
  username: `pwtest_${RUN}`,
  password: `InitPass${RUN}!`,
  full_name: `Test PW User ${RUN}`,
  role: 'TECHNICIAN',
};

let adminToken;
let techToken;
let adminId;
let techId;
let pwTestUserId;
let pwTestUserToken;

// Shared resources
let branchId;
let customerId;
let orderId;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);

  // Fetch current user IDs
  const { body: adminMe } = await api.get('/auth/me', { token: adminToken });
  adminId = adminMe.data.id;

  const { body: techMe } = await api.get('/auth/me', { token: techToken });
  techId = techMe.data.id;

  // Create a dedicated password-change test user
  const createRes = await api.post('/users', {
    token: adminToken,
    body: PASSWD_TEST_USER,
  });
  if (createRes.status !== 201) {
    throw new Error(`Failed to create password-test user: ${JSON.stringify(createRes.body)}`);
  }
  pwTestUserId = createRes.body.data.id;
  pwTestUserToken = await login(PASSWD_TEST_USER.username, PASSWD_TEST_USER.password);

  // Create a branch, customer, and order for image upload test
  const branchRes = await api.post('/branches', {
    token: adminToken,
    body: makeBranch(),
  });
  branchId = branchRes.body.data.id;

  const custRes = await api.post('/customers', {
    token: adminToken,
    body: makeCustomer(),
  });
  customerId = custRes.body.data.id;

  const orderRes = await api.post('/orders', {
    token: adminToken,
    body: makeOrder(customerId, branchId),
  });
  orderId = orderRes.body.data.id;
});

afterAll(async () => {
  // Deactivate password-test user to keep the DB clean
  if (pwTestUserId) {
    await api.delete(`/users/${pwTestUserId}`, { token: adminToken });
  }
});

// ─── RH-77: Change Password ────────────────────────────────────────────────

describe('RH-77 PATCH /users/:id/password — change password', () => {
  test('newPassword shorter than 8 characters returns 400', async () => {
    const { status, body } = await api.patch(`/users/${pwTestUserId}/password`, {
      token: adminToken,
      body: { newPassword: 'abc123' }, // 6 chars
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Admin can change another user password (204)', async () => {
    const newPass = `AdminSet${RUN}Aa!`;
    const { status } = await api.patch(`/users/${pwTestUserId}/password`, {
      token: adminToken,
      body: { newPassword: newPass },
    });

    expect(status).toBe(204);

    // Restore to original password so the pwTestUser can log in again in subsequent tests
    const restoreRes = await api.patch(`/users/${pwTestUserId}/password`, {
      token: adminToken,
      body: { newPassword: PASSWD_TEST_USER.password },
    });
    expect(restoreRes.status).toBe(204);
  });

  test('Technician can change own password (204)', async () => {
    // Re-login to get fresh token with current password
    const freshToken = await login(PASSWD_TEST_USER.username, PASSWD_TEST_USER.password);

    const newPass = `SelfSet${RUN}Bb!`;
    const { status } = await api.patch(`/users/${pwTestUserId}/password`, {
      token: freshToken,
      body: { newPassword: newPass },
    });

    expect(status).toBe(204);

    // Restore — admin restores back to known password
    const restoreRes = await api.patch(`/users/${pwTestUserId}/password`, {
      token: adminToken,
      body: { newPassword: PASSWD_TEST_USER.password },
    });
    expect(restoreRes.status).toBe(204);
  });

  test('Technician cannot change another user password (403)', async () => {
    // pwTestUser (TECHNICIAN) tries to change adminId's password
    const freshToken = await login(PASSWD_TEST_USER.username, PASSWD_TEST_USER.password);

    const { status, body } = await api.patch(`/users/${adminId}/password`, {
      token: freshToken,
      body: { newPassword: 'ShouldFail99!x' },
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Invalid (non-UUID) :id returns 404', async () => {
    const { status, body } = await api.patch('/users/not-a-valid-uuid/password', {
      token: adminToken,
      body: { newPassword: 'ValidPassword1!' },
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('Valid UUID for non-existent user returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const { status, body } = await api.patch(`/users/${fakeId}/password`, {
      token: adminToken,
      body: { newPassword: 'ValidPassword1!' },
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  test('Missing newPassword field returns 400', async () => {
    const { status, body } = await api.patch(`/users/${pwTestUserId}/password`, {
      token: adminToken,
      body: {},
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Unauthenticated request returns 401', async () => {
    const { status, body } = await api.patch(`/users/${adminId}/password`, {
      body: { newPassword: 'ValidPassword1!' },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });
});

// ─── RH-78: Infinite Scroll — Pagination ───────────────────────────────────

describe('RH-78 GET /orders — pagination (infinite scroll)', () => {
  test('GET /orders with limit=20 offset=0 returns success with data array', async () => {
    const { status, body } = await api.get('/orders?limit=20&offset=0', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(20);
  });

  test('Each order in paginated response has required fields', async () => {
    const { body } = await api.get('/orders?limit=5&offset=0', {
      token: adminToken,
    });

    if (body.data.length > 0) {
      const order = body.data[0];
      expect(order).toHaveProperty('id');
      expect(order).toHaveProperty('order_code');
      expect(order).toHaveProperty('status');
      expect(order).toHaveProperty('customer_name');
      expect(order).toHaveProperty('device_name');
    }
  });

  test('Increasing offset changes the result set (pagination moves forward)', async () => {
    const page1 = await api.get('/orders?limit=1&offset=0', { token: adminToken });
    const page2 = await api.get('/orders?limit=1&offset=1', { token: adminToken });

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    if (page1.body.data.length > 0 && page2.body.data.length > 0) {
      expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
    }
  });

  test('limit is capped at 100 (server enforces max)', async () => {
    const { status, body } = await api.get('/orders?limit=200&offset=0', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(100);
  });
});

describe('RH-78 GET /customers — pagination (infinite scroll)', () => {
  test('GET /customers with limit=20 offset=0 returns success with data array', async () => {
    const { status, body } = await api.get('/customers?limit=20&offset=0', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(20);
  });

  test('Each customer in paginated response has required fields', async () => {
    const { body } = await api.get('/customers?limit=5&offset=0', {
      token: adminToken,
    });

    if (body.data.length > 0) {
      const customer = body.data[0];
      expect(customer).toHaveProperty('id');
      expect(customer).toHaveProperty('name');
      expect(customer).toHaveProperty('phone');
      expect(customer).toHaveProperty('type');
    }
  });

  test('offset=0 and offset=1 differ (cursor moves)', async () => {
    const page1 = await api.get('/customers?limit=1&offset=0', { token: adminToken });
    const page2 = await api.get('/customers?limit=1&offset=1', { token: adminToken });

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    if (page1.body.data.length > 0 && page2.body.data.length > 0) {
      expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
    }
  });

  test('limit is capped at 200 (server enforces max)', async () => {
    const { status, body } = await api.get('/customers?limit=500&offset=0', {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(200);
  });
});

// ─── RH-76: Technician Role BE Permissions ─────────────────────────────────

describe('RH-76 Technician role — BE permissions', () => {
  test('Technician can POST to /orders/:id/images (not blocked by role check)', async () => {
    const form = buildImageFormData('INTAKE');

    const { status, body } = await api.post(`/orders/${orderId}/images`, {
      token: techToken,
      formData: form,
    });

    // 201 = uploaded; 400 = no valid files (but not 403, meaning role allows access)
    expect([201, 400]).toContain(status);
    expect(status).not.toBe(403);
    if (status === 201) {
      expect(body.success).toBe(true);
    }
  });

  test('Technician cannot GET /users (403)', async () => {
    const { status, body } = await api.get('/users', { token: techToken });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });
});

// ─── RH-75: Logout — API-level ─────────────────────────────────────────────

describe('RH-75 Logout — API-level (POST /auth/logout)', () => {
  test('Authenticated POST /auth/logout returns 200 or 204', async () => {
    // Get a fresh token just for logout so main adminToken stays usable
    const tempToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);

    const { status } = await api.post('/auth/logout', { token: tempToken, body: {} });

    // Backend may return 200 or 204; either indicates the server processed the logout
    expect([200, 204]).toContain(status);
  });

  // Frontend scenarios — manual verification required:
  //   - Clicking "Đăng xuất" shows confirmation dialog with "Huỷ" and "Đăng xuất" buttons
  //   - Confirming logout clears auth token from localStorage and redirects to /login
  //   - Cancelling dismisses the dialog and stays on /settings
});

// ─── RH-74 / RH-76: Settings page — API-level auth guard ──────────────────
// The settings page itself is frontend-rendered and requires a browser.
// What we can verify at API level: admin-gated routes behave correctly.

describe('RH-74 & RH-76 Settings page — API-level access control', () => {
  test('Admin can access GET /users (staff management endpoint accessible)', async () => {
    const { status, body } = await api.get('/users', { token: adminToken });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('Technician cannot access GET /users (admin-only staff endpoint returns 403)', async () => {
    const { status, body } = await api.get('/users', { token: techToken });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Unauthenticated request to /users returns 401 (auth guard blocks)', async () => {
    const { status, body } = await api.get('/users');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  // Frontend scenarios — manual verification required:
  //   - Navigating to /settings renders a page with "Đổi mật khẩu" and "Đăng xuất" items
  //   - Admin sees "Quản lý nhân viên" item; technician does not
  //   - /settings/staff is accessible to admin, redirects away for technician
});

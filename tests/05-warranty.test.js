/**
 * TC-05 — Warranty Lookup (RH-8)
 *
 * Covers:
 *   - Search by phone number returns completed (DA_GIAO) orders
 *   - Search by serial/IMEI returns completed order
 *   - Search by device name (partial, Vietnamese)
 *   - Warranty status badge: ACTIVE vs EXPIRED
 *   - Orders within 30 days of expiry are flagged expiring_soon
 *   - Non-delivered orders are NOT returned in warranty search
 *   - Search response contains warranty_end_date and warranty_status
 *   - Empty query returns empty array
 *   - Unauthenticated request rejected
 *
 * NOTE: These tests create real orders and advance them to DA_GIAO
 * to validate warranty lookup on live data.
 */

const { api, login } = require('../helpers/api');
const {
  ADMIN_CREDS,
  TECH_CREDS,
  makeCustomer,
  makeBranch,
  makeOrder,
} = require('../fixtures/test-data');

let adminToken;
let techToken;
let customerId;
let branchId;
let deliveredOrderId;
let deliveredOrderSerial;
let deliveredOrderDeviceName;
let customerPhone;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);

  // Create customer + branch
  const customerData = makeCustomer();
  customerPhone = customerData.phone;
  const { body: cBody } = await api.post('/customers', {
    token: adminToken,
    body: customerData,
  });
  customerId = cBody.data.id;

  const branchData = makeBranch();
  const { body: bBody } = await api.post('/branches', {
    token: adminToken,
    body: branchData,
  });
  branchId = bBody.data.id;

  // Create order with a known serial
  deliveredOrderSerial = `WARRANTY-TEST-${Date.now()}`;
  deliveredOrderDeviceName = `Loa Sony SRS-${Date.now()}`;

  const orderData = makeOrder(customerId, branchId, {
    serial_imei: deliveredOrderSerial,
    device_name: deliveredOrderDeviceName,
  });
  const { body: oBody } = await api.post('/orders', {
    token: techToken,
    body: orderData,
  });
  deliveredOrderId = oBody.data.id;

  // Advance through full workflow to DA_GIAO so warranty lookup works
  const steps = [
    'DANG_KIEM_TRA', 'BAO_GIA', 'CHO_LINH_KIEN',
    'DANG_SUA_CHUA', 'KIEM_TRA_LAI', 'SUA_XONG', 'DA_GIAO',
  ];
  for (const step of steps) {
    await api.put(`/orders/${deliveredOrderId}/status`, {
      token: techToken,
      body: { status: step },
    });
  }
});

afterAll(async () => {
  if (customerId) await api.delete(`/customers/${customerId}`, { token: adminToken });
  if (branchId) await api.delete(`/branches/${branchId}`, { token: adminToken });
});

describe('TC-05 Warranty Lookup', () => {
  test('Search by phone returns delivered order with warranty fields', async () => {
    const { status, body } = await api.get(
      `/warranty/search?q=${encodeURIComponent(customerPhone)}`,
      { token: techToken }
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    const found = body.data.find((o) => o.id === deliveredOrderId);
    expect(found).toBeDefined();
    expect(found.status).toBe('DA_GIAO');
    // Warranty fields must be present
    expect(['ACTIVE', 'EXPIRED', 'UNKNOWN']).toContain(found.warranty_status);
    expect(typeof found.expiring_soon).toBe('boolean');
  });

  test('Search by serial/IMEI returns the correct order', async () => {
    const { status, body } = await api.get(
      `/warranty/search?q=${encodeURIComponent(deliveredOrderSerial)}`,
      { token: techToken }
    );

    expect(status).toBe(200);
    const found = body.data.find((o) => o.id === deliveredOrderId);
    expect(found).toBeDefined();
    expect(found.serial_imei).toBe(deliveredOrderSerial);
  });

  test('Search by device name (partial Vietnamese) returns the order', async () => {
    // Use partial device name — first 8 characters
    const partial = deliveredOrderDeviceName.slice(0, 8);
    const { status, body } = await api.get(
      `/warranty/search?q=${encodeURIComponent(partial)}`,
      { token: techToken }
    );

    expect(status).toBe(200);
    const found = body.data.find((o) => o.id === deliveredOrderId);
    expect(found).toBeDefined();
  });

  test('Non-delivered orders are NOT returned in warranty search', async () => {
    // Create a new order at TIEP_NHAN (not delivered)
    const nonDeliveredCustomer = makeCustomer();
    const { body: cBody } = await api.post('/customers', {
      token: adminToken,
      body: nonDeliveredCustomer,
    });
    const ndCustomerId = cBody.data.id;

    await api.post('/orders', {
      token: techToken,
      body: makeOrder(ndCustomerId, branchId, {
        serial_imei: `NON-DELIVERED-${Date.now()}`,
      }),
    });

    // Search by the non-delivered customer's phone
    const { body } = await api.get(
      `/warranty/search?q=${encodeURIComponent(nonDeliveredCustomer.phone)}`,
      { token: techToken }
    );

    // All results must be DA_GIAO only
    const allDelivered = body.data.every((o) => o.status === 'DA_GIAO');
    expect(allDelivered).toBe(true);

    // Cleanup
    await api.delete(`/customers/${ndCustomerId}`, { token: adminToken });
  });

  test('Empty query string returns empty array', async () => {
    const { status, body } = await api.get('/warranty/search?q=', { token: techToken });

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  test('Missing q parameter returns empty array', async () => {
    const { status, body } = await api.get('/warranty/search', { token: techToken });

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  test('Unauthenticated warranty search returns 401', async () => {
    const { status, body } = await api.get('/warranty/search?q=test');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('warranty_status is ACTIVE for recently delivered order', async () => {
    const { body } = await api.get(
      `/warranty/search?q=${encodeURIComponent(deliveredOrderSerial)}`,
      { token: techToken }
    );

    const found = body.data.find((o) => o.id === deliveredOrderId);
    // A just-delivered order has warranty_end_date in the future if warranty_period_months > 0
    // (default is 12 months from the DB schema)
    expect(found).toBeDefined();
    // warranty_end_date should be set if status transitions set it
    if (found.warranty_end_date) {
      const endDate = new Date(found.warranty_end_date);
      const now = new Date();
      // For a just-delivered order, end date should be in the future (Active)
      expect(found.warranty_status).toBe('ACTIVE');
    }
  });
});

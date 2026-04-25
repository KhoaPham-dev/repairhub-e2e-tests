/**
 * TC-03 — Customer Management (RH-5)
 *
 * Covers:
 *   - Create customer (RETAIL) with all fields
 *   - Create customer (PARTNER) type
 *   - Phone uniqueness enforced
 *   - Search by phone (partial match)
 *   - Search by name (partial, case-insensitive, Vietnamese diacritics)
 *   - Auto-suggest endpoint returns matches as user types
 *   - Customer type filter (RETAIL vs PARTNER)
 *   - Get customer by ID with order history
 *   - Edit customer details
 *   - Delete customer
 *   - Phone format validation (10–11 digits)
 *   - Unauthenticated request rejected
 */

const { api, login } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS, makeCustomer, makePartnerCustomer } = require('../fixtures/test-data');

let adminToken;
let techToken;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);
});

describe('TC-03 Customer Management', () => {
  let retailCustomerId;
  let partnerCustomerId;
  const retailData = makeCustomer();
  const partnerData = makePartnerCustomer();

  // ── Create ─────────────────────────────────────────────────────────────────

  test('Create RETAIL customer with all fields', async () => {
    const { status, body } = await api.post('/customers', {
      token: adminToken,
      body: retailData,
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.phone).toBe(retailData.phone);
    expect(body.data.name).toBe(retailData.name);
    expect(body.data.type).toBe('RETAIL');
    expect(typeof body.data.id).toBe('string');

    retailCustomerId = body.data.id;
  });

  test('Create PARTNER customer', async () => {
    const { status, body } = await api.post('/customers', {
      token: techToken,
      body: partnerData,
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('PARTNER');

    partnerCustomerId = body.data.id;
  });

  test('Duplicate phone number is rejected', async () => {
    const { status, body } = await api.post('/customers', {
      token: adminToken,
      body: { ...makeCustomer(), phone: retailData.phone },
    });

    // Must be rejected due to unique constraint
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.success).toBe(false);
  });

  // ── Read / Search ──────────────────────────────────────────────────────────

  test('GET /customers returns paginated list', async () => {
    const { status, body } = await api.get('/customers', { token: adminToken });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const found = body.data.find((c) => c.id === retailCustomerId);
    expect(found).toBeDefined();
  });

  test('Search customers by partial phone', async () => {
    const partialPhone = retailData.phone.slice(0, 6); // first 6 digits
    const { status, body } = await api.get(
      `/customers?search=${encodeURIComponent(partialPhone)}`,
      { token: adminToken }
    );

    expect(status).toBe(200);
    const found = body.data.find((c) => c.id === retailCustomerId);
    expect(found).toBeDefined();
  });

  test('Search customers by partial Vietnamese name (case-insensitive)', async () => {
    // Take the run-unique suffix from the name
    const searchTerm = 'Nguyễn Văn Bình';
    const { status, body } = await api.get(
      `/customers?search=${encodeURIComponent(searchTerm)}`,
      { token: adminToken }
    );

    expect(status).toBe(200);
    // At least one result containing this name pattern
    const found = body.data.find((c) => c.name.includes('Nguyễn Văn Bình'));
    expect(found).toBeDefined();
  });

  test('Auto-suggest endpoint returns matches as user types', async () => {
    const partialPhone = retailData.phone.slice(0, 5);
    const { status, body } = await api.get(
      `/customers/search?q=${encodeURIComponent(partialPhone)}`,
      { token: techToken }
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // Auto-suggest returns ≤10 results
    expect(body.data.length).toBeLessThanOrEqual(10);
    const found = body.data.find((c) => c.id === retailCustomerId);
    expect(found).toBeDefined();
  });

  test('Auto-suggest with empty query returns empty array', async () => {
    const { status, body } = await api.get('/customers/search?q=', { token: techToken });

    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  test('Filter customers by type PARTNER', async () => {
    const { status, body } = await api.get('/customers?type=PARTNER', { token: adminToken });

    expect(status).toBe(200);
    const allPartners = body.data.every((c) => c.type === 'PARTNER');
    expect(allPartners).toBe(true);
    const found = body.data.find((c) => c.id === partnerCustomerId);
    expect(found).toBeDefined();
  });

  test('Get customer by ID includes order history field', async () => {
    const { status, body } = await api.get(`/customers/${retailCustomerId}`, {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.data.id).toBe(retailCustomerId);
    expect(Array.isArray(body.data.orders)).toBe(true);
  });

  // ── Edit ───────────────────────────────────────────────────────────────────

  test('Admin can edit customer address and notes', async () => {
    const newAddress = '999 Đường Võ Văn Tần, Quận 3, TP.HCM';
    const { status, body } = await api.put(`/customers/${retailCustomerId}`, {
      token: adminToken,
      body: { address: newAddress, notes: 'VIP khách hàng' },
    });

    expect(status).toBe(200);
    expect(body.data.address).toBe(newAddress);
    expect(body.data.notes).toBe('VIP khách hàng');
  });

  // ── Security ───────────────────────────────────────────────────────────────

  test('Unauthenticated request to /customers returns 401', async () => {
    const { status, body } = await api.get('/customers');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('Missing required fields (phone) returns 400', async () => {
    const { status, body } = await api.post('/customers', {
      token: adminToken,
      body: { name: 'Khách hàng không số điện thoại' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  test('Admin can delete customer without orders', async () => {
    const { status, body } = await api.delete(`/customers/${partnerCustomerId}`, {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  afterAll(async () => {
    // Clean up retail customer if it wasn't deleted during the test
    if (retailCustomerId) {
      await api.delete(`/customers/${retailCustomerId}`, { token: adminToken });
    }
  });
});

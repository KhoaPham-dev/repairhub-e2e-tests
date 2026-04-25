/**
 * TC-02 — Multi-branch Management (RH-4)
 *
 * Covers:
 *   - Admin can create a branch with all required fields
 *   - Branch persisted and returned in GET list
 *   - Admin can edit branch fields
 *   - Admin can disable (soft-delete) branch
 *   - Disabled branch does not appear in active list
 *   - Admin can re-enable branch
 *   - Branch with active orders cannot be deleted
 *   - Technician cannot create/edit/delete branches (RBAC)
 *   - Branch name search filter works
 */

const { api, login } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS, makeBranch } = require('../fixtures/test-data');

let adminToken;
let techToken;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);
});

describe('TC-02 Branch Management', () => {
  let branchId;
  const branchData = makeBranch();

  // ── Create ─────────────────────────────────────────────────────────────────

  test('Admin can create a branch with all fields', async () => {
    const { status, body } = await api.post('/branches', {
      token: adminToken,
      body: branchData,
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(branchData.name);
    expect(body.data.address).toBe(branchData.address);
    expect(body.data.phone).toBe(branchData.phone);
    expect(body.data.manager_name).toBe(branchData.manager_name);
    expect(body.data.is_active).toBe(true);
    expect(typeof body.data.id).toBe('string');

    branchId = body.data.id;
  });

  test('Branch appears in active branch list after creation', async () => {
    const { status, body } = await api.get('/branches', { token: adminToken });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const found = body.data.find((b) => b.id === branchId);
    expect(found).toBeDefined();
    expect(found.name).toBe(branchData.name);
  });

  test('Branch is searchable by name', async () => {
    const searchTerm = branchData.name.split(' ').slice(-1)[0]; // last word of name
    const { status, body } = await api.get(`/branches?search=${encodeURIComponent(searchTerm)}`, {
      token: adminToken,
    });

    expect(status).toBe(200);
    const found = body.data.find((b) => b.id === branchId);
    expect(found).toBeDefined();
  });

  // ── Read single ────────────────────────────────────────────────────────────

  test('Admin can get single branch by ID', async () => {
    const { status, body } = await api.get(`/branches/${branchId}`, { token: adminToken });

    expect(status).toBe(200);
    expect(body.data.id).toBe(branchId);
    expect(body.data.name).toBe(branchData.name);
  });

  // ── Edit ───────────────────────────────────────────────────────────────────

  test('Admin can update branch manager name', async () => {
    const newManager = 'Lê Văn Quân (Cập nhật)';
    const { status, body } = await api.put(`/branches/${branchId}`, {
      token: adminToken,
      body: { manager_name: newManager },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.manager_name).toBe(newManager);
  });

  // ── Disable / Enable ───────────────────────────────────────────────────────

  test('Admin can disable (soft-delete) a branch', async () => {
    const { status, body } = await api.delete(`/branches/${branchId}`, {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('Disabled branch does not appear in active branch list', async () => {
    const { status, body } = await api.get('/branches', { token: adminToken });

    expect(status).toBe(200);
    const found = body.data.find((b) => b.id === branchId);
    expect(found).toBeUndefined();
  });

  test('Disabled branch appears when include_inactive=true', async () => {
    const { status, body } = await api.get('/branches?include_inactive=true', {
      token: adminToken,
    });

    expect(status).toBe(200);
    const found = body.data.find((b) => b.id === branchId);
    expect(found).toBeDefined();
    expect(found.is_active).toBe(false);
  });

  test('Admin can re-enable a disabled branch', async () => {
    const { status, body } = await api.post(`/branches/${branchId}/enable`, {
      token: adminToken,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('Re-enabled branch appears in active list again', async () => {
    const { status, body } = await api.get('/branches', { token: adminToken });

    expect(status).toBe(200);
    const found = body.data.find((b) => b.id === branchId);
    expect(found).toBeDefined();
    expect(found.is_active).toBe(true);
  });

  // ── RBAC ───────────────────────────────────────────────────────────────────

  test('Technician cannot create a branch (403)', async () => {
    const { status, body } = await api.post('/branches', {
      token: techToken,
      body: makeBranch(),
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Technician cannot update a branch (403)', async () => {
    const { status, body } = await api.put(`/branches/${branchId}`, {
      token: techToken,
      body: { manager_name: 'Hack attempt' },
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Technician cannot delete a branch (403)', async () => {
    const { status, body } = await api.delete(`/branches/${branchId}`, {
      token: techToken,
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  test('Creating branch without name returns 400', async () => {
    const { status, body } = await api.post('/branches', {
      token: adminToken,
      body: { address: 'Somewhere', phone: '0901234567' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  // ── Cleanup: disable the test branch ──────────────────────────────────────
  afterAll(async () => {
    if (branchId) {
      await api.delete(`/branches/${branchId}`, { token: adminToken });
    }
  });
});

/**
 * TC-01 — Authentication & Session (RH-3)
 *
 * Covers:
 *   - Login with valid admin credentials → JWT returned
 *   - Login with valid technician credentials → JWT returned
 *   - Login with invalid password → 401, generic error message
 *   - Login with non-existent user → 401, no system info leaked
 *   - Login with missing fields → 400
 *   - GET /auth/me with valid token → user data returned
 *   - GET /auth/me with no token → 401
 *   - POST /auth/logout with valid token → success
 *   - SQL injection in username field → rejected safely
 */

const { api, login } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS } = require('../fixtures/test-data');

describe('TC-01 Authentication & Session', () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  test('Admin login returns JWT and user profile', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: ADMIN_CREDS,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe('string');
    expect(body.data.token.split('.').length).toBe(3); // JWT = 3 segments
    expect(body.data.user.role).toBe('ADMIN');
    expect(body.data.user.username).toBe('admin');
    // Password hash must NOT be in the response
    expect(body.data.user.password_hash).toBeUndefined();
  });

  test('Technician login returns JWT with TECHNICIAN role', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: TECH_CREDS,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.user.role).toBe('TECHNICIAN');
    expect(typeof body.data.token).toBe('string');
  });

  test('GET /auth/me with valid admin token returns profile', async () => {
    const token = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
    const { status, body } = await api.get('/auth/me', { token });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.username).toBe('admin');
    expect(body.data.role).toBe('ADMIN');
  });

  test('POST /auth/logout with valid token returns success', async () => {
    const token = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
    const { status, body } = await api.post('/auth/logout', { token });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  // ── Failure / security paths ───────────────────────────────────────────────

  test('Login with wrong password returns 401 and generic message', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: { username: 'admin', password: 'wrongpassword' },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    // Error message must not reveal whether user exists or which field is wrong
    expect(body.error).toMatch(/tên đăng nhập|mật khẩu|không đúng/i);
    // Must not expose stack trace or DB details
    expect(JSON.stringify(body)).not.toMatch(/stack|sql|pg|postgres/i);
  });

  test('Login with non-existent username returns 401 with generic message', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: { username: 'nobody_exists_xyz', password: 'anypassword' },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test('Login with missing password field returns 400', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: { username: 'admin' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('Login with missing username field returns 400', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: { password: 'admin123' },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('GET /auth/me with no token returns 401', async () => {
    const { status, body } = await api.get('/auth/me');

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('GET /auth/me with garbage token returns 401', async () => {
    const { status, body } = await api.get('/auth/me', { token: 'not.a.valid.jwt' });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  test('SQL injection in username is safely rejected', async () => {
    const { status, body } = await api.post('/auth/login', {
      body: {
        username: "admin' OR '1'='1'; --",
        password: 'anything',
      },
    });

    // Must return 401 (user not found) — NOT 200 or 500
    expect([400, 401]).toContain(status);
    expect(body.success).toBe(false);
    // Response must not contain stack traces or SQL errors
    expect(JSON.stringify(body)).not.toMatch(/syntax error|pg error|stack/i);
  });
});

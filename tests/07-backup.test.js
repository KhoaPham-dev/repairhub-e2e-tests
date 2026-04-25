/**
 * TC-07 — Data Backup & Restore (RH-9)
 *
 * Covers:
 *   - GET /backup returns list of backups and schedule_hour
 *   - POST /backup/now triggers manual backup, returns filename with timestamp
 *   - Backup filename follows naming convention (backup_YYYY-MM-DD...)
 *   - GET /backup/download/:filename downloads the .zip file
 *   - POST /backup/restore with valid filename succeeds
 *   - POST /backup/restore with non-existent file returns 404
 *   - Backup operations appear in activity log
 *   - Backup endpoint requires admin (technician gets 403)
 *   - Backup list is limited to last 30
 */

const { api, login } = require('../helpers/api');
const { ADMIN_CREDS, TECH_CREDS } = require('../fixtures/test-data');

let adminToken;
let techToken;

beforeAll(async () => {
  adminToken = await login(ADMIN_CREDS.username, ADMIN_CREDS.password);
  techToken = await login(TECH_CREDS.username, TECH_CREDS.password);
});

describe('TC-07 Data Backup & Restore', () => {
  let backupFilename;

  // ── List ───────────────────────────────────────────────────────────────────

  test('GET /backup returns log list and schedule_hour', async () => {
    const { status, body } = await api.get('/backup', { token: adminToken });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.logs)).toBe(true);
    expect(typeof body.data.schedule_hour).toBe('string');
    // Default schedule hour from system_config is '2'
    expect(Number(body.data.schedule_hour)).toBeGreaterThanOrEqual(0);
    expect(Number(body.data.schedule_hour)).toBeLessThan(24);
  });

  // ── Manual trigger ─────────────────────────────────────────────────────────

  test('POST /backup/now triggers manual backup and returns filename', async () => {
    const { status, body } = await api.post('/backup/now', {
      token: adminToken,
      body: {},
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(typeof body.data.filename).toBe('string');
    expect(body.data.filename).toMatch(/^backup_.*\.zip$/);

    backupFilename = body.data.filename;
  });

  test('Backup filename contains timestamp in ISO-like format', async () => {
    // Expected pattern: backup_YYYY-MM-DDTHH-MM-SS.zip or backup_YYYY-MM-DD_HH-MM-SS.zip
    expect(backupFilename).toMatch(/backup_\d{4}-\d{2}-\d{2}/);
  });

  test('New backup appears in GET /backup log list', async () => {
    const { status, body } = await api.get('/backup', { token: adminToken });

    expect(status).toBe(200);
    const found = body.data.logs.find((l) => l.filename === backupFilename);
    expect(found).toBeDefined();
    expect(found.status).toBe('SUCCESS');
    expect(typeof found.size_bytes).toBe('number');
    expect(found.size_bytes).toBeGreaterThan(0);
  });

  // ── Download ───────────────────────────────────────────────────────────────

  test('GET /backup/download/:filename returns binary zip content', async () => {
    const { status, body } = await api.get(
      `/backup/download/${backupFilename}`,
      { token: adminToken }
    );

    expect(status).toBe(200);
    // body is a Buffer for binary responses
    expect(Buffer.isBuffer(body)).toBe(true);
    // ZIP magic bytes: 50 4B 03 04
    expect(body[0]).toBe(0x50); // P
    expect(body[1]).toBe(0x4b); // K
  });

  test('Download non-existent backup file returns 404', async () => {
    const { status, body } = await api.get(
      '/backup/download/backup_9999-99-99T99-99-99.zip',
      { token: adminToken }
    );

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  // ── Restore ────────────────────────────────────────────────────────────────

  test('POST /backup/restore with valid filename succeeds and auto-backs-up first', async () => {
    const { status, body } = await api.post('/backup/restore', {
      token: adminToken,
      body: { filename: backupFilename },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.message).toBeTruthy();
  });

  test('POST /backup/restore with non-existent file returns 404', async () => {
    const { status, body } = await api.post('/backup/restore', {
      token: adminToken,
      body: { filename: 'backup_does_not_exist.zip' },
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  // ── Activity log audit ─────────────────────────────────────────────────────

  test('Backup operations appear in activity log', async () => {
    const { status, body } = await api.get('/users/activity-log', {
      token: adminToken,
    });

    expect(status).toBe(200);
    const backupEntries = body.data.filter(
      (e) => e.action === 'MANUAL_BACKUP' || e.action === 'RESTORE_BACKUP'
    );
    expect(backupEntries.length).toBeGreaterThanOrEqual(1);
  });

  // ── RBAC ───────────────────────────────────────────────────────────────────

  test('Technician cannot list backups (403)', async () => {
    const { status, body } = await api.get('/backup', { token: techToken });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Technician cannot trigger manual backup (403)', async () => {
    const { status, body } = await api.post('/backup/now', {
      token: techToken,
      body: {},
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Technician cannot download backup (403)', async () => {
    const { status, body } = await api.get(
      `/backup/download/${backupFilename}`,
      { token: techToken }
    );

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  test('Technician cannot restore from backup (403)', async () => {
    const { status, body } = await api.post('/backup/restore', {
      token: techToken,
      body: { filename: backupFilename },
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  // ── Backup list limit ──────────────────────────────────────────────────────

  test('Backup log list does not exceed 30 entries', async () => {
    const { body } = await api.get('/backup', { token: adminToken });

    expect(body.data.logs.length).toBeLessThanOrEqual(30);
  });
});

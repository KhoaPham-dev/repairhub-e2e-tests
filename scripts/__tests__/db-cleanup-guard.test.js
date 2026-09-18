/**
 * Plain node:test coverage for the pure decision function that guards
 * scripts/db-cleanup.js against running DELETEs against a non-test
 * database. No `pg` connection, no fixtures — just the parsing + decision
 * logic, so this runs fast and needs nothing but Node itself.
 *
 * Run directly with: node --test scripts/__tests__
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCleanupTarget, isCleanupTargetAllowed, LOCAL_HOSTS } = require('../db-cleanup');

test('parseCleanupTarget extracts host + db name, never credentials', () => {
  const target = parseCleanupTarget('postgresql://postgres:S3cr3t@localhost:5432/repairhub');
  assert.equal(target.host, 'localhost');
  assert.equal(target.dbName, 'repairhub');
  assert.equal(JSON.stringify(target).includes('S3cr3t'), false);
});

test('parseCleanupTarget strips brackets from an IPv6 literal host', () => {
  const target = parseCleanupTarget('postgresql://user:pass@[::1]:5432/repairhub');
  assert.equal(target.host, '::1');
});

test('parseCleanupTarget returns nulls (fail-closed) for an unparseable URL', () => {
  const target = parseCleanupTarget('not a url');
  assert.equal(target.host, null);
  assert.equal(target.dbName, null);
});

test('every documented LOCAL_HOSTS entry is allowed without the remote override', () => {
  for (const host of LOCAL_HOSTS) {
    assert.equal(
      isCleanupTargetAllowed({ host, dbName: 'production' }, false),
      true,
      `expected host "${host}" to be allowed even with a non-test db name`
    );
  }
});

test('a db name matching /test|e2e/i is allowed on an otherwise unknown host', () => {
  assert.equal(isCleanupTargetAllowed({ host: 'db.example.com', dbName: 'repairhub_test' }, false), true);
  assert.equal(isCleanupTargetAllowed({ host: 'db.example.com', dbName: 'e2e_scratch' }, false), true);
  assert.equal(isCleanupTargetAllowed({ host: 'db.example.com', dbName: 'E2ETestDB' }, false), true);
});

test('an unrecognized host with a non-test db name is refused by default', () => {
  assert.equal(isCleanupTargetAllowed({ host: 'prod-db.example.com', dbName: 'repairhub' }, false), false);
  assert.equal(isCleanupTargetAllowed({ host: 'db.internal.corp', dbName: 'production' }, false), false);
});

test('an unparseable target (both null) is refused by default', () => {
  assert.equal(isCleanupTargetAllowed({ host: null, dbName: null }, false), false);
});

test('E2E_ALLOW_REMOTE_CLEANUP override allows anything, including a scary target', () => {
  assert.equal(isCleanupTargetAllowed({ host: 'prod-db.example.com', dbName: 'production' }, true), true);
});

test('"localhost" with a production-sounding db name is still allowed (host wins)', () => {
  assert.equal(isCleanupTargetAllowed({ host: 'localhost', dbName: 'production' }, false), true);
});

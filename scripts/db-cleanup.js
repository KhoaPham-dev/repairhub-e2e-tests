/**
 * Shared DB teardown for both the jest and Playwright suites.
 *
 * Test helpers record every customer they create to an append-only JSON
 * Lines "registry" file (one file per worker/process, so concurrent writers
 * never corrupt each other — see registry.js / registry.ts). At the end of
 * a run, this module reads every registry file under a given directory and,
 * if E2E_DATABASE_URL is set, deletes exactly those customers and everything
 * that depends on them (in FK-safe order, inside one transaction):
 *
 *   order_images -> order_status_history -> activity_log (order + customer
 *   rows) -> orders -> customers
 *
 * Nothing outside the registry is ever touched. If E2E_DATABASE_URL is not
 * set, cleanup is skipped with a single log line (the DELETE /customers/:id
 * API call now correctly 409s for any customer with orders — see
 * fix/customer-delete-with-orders — so without DB access test data is
 * simply left behind, same as before this change for customers with
 * orders).
 *
 * Before running any DELETE, the target host/db name (never credentials)
 * are logged and checked against isCleanupTargetAllowed(): only a
 * loopback host, a known local docker-compose Postgres service name, or a
 * db name matching /test|e2e/i is allowed, unless E2E_ALLOW_REMOTE_CLEANUP=1
 * is set. Otherwise cleanup refuses to run (throws) without touching the
 * registry or the database — this is a defense-in-depth guard against
 * E2E_DATABASE_URL accidentally pointing at a shared/staging/prod database;
 * every query is already scoped to registered ids regardless.
 */

const fs = require('fs');
const path = require('path');

// Hosts that are always safe to run DELETEs against without further checks:
// loopback addresses only. Docker-compose service names (e.g. `postgres`) are
// deliberately NOT trusted: repairhub-infra's production compose stack uses
// the same `postgres` service name, so trusting it would let a run on the VPS
// delete from the production database. Use a /test|e2e/i database name or
// E2E_ALLOW_REMOTE_CLEANUP=1 for anything that isn't loopback.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Parse E2E_DATABASE_URL into just the parts needed for the safety check
 * and for logging — never the credentials.
 */
function parseCleanupTarget(dbUrl) {
  let url;
  try {
    url = new URL(dbUrl);
  } catch {
    return { host: null, dbName: null };
  }
  // WHATWG URL wraps IPv6 literals in brackets ("[::1]") in .hostname;
  // strip them so it compares equal to the bare form in LOCAL_HOSTS.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const dbName = url.pathname.replace(/^\//, '') || null;
  return { host, dbName };
}

/**
 * Pure decision function — given a parsed target and whether the explicit
 * remote-cleanup override is set, decide whether it's safe to run DELETEs
 * against it. No I/O, no side effects, so it's cheap to unit test on its
 * own (see scripts/__tests__/db-cleanup-guard.test.js).
 */
function isCleanupTargetAllowed({ host, dbName }, allowRemote) {
  if (allowRemote) return true;
  if (host && LOCAL_HOSTS.has(host)) return true;
  if (dbName && /test|e2e/i.test(dbName)) return true;
  return false;
}

function readRegisteredCustomerIds(registryDir) {
  const ids = new Set();
  if (!fs.existsSync(registryDir)) return ids;
  for (const file of fs.readdirSync(registryDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(registryDir, file);
    const content = fs.readFileSync(full, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && typeof entry.id === 'string') ids.add(entry.id);
      } catch {
        // Ignore a malformed line (e.g. a partial write from a crashed worker)
        // rather than aborting the whole cleanup over one bad entry.
      }
    }
  }
  return ids;
}

function clearRegistry(registryDir) {
  if (!fs.existsSync(registryDir)) return;
  for (const file of fs.readdirSync(registryDir)) {
    if (file.endsWith('.jsonl')) fs.unlinkSync(path.join(registryDir, file));
  }
}

/**
 * Delete every customer recorded in `registryDir` (and their orders, order
 * images, order status history, and activity log rows) from the database at
 * E2E_DATABASE_URL. No-op (with a log line) if that env var isn't set, or if
 * the registry is empty. `label` is just used to prefix log output so
 * jest/Playwright output is distinguishable.
 */
async function cleanupRegisteredCustomers(registryDir, label) {
  const dbUrl = process.env.E2E_DATABASE_URL;
  if (!dbUrl) {
    console.log(`[e2e-cleanup:${label}] E2E_DATABASE_URL is not set — skipping DB teardown.`);
    return;
  }

  // Safety guard: never run DELETEs against something that doesn't look
  // like a local/test database, even though every query is scoped to
  // registered ids. Log the target (host + db name only — never
  // credentials) before deciding.
  const target = parseCleanupTarget(dbUrl);
  console.log(`[e2e-cleanup:${label}] target host=${target.host ?? '(unparseable)'} db=${target.dbName ?? '(unparseable)'}`);

  const allowRemote = process.env.E2E_ALLOW_REMOTE_CLEANUP === '1';
  if (!isCleanupTargetAllowed(target, allowRemote)) {
    throw new Error(
      `[e2e-cleanup:${label}] Refusing to run DB teardown: host "${target.host}" / db "${target.dbName}" ` +
      `is not a recognized local/test database (allowed hosts: ${Array.from(LOCAL_HOSTS).join(', ')}; ` +
      `or a db name matching /test|e2e/i). Nothing was deleted and the registry is intact. If this really ` +
      `is a database you want cleaned up, set E2E_ALLOW_REMOTE_CLEANUP=1.`
    );
  }

  const ids = Array.from(readRegisteredCustomerIds(registryDir));
  if (ids.length === 0) {
    console.log(`[e2e-cleanup:${label}] No registered test customers to clean up.`);
    return;
  }

  // Required lazily so `pg` is only a hard dependency when DB teardown is
  // actually used.
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const orderRows = await client.query('SELECT id FROM orders WHERE customer_id = ANY($1::uuid[])', [ids]);
    const orderIds = orderRows.rows.map((r) => r.id);

    if (orderIds.length > 0) {
      await client.query('DELETE FROM order_images WHERE order_id = ANY($1::uuid[])', [orderIds]);
      await client.query('DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])', [orderIds]);
      // activity_log has no FK to orders/customers (resource_id is a bare
      // UUID column shared across resource types) but we still scope
      // deletes to exactly the resources we're removing.
      await client.query(
        `DELETE FROM activity_log WHERE resource_type = 'order' AND resource_id = ANY($1::uuid[])`,
        [orderIds]
      );
    }
    await client.query(
      `DELETE FROM activity_log WHERE resource_type = 'customer' AND resource_id = ANY($1::uuid[])`,
      [ids]
    );
    await client.query('DELETE FROM orders WHERE customer_id = ANY($1::uuid[])', [ids]);
    const deletedCustomers = await client.query('DELETE FROM customers WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);

    await client.query('COMMIT');
    console.log(
      `[e2e-cleanup:${label}] Deleted ${deletedCustomers.rowCount} customer(s), ${orderIds.length} order(s) ` +
      `(${ids.length} customer id(s) were registered).`
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    console.error(`[e2e-cleanup:${label}] DB teardown failed, rolled back — registry left intact for retry:`, err);
    throw err;
  } finally {
    await client.end();
  }

  // Only clear the registry once the matching rows are confirmed gone, so a
  // failed/interrupted teardown can be retried against the same ids.
  clearRegistry(registryDir);
}

module.exports = {
  cleanupRegisteredCustomers,
  readRegisteredCustomerIds,
  clearRegistry,
  parseCleanupTarget,
  isCleanupTargetAllowed,
  LOCAL_HOSTS,
};

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
 */

const fs = require('fs');
const path = require('path');

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

module.exports = { cleanupRegisteredCustomers, readRegisteredCustomerIds, clearRegistry };

/**
 * Jest globalTeardown — runs once after the whole jest run finishes.
 * Deletes every customer (and dependent orders/images/history/activity-log
 * rows) recorded by helpers/api.js's request() wrapper, via
 * E2E_DATABASE_URL — see scripts/db-cleanup.js for the full explanation.
 */
const path = require('path');
const { cleanupRegisteredCustomers } = require('../scripts/db-cleanup');

module.exports = async function globalTeardown() {
  const registryDir = path.join(__dirname, '..', 'test-results', 'e2e-registry', 'jest');
  await cleanupRegisteredCustomers(registryDir, 'jest');
};

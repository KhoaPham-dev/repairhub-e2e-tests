import * as path from 'path';
import { cleanupRegisteredCustomers } from '../scripts/db-cleanup';

/**
 * Runs once after the whole Playwright run finishes. Deletes every customer
 * (and dependent orders/images/history/activity-log rows) recorded by
 * playwright/helpers/fixtures.ts's request-wrapping fixture, via
 * E2E_DATABASE_URL — see scripts/db-cleanup.js for the full explanation.
 */
export default async function globalTeardown(): Promise<void> {
  const registryDir = path.join(__dirname, '..', 'test-results', 'e2e-registry', 'playwright');
  await cleanupRegisteredCustomers(registryDir, 'playwright');
}

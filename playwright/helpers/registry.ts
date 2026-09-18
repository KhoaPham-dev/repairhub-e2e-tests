/**
 * Append-only "customers created by this test run" registry for the
 * Playwright suite. One file per worker (Playwright runs spec files across
 * multiple parallel worker processes) so concurrent writers never corrupt
 * each other. Consumed by scripts/db-cleanup.js in global-teardown.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

const REGISTRY_DIR = path.join(__dirname, '..', '..', 'test-results', 'e2e-registry', 'playwright');

function registryFilePath(): string {
  const workerId = process.env.TEST_WORKER_INDEX ?? String(process.pid);
  return path.join(REGISTRY_DIR, `customers-${workerId}.jsonl`);
}

export function recordCustomerId(id: string): void {
  if (!id) return;
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.appendFileSync(registryFilePath(), JSON.stringify({ id, ts: Date.now() }) + '\n');
}

export { REGISTRY_DIR };

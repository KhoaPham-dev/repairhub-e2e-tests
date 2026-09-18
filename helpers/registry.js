/**
 * Append-only "customers created by this test run" registry for the jest
 * suite. One file per Jest worker so concurrent writers never corrupt each
 * other (jest --runInBand uses a single worker/process, but this stays safe
 * if that ever changes). Consumed by scripts/db-cleanup.js at teardown.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_DIR = path.join(__dirname, '..', 'test-results', 'e2e-registry', 'jest');

function registryFilePath() {
  const workerId = process.env.JEST_WORKER_ID || String(process.pid);
  return path.join(REGISTRY_DIR, `customers-${workerId}.jsonl`);
}

function recordCustomerId(id) {
  if (!id) return;
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.appendFileSync(registryFilePath(), JSON.stringify({ id, ts: Date.now() }) + '\n');
}

module.exports = { recordCustomerId, REGISTRY_DIR };

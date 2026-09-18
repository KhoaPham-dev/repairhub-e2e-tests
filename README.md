# RepairHub Phase 1 — E2E Test Suite

Fetch-based API integration tests covering all Phase 1 acceptance criteria (RH-2 through RH-9).

## Prerequisites

- Node.js 18+
- RepairHub backend running at `http://localhost:6061`
- PostgreSQL seeded via `npm run seed` in `repairhub-backend/`

## Setup

```bash
cd repos/code/repair-hub-e2e-tests
npm install
```

## Running Tests

```bash
# All test suites
npm test

# Individual suites
npm run test:auth       # TC-01 Authentication
npm run test:branches   # TC-02 Branch Management
npm run test:customers  # TC-03 Customer Management
npm run test:orders     # TC-04 Orders + Image Upload
npm run test:warranty   # TC-05 Warranty Lookup
npm run test:users      # TC-06 Users & RBAC
npm run test:backup     # TC-07 Backup & Restore
```

## Custom API URL

```bash
API_URL=http://your-server:6061/api npm test
```

## Database Cleanup (`E2E_DATABASE_URL`)

Every customer created via `POST /customers` during a run (jest or
Playwright) is recorded to an append-only registry under
`test-results/e2e-registry/`. If `E2E_DATABASE_URL` is set, a global
teardown connects directly to that database at the end of the run and, in
one transaction, deletes exactly those customers plus everything that
depends on them (their orders, those orders' `order_images` and
`order_status_history` rows, and any `activity_log` rows referencing them)
— never anything outside the registry. If the variable is not set, cleanup
is skipped (one log line noting this); test data from that run is left in
place, same as before this existed for customers that have orders (`DELETE
/customers/:id` now correctly 409s once a customer has any orders — see
`fix/customer-delete-with-orders` — so it can no longer be relied on for
that case).

```bash
# jest
E2E_DATABASE_URL=postgresql://user:pass@localhost:5432/repairhub npm test

# Playwright
E2E_DATABASE_URL=postgresql://user:pass@localhost:5432/repairhub npm run test:e2e
```

Use the same connection string as the backend's own `DATABASE_URL` (see
`repairhub-backend/.env`) when running against a local dev DB. See
`scripts/db-cleanup.js` for the exact delete order and `playwright/.env.example`
for where to set this for Playwright runs.

### Safety guard

Before running any DELETE, cleanup logs `[e2e-cleanup] target host=<host>
db=<dbname>` (never credentials) and only proceeds if the host is a
loopback address (`localhost`, `127.0.0.1`, `::1`) or this project's local
docker-compose Postgres service name (`postgres`/`db`), **or** the
database name matches `/test|e2e/i`. Otherwise it refuses — throwing an
error, deleting nothing, leaving the registry intact — which is the
expected outcome if `E2E_DATABASE_URL` ever ends up pointing at a
shared/staging/production database. To intentionally clean up a database
that doesn't match those rules, set `E2E_ALLOW_REMOTE_CLEANUP=1`. The
decision logic is a pure function (`isCleanupTargetAllowed` in
`scripts/db-cleanup.js`) with its own test coverage:

```bash
npm run test:cleanup-guard
```

## Test Structure

```
tests/                        Jest — API integration tests (npm test)
  01-auth.test.js               Login, JWT, session, SQL injection
  02-branches.test.js           Branch CRUD, soft-delete, RBAC
  03-customers.test.js          Customer CRUD, auto-suggest, search
  04-orders.test.js             Order creation, status workflow, images
  05-warranty.test.js           Warranty search by phone/serial/device
  06-users-rbac.test.js         User management, RBAC, activity log
  07-backup.test.js             Manual backup, download, restore, RBAC
  08-settings-auth-ux.test.js   Settings, auth edge cases, UX-facing fields
  09-revenue-reports.test.js    Revenue report generation & download
  10-partner-report.test.js     Partner (PARTNER customer) report export
  12-dashboard-revenue-month.test.js  Dashboard revenue widget
  global-teardown.js            DB cleanup (see "Database Cleanup" above)

fixtures/
  test-data.js                Vietnamese test data generators

helpers/
  api.js                      HTTP client, auth helpers, FormData utils
  registry.js                 Records created customers for DB cleanup

playwright/                   Playwright — UI + API E2E tests (npm run test:e2e)
  NN-*.spec.ts                 One spec file per feature/regression
  helpers/                     auth.ts, ids.ts, images.ts, fixtures.ts, registry.ts
  global-teardown.ts           DB cleanup (see "Database Cleanup" above)

scripts/
  db-cleanup.js                Shared DB teardown logic (jest + Playwright)
```

## Seed Credentials

- Admin: `admin` / `admin123`
- Technician: `technician` / `tech123`

## Notes

- Tests run in-band (`--runInBand`) to avoid race conditions with shared DB state.
- Each test suite creates its own fixtures; real cleanup happens via the DB
  teardown described above (`E2E_DATABASE_URL`) rather than per-test API calls.
- The order status workflow test is sequential within the suite.
- Image upload uses a minimal 1×1 PNG buffer — no external files needed.

# RepairHub Phase 1 — E2E Test Suite

Fetch-based API integration tests covering all Phase 1 acceptance criteria (RH-2 through RH-9).

## Prerequisites

- Node.js 18+
- RepairHub backend running at `http://localhost:3001`
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
API_URL=http://your-server:3001/api npm test
```

## Test Structure

```
tests/
  01-auth.test.js        Login, JWT, session, SQL injection
  02-branches.test.js    Branch CRUD, soft-delete, RBAC
  03-customers.test.js   Customer CRUD, auto-suggest, search
  04-orders.test.js      Order creation, 9-step workflow, images
  05-warranty.test.js    Warranty search by phone/serial/device
  06-users-rbac.test.js  User management, RBAC, activity log
  07-backup.test.js      Manual backup, download, restore, RBAC

fixtures/
  test-data.js           Vietnamese test data generators

helpers/
  api.js                 HTTP client, auth helpers, FormData utils
```

## Seed Credentials

- Admin: `admin` / `admin123`
- Technician: `technician` / `tech123`

## Notes

- Tests run in-band (`--runInBand`) to avoid race conditions with shared DB state.
- Each test suite creates and cleans up its own fixtures where possible.
- The 9-step workflow test is sequential within the suite.
- Image upload uses a minimal 1×1 PNG buffer — no external files needed.

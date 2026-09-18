import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config({ path: './playwright/.env' });

export default defineConfig({
  testDir: './playwright',
  globalTeardown: require.resolve('./playwright/global-teardown'),
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:6060',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Scoped to 24-pending-media-preview.spec.ts only (via testMatch) so the
    // rest of the suite doesn't run twice — this project exists to cover
    // WebKit + a real touch/tap device (iPhone 15) for that spec's mobile
    // tap-target assertions.
    {
      name: 'webkit-iphone15',
      use: { ...devices['iPhone 15'], browserName: 'webkit' },
      testMatch: /24-pending-media-preview\.spec\.ts/,
    },
  ],
});

import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config({ path: './playwright/.env' });

export default defineConfig({
  testDir: './playwright',
  globalTeardown: require.resolve('./playwright/global-teardown'),
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:6060',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

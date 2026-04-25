import type { Page } from '@playwright/test';

export const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin123';

/**
 * Log in through the RepairHub UI.
 * After this call the page is redirected away from /login (i.e. on the dashboard).
 */
export async function loginViaUI(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('Nhập tên đăng nhập').fill(ADMIN_USER);
  await page.getByPlaceholder('Nhập mật khẩu').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /Đăng nhập/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
}

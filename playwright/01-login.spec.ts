/**
 * PW-01 — Login / Logout (RH-16)
 *
 * Covers:
 *   - Navigate to /login → login form rendered
 *   - Submit valid admin credentials → redirect to dashboard (/)
 *   - Dashboard shows authenticated content (user greeting / status cards)
 *   - Logout via clearAuth removes token → redirect back to /login
 *   - Invalid credentials → error message shown, no redirect
 *
 * Prerequisites: frontend running at http://localhost:3000
 *                backend running at http://localhost:3001
 */

import { test, expect } from '@playwright/test';
import { loginViaUI, ADMIN_USER } from './helpers/auth';

test.describe('PW-01 Login / Logout', () => {
  test('login page renders form elements', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByPlaceholder('Nhập tên đăng nhập')).toBeVisible();
    await expect(page.getByPlaceholder('Nhập mật khẩu')).toBeVisible();
    await expect(page.getByRole('button', { name: /Đăng nhập/i })).toBeVisible();
    // Brand heading
    await expect(page.getByText('RepairHub')).toBeVisible();
  });

  test('valid admin credentials redirect to dashboard', async ({ page }) => {
    await loginViaUI(page);
    // After login we should be at the root dashboard, not /login
    expect(page.url()).not.toContain('/login');
    // Dashboard should show status counts section (heading)
    await expect(page.getByRole('heading', { name: 'Tổng quan' })).toBeVisible();
  });

  test('dashboard shows authenticated content after login', async ({ page }) => {
    await loginViaUI(page);
    // "Đang xử lý" KPI card is always present (count may be 0)
    await expect(page.getByText('Đang xử lý')).toBeVisible();
    // Greeting line contains "Xin chào"
    await expect(page.getByText(/Xin chào/i)).toBeVisible();
  });

  test('logout clears session and redirects to /login', async ({ page }) => {
    await loginViaUI(page);
    // Perform logout by clearing localStorage (mirrors clearAuth() in lib/auth.ts)
    await page.evaluate(() => {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    });
    // Navigate to a protected page — AuthGuard should redirect to /login.
    // Use waitUntil:'commit' to tolerate the Next.js client-side redirect that
    // can cause net::ERR_ABORTED when navigating to a guarded route without a token.
    await page.goto('/orders', { waitUntil: 'commit' }).catch(() => null);
    await page.waitForURL(/\/login/, { timeout: 8_000 });
    await expect(page.getByPlaceholder('Nhập tên đăng nhập')).toBeVisible();
  });

  test('invalid password shows error message and stays on /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Nhập tên đăng nhập').fill(ADMIN_USER);
    await page.getByPlaceholder('Nhập mật khẩu').fill('wrongpassword');
    await page.getByRole('button', { name: /Đăng nhập/i }).click();
    // Error message should appear; URL must remain /login
    await expect(page.locator('p.text-red-500')).toBeVisible({ timeout: 8_000 });
    expect(page.url()).toContain('/login');
  });

  test('unauthenticated access to /orders redirects to /login', async ({ page }) => {
    // Clear any stale session state
    await page.goto('/login');
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto('/orders');
    await page.waitForURL(/\/login/, { timeout: 8_000 });
    await expect(page.getByPlaceholder('Nhập tên đăng nhập')).toBeVisible();
  });
});

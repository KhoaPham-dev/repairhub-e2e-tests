/**
 * PW-06 — Dashboard / Overview Page
 *
 * Covers:
 *   - Page heading "Tổng quan" and greeting "Xin chào" are visible after login
 *   - 4 KPI cards: "Đang xử lý", "Đơn hoàn tất", "Tiếp nhận", "Đơn huỷ"
 *   - Default active period filter is "Hôm nay"
 *   - KPI values are numeric (not null/undefined)
 *   - Clicking "Tuần này" activates that filter button
 *   - Clicking "Tháng này" activates that filter button
 *   - Revenue chart heading "Biểu đồ doanh thu" is visible
 *
 * Prerequisites: frontend running at http://localhost:6060
 *                backend running at http://localhost:6061
 */

import { test, expect } from '@playwright/test';
import { loginViaUI } from './helpers/auth';

test.describe('PW-06 Dashboard Overview', () => {
  test('TC-01: dashboard renders heading, greeting, and all 4 KPI card labels', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/');

    // Page heading
    await expect(page.getByRole('heading', { name: 'Tổng quan' })).toBeVisible({ timeout: 10_000 });

    // Greeting starts with "Xin chào"
    await expect(page.getByText(/Xin chào/)).toBeVisible();

    // All 4 KPI card labels
    await expect(page.getByText('Đang xử lý')).toBeVisible();
    await expect(page.getByText('Đơn hoàn tất')).toBeVisible();
    await expect(page.getByText('Tiếp nhận').first()).toBeVisible();
    await expect(page.getByText('Đơn huỷ')).toBeVisible();
  });

  test('TC-02: "Hôm nay" is the default active filter and KPI values are visible numbers', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/');

    // "Hôm nay" button should be active (bg-[#004EAB] text-white from SegmentedControl)
    const homNayBtn = page.getByRole('button', { name: 'Hôm nay' });
    await expect(homNayBtn).toBeVisible({ timeout: 10_000 });
    await expect(homNayBtn).toHaveClass(/bg-\[#004EAB\]/);
    await expect(homNayBtn).toHaveClass(/text-white/);

    // KPI values are rendered as text — they should be numeric strings (including 0)
    // Each KPI card has a <p> with a bold number immediately after the label
    // We assert the cards exist and contain a text node that parses as a number
    const kpiCards = page.locator('div.bg-white.rounded-2xl');
    const count = await kpiCards.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // Check that none of the KPI value elements contain "undefined" or "null"
    const kpiValues = page.locator('p.text-2xl.font-bold');
    const valuesCount = await kpiValues.count();
    expect(valuesCount).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < valuesCount; i++) {
      const text = await kpiValues.nth(i).textContent();
      expect(text).not.toBeNull();
      expect(text?.trim()).not.toBe('undefined');
      expect(text?.trim()).not.toBe('null');
      // Value should be a non-negative integer string
      expect(Number(text?.trim())).toBeGreaterThanOrEqual(0);
    }
  });

  test('TC-03: clicking "Tuần này" changes the active button styling', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/');

    const tuanNayBtn = page.getByRole('button', { name: 'Tuần này' });
    await expect(tuanNayBtn).toBeVisible({ timeout: 10_000 });

    // Initially "Tuần này" should NOT be active
    await expect(tuanNayBtn).not.toHaveClass(/bg-\[#004EAB\]/);

    await tuanNayBtn.click();

    // After click it becomes active
    await expect(tuanNayBtn).toHaveClass(/bg-\[#004EAB\]/, { timeout: 4_000 });
    await expect(tuanNayBtn).toHaveClass(/text-white/);

    // "Hôm nay" should no longer be active
    await expect(page.getByRole('button', { name: 'Hôm nay' })).not.toHaveClass(/bg-\[#004EAB\]/);
  });

  test('TC-04: clicking "Tháng này" changes the active button styling', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/');

    const thangNayBtn = page.getByRole('button', { name: 'Tháng này' });
    await expect(thangNayBtn).toBeVisible({ timeout: 10_000 });

    // Initially "Tháng này" should NOT be active
    await expect(thangNayBtn).not.toHaveClass(/bg-\[#004EAB\]/);

    await thangNayBtn.click();

    // After click it becomes active
    await expect(thangNayBtn).toHaveClass(/bg-\[#004EAB\]/, { timeout: 4_000 });
    await expect(thangNayBtn).toHaveClass(/text-white/);

    // "Hôm nay" should no longer be active
    await expect(page.getByRole('button', { name: 'Hôm nay' })).not.toHaveClass(/bg-\[#004EAB\]/);
  });

  test('TC-05: revenue chart heading "Biểu đồ doanh thu" is visible', async ({ page }) => {
    await loginViaUI(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Biểu đồ doanh thu' })).toBeVisible({ timeout: 10_000 });
  });
});

/**
 * PW-24 — Pending (not-yet-uploaded) media previews are tappable
 * (feat/pending-media-preview)
 *
 * Before this change, a picked-but-not-yet-saved photo/video thumbnail
 * could only be removed — tapping the thumbnail itself did nothing, even
 * though the video preview showed a play icon suggesting it was tappable.
 * `PendingMediaGrid` now wraps every pending thumbnail's media area in a
 * button ("Xem ảnh" / "Xem video") that opens the existing ImageLightbox
 * (yet-another-react-lightbox, `.yarl__root`) at that file:
 *   - photos render via the library's default <img> slide;
 *   - videos render via the custom slide as <video controls>;
 *   - there is NO download button — pending files have nothing saved to
 *     download yet (ImageLightbox is opened with showDownload={false}).
 * The remove ("Xoá ảnh" / "Xoá video") button is a sibling of the "open
 * viewer" button (not nested inside it), so removing a file never also
 * opens the viewer.
 *
 * Also covers review fixes (frontend a00d250) on top of the same change:
 *   - the object-URL lifecycle is StrictMode-safe (recreated whenever
 *     `files` changes, no shared mutable state between setup/cleanup);
 *   - the lightbox closes itself if its open index no longer exists in
 *     `files` (e.g. the shown file was removed);
 *   - the SAVED-gallery video thumbnail (already-uploaded files, a
 *     different grid from the pending one above) also got
 *     pointer-events: none on its `<video>`, for the same iOS
 *     Safari tap-swallow reason as the pending thumbnail.
 *
 * This is mostly a frontend-only change — TC-03 is the one case that
 * involves the backend, since it needs a real saved (already-uploaded)
 * video to open from the gallery rather than a pending in-memory File.
 *
 * Test cases:
 *   TC-01: order detail evidence picker — pick a photo + the MP4, tap
 *          "Xem ảnh" (viewer opens on the image), navigate to the video
 *          slide (still <video controls>, no Download button), close, then
 *          tap "Xoá video" and confirm the file is removed WITHOUT opening
 *          the viewer.
 *   TC-02: new-order product picker — pick the MP4, tap "Xem video", the
 *          viewer opens showing <video controls>.
 *   TC-03: order detail SAVED gallery — a video already uploaded as
 *          COMPLETION (via the API) — tapping its thumbnail opens the
 *          lightbox with <video controls>.
 *
 * Runs on two projects (see playwright.config.ts):
 *   - chromium (desktop, mouse clicks)
 *   - webkit-iphone15 (devices['iPhone 15'], real touch taps) — scoped to
 *     this spec file only via testMatch.
 *
 * Playback itself is NOT asserted (the bundled test browsers lack H.264
 * decoders) — only that the <video controls> element is visible with the
 * expected attributes.
 *
 * Prerequisites: backend running at http://localhost:6061
 *                frontend running at http://localhost:6060
 */

import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import type { Locator, TestInfo } from '@playwright/test';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { uniqueNow } from './helpers/ids';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);
const MP4_FIXTURE = FIXT('tiny.mp4');
const MP4_BUFFER = fs.readFileSync(MP4_FIXTURE);
const PHOTO_FIXTURE = FIXT('img-a1.jpg');

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return (await res.json()).data.token as string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<{ orderId: string; customerId: string }> {
  const runId = uniqueNow();
  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone: `097${runId.slice(-7)}`, name: `Khách PW-24 ${runId}`, type: 'RETAIL' },
  });
  const customerId = (await cRes.json()).data.id as string;
  const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: 'SPEAKER',
      device_name: `Loa PW-24-${runId}`,
      fault_description: 'E2E pending-media-preview test',
      quotation: 0,
    },
  });
  const orderId = (await oRes.json()).data.id as string;
  return { orderId, customerId };
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
}

/** Uploads the MP4 fixture to an order's SAVED gallery (not a pending
 * preview) via the same API route the UI itself uses. */
async function uploadSavedVideo(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  orderId: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { image_type: 'COMPLETION', images: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER } },
  });
  if (!res.ok()) {
    throw new Error(`Failed to upload saved video for order ${orderId}: ${res.status()}`);
  }
}

/**
 * Real touch tap on the touch-emulated mobile project (webkit-iphone15);
 * a plain click everywhere else. Desktop Chromium has no touch emulation
 * enabled, so Locator.tap() would throw ("hasTouch" must be enabled).
 */
async function activate(locator: Locator, testInfo: TestInfo): Promise<void> {
  if (testInfo.project.use?.hasTouch) {
    await locator.tap();
  } else {
    await locator.click();
  }
}

test.describe('PW-24 Pending media preview — tap-to-view before upload', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-01: order detail — pending photo + video previews open the lightbox; remove does not', async ({ page, request }, testInfo) => {
    const { orderId, customerId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // Pick a photo and the MP4 in one go — index 0 = photo, index 1 = video.
    await page.locator('input[type="file"]').setInputFiles([PHOTO_FIXTURE, MP4_FIXTURE]);
    await expect(page.getByText('Đã chọn 2 ảnh — chạm để thêm')).toBeVisible({ timeout: 5_000 });

    const viewPhoto = page.getByRole('button', { name: 'Xem ảnh' });
    const viewVideo = page.getByRole('button', { name: 'Xem video' });
    await expect(viewPhoto).toBeVisible();
    await expect(viewVideo).toBeVisible();

    // Tap the photo thumbnail — the viewer opens showing the image.
    await activate(viewPhoto, testInfo);
    const lightboxRoot = page.locator('.yarl__root');
    await expect(lightboxRoot).toBeVisible({ timeout: 5_000 });
    await expect(lightboxRoot.locator('img').first()).toBeVisible();

    // Pending previews have nothing saved to download yet — no Download button.
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);

    // Navigate to the next slide (the video) instead of re-tapping the thumbnail.
    await activate(page.getByRole('button', { name: 'Next' }), testInfo);
    const lightboxVideo = lightboxRoot.locator('video[controls]');
    await expect(lightboxVideo).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);

    // Close the viewer.
    await activate(page.getByRole('button', { name: 'Close' }), testInfo);
    await expect(lightboxRoot).toHaveCount(0);

    // Removing the video must NOT open the viewer (the ✕ button is a
    // sibling of the "open viewer" button, never nested inside it).
    await activate(page.getByRole('button', { name: 'Xoá video' }), testInfo);
    await expect(lightboxRoot).toHaveCount(0);
    await expect(page.getByText('Đã chọn 1 ảnh — chạm để thêm')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Xem video' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Xem ảnh' })).toBeVisible();

    await cleanup(token, request, customerId);
  });

  test('TC-02: new-order product picker — pending video preview opens the lightbox', async ({ page }, testInfo) => {
    await loginViaUI(page);
    await page.goto('/orders/new');

    // Default product row is product_type SPEAKER — the device/fault/images
    // fields render immediately, no customer or branch selection needed
    // since this test never submits the order.
    await page.locator('input[type="file"]').first().setInputFiles(MP4_FIXTURE);
    await expect(page.getByText('Đã chọn 1 ảnh/video — chạm để thêm')).toBeVisible({ timeout: 5_000 });

    const viewVideo = page.getByRole('button', { name: 'Xem video' });
    await expect(viewVideo).toBeVisible();
    await activate(viewVideo, testInfo);

    const lightboxRoot = page.locator('.yarl__root');
    await expect(lightboxRoot).toBeVisible({ timeout: 5_000 });
    const lightboxVideo = lightboxRoot.locator('video[controls]');
    await expect(lightboxVideo).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
  });

  test('TC-03: order detail — saved-gallery video thumbnail opens the lightbox with <video controls>', async ({ page, request }, testInfo) => {
    const { orderId, customerId } = await seedOrder(token, request);
    await uploadSavedVideo(token, request, orderId);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    // The saved-gallery thumbnail (a different grid from the pending
    // previews above — already-uploaded files) has its own aria-label.
    const viewSavedVideo = page.getByRole('button', { name: 'Mở video đầy đủ' });
    await expect(viewSavedVideo).toBeVisible({ timeout: 10_000 });
    await activate(viewSavedVideo, testInfo);

    const lightboxRoot = page.locator('.yarl__root');
    await expect(lightboxRoot).toBeVisible({ timeout: 5_000 });
    const lightboxVideo = lightboxRoot.locator('video[controls]');
    await expect(lightboxVideo).toBeVisible({ timeout: 5_000 });

    await cleanup(token, request, customerId);
  });
});

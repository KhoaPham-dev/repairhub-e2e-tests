/**
 * PW-25 — Upload content detection (fix/upload-content-detection)
 *
 * Bug: a real user got "Nội dung tệp không khớp định dạng" creating an
 * order with real phone photos and a video. Browsers set Content-Type from
 * the file EXTENSION, not its content — a PNG/WebP/HEIC saved as ".jpg" by
 * a messaging app, or a legacy QuickTime .mov with no leading ftyp box, are
 * both common and were both rejected as a "mismatch" against the declared
 * (extension-derived) mimetype.
 *
 * The backend now detects the real format from the file's CONTENT alone
 * (magic bytes / ISO-BMFF box structure) and accepts it whenever the
 * detected kind is one of the allowed types — regardless of what the
 * declared mimetype or extension said:
 *   - a PNG named .jpg is renamed and stored as .png;
 *   - a WebP named .jpg is renamed and stored as .webp;
 *   - a HEIC named .jpg is converted (as HEIC always is) and stored as .jpg;
 *   - a legacy QuickTime .mov with no ftyp box (first top-level atom is
 *     wide/mdat/moov/free/skip/pnot instead) is accepted as video/quicktime
 *     — but ONLY once isLegacyQuickTimeFile (backend 0ba0609) has walked up
 *     to 4 real top-level atoms on disk and found a structurally valid moov
 *     or mdat among them; a bare atom-name match at bytes 4-8 with garbage
 *     after it (e.g. a "wide" header over HTML) is NOT enough on its own —
 *     see TC-WIDE-SPOOF.
 * AVIF is still rejected (it shares HEIC's ISO-BMFF brand family but isn't
 * an allowed type) — as are HTML/SVG/PDF/etc. The rejection message now
 * echoes the sanitised original filename: "Nội dung tệp không khớp định
 * dạng: <name>", so the user can tell which file was rejected. Every
 * accepted upload is served with X-Content-Type-Options: nosniff.
 * The 10MB image-size limit applies by the DETECTED kind, not the declared one.
 *
 * Fixture generation (all real, tiny, committed — see git log for exact
 * commands): photo-png.jpg is a real 16x16 PNG (ffmpeg) renamed to .jpg;
 * photo-webp.jpg is a real WebP (cwebp) renamed to .jpg; photo-heic.jpg is
 * a real HEIC (macOS `sips -s format heic`) renamed to .jpg; clip.mov is a
 * real ffmpeg `-f mov` file (ftyp major brand "qt  "); clip-legacy-wide.mov
 * is the same real mov with an 8-byte synthetic "wide" box (00 00 00 08
 * "wide") prepended, so its first top-level atom (bytes 4-8) reads "wide"
 * instead of "ftyp" — verified with `xxd`; photo.avif is a real AVIF
 * (ffmpeg + libsvtav1, `-f avif`).
 *
 * Test cases:
 *   API (looped across both POST /:id/images and POST /bulk-with-images;
 *   each accepted upload also checked for X-Content-Type-Options: nosniff):
 *     - photo-png.jpg accepted, stored as .png, served with Content-Type image/png
 *     - photo-webp.jpg accepted, stored as .webp, served with Content-Type image/webp
 *     - photo-heic.jpg accepted, converted, stored as .jpg, served with Content-Type image/jpeg
 *     - clip.mov accepted, stored as .mov, served with Content-Type video/quicktime
 *     - clip-legacy-wide.mov accepted, stored as .mov, served with Content-Type video/quicktime
 *   TC-AVIF: a real AVIF is rejected with 400 (unallowed content, even
 *            though it shares HEIC's ISO-BMFF brand family)
 *   TC-HTML: HTML content named "note.mp4" is rejected with 400, and the
 *            message contains the filename
 *   TC-WIDE-SPOOF: `00 00 00 08 "wide"` followed by HTML, named "evil.mov"
 *            → 400 with the filename in the message, uploads dir keeps
 *            nothing — the atom-name match alone must not be enough
 *   UI:
 *     TC-UI: the user's exact scenario — new-order page, PNG-renamed-.jpg
 *            photo + the legacy .mov together → order created
 *            successfully, order detail shows both (an <img> and a <video>)
 *
 * Prerequisites: backend running at http://localhost:6061
 *                frontend running at http://localhost:6060
 */

import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { uniqueNow } from './helpers/ids';
import { watchUploads, findSurvivingUploads, sha256Hex } from './helpers/uploads';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const API_ORIGIN = API_BASE.replace(/\/api$/, '');
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

const CONTENT_MISMATCH_MSG = 'Nội dung tệp không khớp định dạng';

interface ContentFixture {
  /** Fixture filename, ALREADY carrying the "wrong" (extension-derived) name. */
  file: string;
  /** What a real browser would declare for this filename (by extension). */
  declaredMime: string;
  /** Extension the file must be stored under, once the server has looked at its content. */
  expectedExt: string;
  /** Content-Type GET /uploads/<path> must serve it with. */
  expectedContentType: string;
}

const CONTENT_FIXTURES: ContentFixture[] = [
  { file: 'photo-png.jpg', declaredMime: 'image/jpeg', expectedExt: '.png', expectedContentType: 'image/png' },
  { file: 'photo-webp.jpg', declaredMime: 'image/jpeg', expectedExt: '.webp', expectedContentType: 'image/webp' },
  { file: 'photo-heic.jpg', declaredMime: 'image/jpeg', expectedExt: '.jpg', expectedContentType: 'image/jpeg' },
  { file: 'clip.mov', declaredMime: 'video/quicktime', expectedExt: '.mov', expectedContentType: 'video/quicktime' },
  { file: 'clip-legacy-wide.mov', declaredMime: 'video/quicktime', expectedExt: '.mov', expectedContentType: 'video/quicktime' },
];

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return (await res.json()).data.token as string;
}

interface SeedResult {
  orderId: string;
  customerId: string;
  branchId: string;
  phone: string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<SeedResult> {
  const runId = uniqueNow();
  const phone = `096${runId.slice(-7)}`;
  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone, name: `Khách PW-25 ${runId}`, type: 'RETAIL' },
  });
  const customerId = (await cRes.json()).data.id as string;
  const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: 'SPEAKER',
      device_name: `Loa PW-25-${runId}`,
      fault_description: 'E2E upload-content-detection test',
      quotation: 0,
    },
  });
  const orderId = (await oRes.json()).data.id as string;
  return { orderId, customerId, branchId, phone };
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
}

async function uploadImage(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  orderId: string,
  fixture: { file: string; declaredMime: string },
) {
  return request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      image_type: 'INTAKE',
      images: { name: fixture.file, mimeType: fixture.declaredMime, buffer: fs.readFileSync(FIXT(fixture.file)) },
    },
  });
}

async function uploadBulk(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
  branchId: string,
  deviceName: string,
  fixture: { file: string; declaredMime: string },
) {
  return request.post(`${API_BASE}/orders/bulk-with-images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      payload: JSON.stringify({
        customer_id: customerId,
        branch_id: branchId,
        products: [{ product_type: 'SPEAKER', device_name: deviceName, fault_description: 'content detection test' }],
      }),
      images_0: { name: fixture.file, mimeType: fixture.declaredMime, buffer: fs.readFileSync(FIXT(fixture.file)) },
    },
  });
}

async function assertServedWithContentType(
  request: import('@playwright/test').APIRequestContext,
  storedPath: string,
  expectedContentType: string,
): Promise<void> {
  const res = await request.get(`${API_ORIGIN}/uploads/${storedPath}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain(expectedContentType);
  // Every /uploads response — not just video — carries the MIME-sniffing
  // guard (see 23-video-uploads.spec.ts TC-15); checked here too so every
  // accepted upload in this spec (all 5 content-detection fixtures, across
  // both routes) is covered, not just one hand-picked case.
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
}

test.describe('PW-25 API — real content is detected regardless of declared mimetype/extension', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  for (const fixture of CONTENT_FIXTURES) {
    test(`POST /:id/images — ${fixture.file} is accepted and stored as ${fixture.expectedExt}`, async ({ request }) => {
      const { orderId, customerId } = await seedOrder(token, request);

      const res = await uploadImage(token, request, orderId, fixture);
      expect(res.status(), await res.text()).toBe(201);
      const body = await res.json();
      const storedPath: string = body.data[0].image_path;
      expect(storedPath, `stored path for ${fixture.file}`).toMatch(new RegExp(`\\${fixture.expectedExt}$`));

      await assertServedWithContentType(request, storedPath, fixture.expectedContentType);

      await cleanup(token, request, customerId);
    });

    test(`POST /bulk-with-images — ${fixture.file} is accepted and stored as ${fixture.expectedExt}`, async ({ request }) => {
      const { customerId, branchId } = await seedOrder(token, request);
      const runId = uniqueNow();
      const deviceName = `Loa PW-25-BULK-${runId}`;

      const res = await uploadBulk(token, request, customerId, branchId, deviceName, fixture);
      expect(res.status(), await res.text()).toBe(201);

      const custRes = await request.get(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } });
      const orders = (await custRes.json()).data.orders as Array<{ id: string; device_name: string }>;
      const order = orders.find((o) => o.device_name === deviceName);
      expect(order, 'order created').toBeTruthy();

      const detailRes = await request.get(`${API_BASE}/orders/${order!.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const images = (await detailRes.json()).data.images as Array<{ image_path: string }>;
      expect(images.length).toBe(1);
      const storedPath = images[0].image_path;
      expect(storedPath, `stored path for ${fixture.file}`).toMatch(new RegExp(`\\${fixture.expectedExt}$`));

      await assertServedWithContentType(request, storedPath, fixture.expectedContentType);

      await cleanup(token, request, customerId);
    });
  }

  test('TC-AVIF: a real AVIF is rejected with 400 even though it shares HEIC\'s ISO-BMFF brand family', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    const res = await uploadImage(token, request, orderId, { file: 'photo.avif', declaredMime: 'image/heic' });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(`${CONTENT_MISMATCH_MSG}: photo.avif`);

    await cleanup(token, request, customerId);
  });

  test('TC-HTML: HTML content named note.mp4 is rejected with 400, message contains the filename', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        image_type: 'INTAKE',
        images: { name: 'note.mp4', mimeType: 'video/mp4', buffer: Buffer.from('<!DOCTYPE html><html><body>hi</body></html>') },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(CONTENT_MISMATCH_MSG);
    expect(body.error).toContain('note.mp4');

    await cleanup(token, request, customerId);
  });

  test('TC-WIDE-SPOOF: a bare "wide" atom name over HTML content is rejected, not waved through as legacy QuickTime', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    // Exactly the spoofing shape the hardened legacy-QuickTime detection
    // (isLegacyQuickTimeFile, backend 0ba0609) exists to reject: bytes 4-8
    // spell a recognized atom name ("wide") with a declared size of 8 (i.e.
    // no payload — the header IS the whole atom), but what follows isn't a
    // real QuickTime atom structure containing moov/mdat at all — it's HTML.
    const evil = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x08]),
      Buffer.from('wide', 'ascii'),
      Buffer.from('<!DOCTYPE html><html><body>evil</body></html>', 'ascii'),
    ]);
    const watch = watchUploads();
    const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        image_type: 'INTAKE',
        images: { name: 'evil.mov', mimeType: 'video/quicktime', buffer: evil },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(`${CONTENT_MISMATCH_MSG}: evil.mov`);

    const survivors = findSurvivingUploads(watch, [{ size: evil.length, sha256: sha256Hex(evil) }]);
    expect(survivors, 'uploads dir must not keep a rejected wide-atom-spoofed file').toEqual([]);

    await cleanup(token, request, customerId);
  });
});

test.describe('PW-25 UI — the user\'s exact scenario: PNG-renamed-.jpg photo + a legacy .mov together', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-UI: creating an order with both files succeeds and the order detail shows both', async ({ page, request }) => {
    const runId = uniqueNow();
    const phone = `095${runId.slice(-7)}`;
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone, name: `Khách PW-25-UI ${runId}`, type: 'RETAIL' },
    });
    const customerId = (await cRes.json()).data.id as string;
    const deviceName = `Loa PW-25-UI-${runId}`;

    await loginViaUI(page);
    await page.goto('/orders/new');

    await page.locator('div.bg-surface', { hasText: 'Nơi nhập hàng' }).getByRole('button').first().click();
    await page.getByPlaceholder('Số điện thoại *').fill(phone);
    const suggestion = page.getByRole('button', { name: new RegExp(phone) });
    await expect(suggestion).toBeVisible({ timeout: 8_000 });
    await suggestion.click();

    await page.getByPlaceholder('Tên thiết bị *').first().fill(deviceName);
    await page.getByPlaceholder('Mô tả lỗi *').first().fill('Ảnh và video thật từ điện thoại');

    // The user's exact scenario: a real PNG saved as .jpg, plus a legacy
    // QuickTime .mov with no ftyp box — both with real-browser-typical
    // (extension-derived) File.type values, since Playwright infers the
    // MIME type from the file's extension when given a real path.
    await page.locator('input[type="file"]').first().setInputFiles([FIXT('photo-png.jpg'), FIXT('clip-legacy-wide.mov')]);
    await expect(page.getByText('Đã chọn 2 ảnh/video — chạm để thêm')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Tạo đơn hàng' }).click();
    await page.waitForURL('**/orders', { timeout: 15_000 });

    const custRes = await request.get(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } });
    const orders = (await custRes.json()).data.orders as Array<{ id: string; device_name: string }>;
    const order = orders.find((o) => o.device_name === deviceName);
    expect(order, 'order created despite the mismatched extensions').toBeTruthy();

    const detailRes = await request.get(`${API_BASE}/orders/${order!.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const images = (await detailRes.json()).data.images as Array<{ image_path: string }>;
    expect(images.length).toBe(2);
    expect(images.some((i) => i.image_path.endsWith('.png'))).toBe(true);
    expect(images.some((i) => i.image_path.endsWith('.mov'))).toBe(true);

    // Order detail page shows both — an <img> for the photo, a <video> for the clip.
    await page.goto(`/orders/${order!.id}`);
    await expect(page.getByText('Ảnh đã lưu (2)')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('img[alt="INTAKE"]')).toBeVisible();
    await expect(page.locator('video')).toBeVisible();

    await cleanup(token, request, customerId);
  });
});

/**
 * PW-23 — Video uploads alongside photos (feat/video-uploads)
 *
 * Covers the new behaviour on all three order media endpoints
 * (POST /orders/:id/images, POST /orders/bulk-with-images,
 * POST /orders/warranty-claim):
 *   - Accepted video types: video/mp4, video/quicktime (.mov), video/webm,
 *     up to 100MB; images stay capped at 10MB. Wrong types → 400
 *     "Định dạng tệp không hợp lệ". An oversized IMAGE → 400 "Ảnh quá lớn
 *     (tối đa 10MB mỗi ảnh)" with every file from the request deleted. A
 *     file over the single multer-wide 100MB limit → the LIMIT_FILE_SIZE
 *     error "Tệp quá lớn (ảnh tối đa 10MB, video tối đa 100MB)".
 *   - Stored extension is derived from the verified mimetype (.mp4/.mov/
 *     .webm), never the client filename. Files are served from /uploads
 *     with Range support (206 Partial Content), and always carry
 *     X-Content-Type-Options: nosniff.
 *   - A COMPLETION video satisfies the DA_GIAO/HUY_TRA_MAY evidence rule
 *     the same as a photo; the photo-guidance message now mentions video.
 *   - Declared mimetype is verified against the file's magic bytes. A
 *     mismatch → 400 "Nội dung tệp không khớp định dạng", every file from
 *     the request deleted. The SIZE rule is checked (over all files) before
 *     the SIGNATURE rule, so an oversized file always reports the size
 *     message regardless of its own content.
 *   - Per-request file-count caps: 20 on POST /:id/images, 50 on
 *     /bulk-with-images, 10 on /warranty-claim. Going over → 400 "Quá
 *     nhiều tệp trong một lần tải lên", sibling files cleaned up.
 *   - POST /warranty-claim validates files BEFORE any database write and
 *     runs in a transaction — a rejected upload creates no BAO_HANH order.
 *
 * Test cases:
 *   API:
 *     TC-01: MP4 via POST /:id/images → 201, path ends .mp4, Range GET → 206
 *     TC-02: MP4 via POST /bulk-with-images → 201, stored path ends .mp4
 *     TC-03: MP4 via POST /warranty-claim → 201, stored path ends .mp4
 *     TC-04: MOV (video/quicktime) accepted
 *     TC-05: WebM (video/webm) accepted
 *     TC-06: AVI (video/x-msvideo) → 400
 *     TC-07: PDF (application/pdf) → 400
 *     TC-08: 11MB image → 400, uploads dir file count unchanged
 *     TC-09: 101MB video → rejected (LIMIT_FILE_SIZE), uploads dir file
 *            count unchanged
 *     TC-10: mixed request (valid video + oversized image) → 400, no
 *            order_images rows and no new files
 *     TC-11: COMPLETION video + notes → DA_GIAO transition succeeds (200)
 *     TC-12: HTML declared as video/mp4 → 400 content-mismatch
 *     TC-13: warranty-claim with an oversized/mismatched file → 400, no
 *            new BAO_HANH order created for the source
 *     TC-14: 21 files to POST /:id/images → 400 cap message, no files
 *            left behind on disk
 *     TC-15: a successful /uploads/<path> response carries
 *            X-Content-Type-Options: nosniff
 *
 *   UI:
 *     TC-16: attach the MP4 on order detail and save — gallery shows a
 *            <video> thumbnail; opening it shows <video controls>
 *     TC-17: a wrong-type file shows the client-side error
 *     TC-18: evidence flow with a video instead of a photo — note shown,
 *            Save enabled only once notes + video are both present
 *     TC-19: picking 21 files at once on order detail shows the client
 *            cap message "... (tối đa 20)"
 *
 * Prerequisites: backend running at http://localhost:6061
 *                frontend running at http://localhost:6060
 */

import { test, expect } from './helpers/fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { loginViaUI, ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { uniqueNow } from './helpers/ids';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const API_ORIGIN = API_BASE.replace(/\/api$/, '');
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);
const MP4_FIXTURE = FIXT('tiny.mp4');
const MP4_BUFFER = fs.readFileSync(MP4_FIXTURE);

// Real WebM/EBML signature (1A 45 DF A3) — reusing MP4_BUFFER here would now
// fail the backend's magic-byte signature check.
const WEBM_BUFFER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);

// 8-byte PNG signature — used to build oversized-image payloads that still
// carry a valid magic-byte header, so they exercise the SIZE rule (checked
// before the SIGNATURE rule) rather than the content-mismatch rule.
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex');
function oversizedImageBuffer(totalBytes: number): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.alloc(totalBytes - PNG_HEADER.length, 0x00)]);
}

const INVALID_TYPE_MSG = 'Định dạng tệp không hợp lệ';
const IMAGE_TOO_LARGE_MSG = 'Ảnh quá lớn (tối đa 10MB mỗi ảnh)';
const FILE_TOO_LARGE_MSG = 'Tệp quá lớn (ảnh tối đa 10MB, video tối đa 100MB)';
const CONTENT_MISMATCH_MSG = 'Nội dung tệp không khớp định dạng';
const TOO_MANY_FILES_MSG = 'Quá nhiều tệp trong một lần tải lên';
const TOO_MANY_FILES_MSG_UI = 'Quá nhiều tệp trong một lần tải lên (tối đa 20)';
const IMAGES_MAX_FILES = 20;
const NOTES_MSG = 'Vui lòng nhập ghi chú khi chuyển sang trạng thái Đã giao / Huỷ trả máy';
const PHOTO_OR_VIDEO_MSG = 'Vui lòng tải ảnh hoặc video khi chuyển sang trạng thái Đã giao / Huỷ trả máy';

// The backend's uploads dir, as a sibling repo checkout — same convention as
// 12-order-priority-sort.spec.ts's direct-psql REPAIRHUB_DATABASE_URL default:
// these specs assume a local dev checkout with both repos side by side.
const UPLOADS_DIR = process.env.REPAIRHUB_UPLOADS_DIR
  ?? path.join(__dirname, '..', '..', 'repairhub-backend', 'uploads');

function countUploadedFiles(): number {
  try {
    return fs.readdirSync(UPLOADS_DIR).length;
  } catch {
    return -1; // uploads dir not reachable locally — callers skip the assertion
  }
}

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  return (await res.json()).data.token as string;
}

interface SeedResult {
  orderId: string;
  orderCode: string;
  customerId: string;
  branchId: string;
}

async function seedOrder(
  token: string,
  request: import('@playwright/test').APIRequestContext,
): Promise<SeedResult> {
  const runId = uniqueNow();
  const phone = `098${runId.slice(-7)}`;

  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone, name: `Khách PW-23 ${runId}`, address: 'Test Address PW-23', type: 'RETAIL' },
  });
  const customerId = (await cRes.json()).data.id as string;

  const bRes = await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } });
  const branchId = (await bRes.json()).data[0].id as string;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      customer_id: customerId,
      branch_id: branchId,
      product_type: 'SPEAKER',
      device_name: `Loa PW-23-${runId}`,
      serial_imei: `SN-PW23-${runId}`,
      fault_description: 'E2E video-uploads test',
      quotation: 100000,
    },
  });
  const oBody = await oRes.json();
  return { orderId: oBody.data.id as string, orderCode: oBody.data.order_code as string, customerId, branchId };
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
}

/** All orders belonging to a customer — used to assert a rejected warranty
 * claim created no new (BAO_HANH) order for the source. */
async function ordersOf(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  customerId: string,
): Promise<Array<{ id: string; order_code: string }>> {
  const r = await request.get(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()).data.orders as Array<{ id: string; order_code: string }>;
}

/** Upload one file to POST /orders/:id/images and return the raw response. */
async function uploadToOrder(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  orderId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
  imageType: 'INTAKE' | 'COMPLETION' = 'INTAKE',
) {
  return request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { image_type: imageType, images: file },
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

test.describe('PW-23 API — video uploads on all three media endpoints', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-01: MP4 via POST /:id/images → 201, .mp4 path, Range GET → 206', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    const res = await uploadToOrder(request, token, orderId, { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER });
    expect(res.status()).toBe(201);
    const body = await res.json();
    const storedPath: string = body.data[0].image_path;
    expect(storedPath).toMatch(/\.mp4$/);

    const rangeRes = await request.get(`${API_ORIGIN}/uploads/${storedPath}`, {
      headers: { Range: 'bytes=0-99' },
    });
    expect(rangeRes.status()).toBe(206);
    const contentRange = rangeRes.headers()['content-range'];
    expect(contentRange).toBeTruthy();
    expect(contentRange).toMatch(/^bytes 0-99\//);

    await cleanup(token, request, customerId);
  });

  test('TC-02: MP4 via POST /bulk-with-images → 201, stored path ends .mp4', async ({ request }) => {
    const runId = uniqueNow();
    const cRes = await request.post(`${API_BASE}/customers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { phone: `099${runId.slice(-7)}`, name: `Khách PW-23-bulk ${runId}`, type: 'RETAIL' },
    });
    const customerId = (await cRes.json()).data.id as string;
    const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;
    const deviceName = `Loa PW-23-BULK-${runId}`;

    const res = await request.post(`${API_BASE}/orders/bulk-with-images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        payload: JSON.stringify({
          customer_id: customerId,
          branch_id: branchId,
          products: [{ product_type: 'SPEAKER', device_name: deviceName, fault_description: 'video test' }],
        }),
        images_0: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER },
      },
    });
    expect(res.status()).toBe(201);

    const custRes = await request.get(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } });
    const orders = (await custRes.json()).data.orders as Array<{ id: string; device_name: string }>;
    const order = orders.find((o) => o.device_name === deviceName);
    expect(order, 'order created').toBeTruthy();

    const detailRes = await request.get(`${API_BASE}/orders/${order!.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const images = (await detailRes.json()).data.images as Array<{ image_path: string }>;
    expect(images.length).toBe(1);
    expect(images[0].image_path).toMatch(/\.mp4$/);

    await cleanup(token, request, customerId);
  });

  test('TC-03: MP4 via POST /warranty-claim → 201, stored path ends .mp4', async ({ request }) => {
    const { orderId: sourceOrderId, customerId, branchId } = await seedOrder(token, request);

    const res = await request.post(`${API_BASE}/orders/warranty-claim`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        source_order_id: sourceOrderId,
        branch_id: branchId,
        fault_description: 'PW-23 warranty video test',
        images_1: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER },
      },
    });
    expect(res.status()).toBe(201);
    const bhOrderId = (await res.json()).data.id as string;

    const detailRes = await request.get(`${API_BASE}/orders/${bhOrderId}`, { headers: { Authorization: `Bearer ${token}` } });
    const images = (await detailRes.json()).data.images as Array<{ image_path: string }>;
    expect(images.length).toBe(1);
    expect(images[0].image_path).toMatch(/\.mp4$/);

    await cleanup(token, request, customerId);
  });

  test('TC-04: MOV (video/quicktime) is accepted', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await uploadToOrder(request, token, orderId, { name: 'clip.mov', mimeType: 'video/quicktime', buffer: MP4_BUFFER });
    expect(res.status()).toBe(201);
    const storedPath: string = (await res.json()).data[0].image_path;
    expect(storedPath).toMatch(/\.mov$/);
    await cleanup(token, request, customerId);
  });

  test('TC-05: WebM (video/webm) is accepted', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await uploadToOrder(request, token, orderId, { name: 'clip.webm', mimeType: 'video/webm', buffer: WEBM_BUFFER });
    expect(res.status()).toBe(201);
    const storedPath: string = (await res.json()).data[0].image_path;
    expect(storedPath).toMatch(/\.webm$/);
    await cleanup(token, request, customerId);
  });

  test('TC-06: an AVI (video/x-msvideo) upload is rejected with 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await uploadToOrder(request, token, orderId, { name: 'clip.avi', mimeType: 'video/x-msvideo', buffer: Buffer.from('not really avi') });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const body = await res.json();
    expect(body.error).toBe(INVALID_TYPE_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-07: a PDF (application/pdf) upload is rejected with 400', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const res = await uploadToOrder(request, token, orderId, { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const body = await res.json();
    expect(body.error).toBe(INVALID_TYPE_MSG);
    await cleanup(token, request, customerId);
  });

  test('TC-08: an 11MB image is rejected (400) and leaves no new file on disk', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const before = countUploadedFiles();

    // Starts with a valid PNG magic-byte header (see oversizedImageBuffer) so
    // this exercises the SIZE rule, not the signature-mismatch rule — the
    // backend checks size across all files before it checks any signature.
    const bigImage = oversizedImageBuffer(11 * 1024 * 1024);
    const res = await uploadToOrder(request, token, orderId, { name: 'huge.png', mimeType: 'image/png', buffer: bigImage });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(IMAGE_TOO_LARGE_MSG);

    const after = countUploadedFiles();
    if (before >= 0 && after >= 0) {
      expect(after, 'uploads dir must not grow from a rejected oversized image').toBe(before);
    }

    await cleanup(token, request, customerId);
  });

  test('TC-09: a 101MB video is rejected and leaves no new file on disk', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const before = countUploadedFiles();

    const bigVideo = Buffer.alloc(101 * 1024 * 1024, 0x43);
    const res = await uploadToOrder(request, token, orderId, { name: 'huge.mp4', mimeType: 'video/mp4', buffer: bigVideo });
    // multer's fileSize limit fires mid-parse — errorHandler.ts maps
    // LIMIT_FILE_SIZE to 413 with the combined image/video guidance message.
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toBe(FILE_TOO_LARGE_MSG);

    const after = countUploadedFiles();
    if (before >= 0 && after >= 0) {
      expect(after, 'uploads dir must not grow from a rejected oversized video').toBe(before);
    }

    await cleanup(token, request, customerId);
  });

  test('TC-10: a mixed request (valid video + oversized image) is rejected with no rows or files created', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const before = countUploadedFiles();

    // Starts with a valid PNG header — see oversizedImageBuffer — so this
    // still exercises the SIZE rule even though the signature check now runs.
    const bigImage = oversizedImageBuffer(11 * 1024 * 1024);
    // Two files under the SAME "images" field name (multer's upload.array('images'))
    // can't be expressed with Playwright's plain-object `multipart` shorthand
    // (it's a flat record — one value per key), so build it with the
    // web-standard FormData/File globals (built into Node 18+) instead.
    const form = new FormData();
    form.set('image_type', 'INTAKE');
    form.append('images', new File([MP4_BUFFER], 'clip.mp4', { type: 'video/mp4' }));
    form.append('images', new File([bigImage], 'huge.png', { type: 'image/png' }));
    const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: form,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(IMAGE_TOO_LARGE_MSG);

    // No order_images rows — including for the valid video in the same request.
    const detailRes = await request.get(`${API_BASE}/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } });
    const images = (await detailRes.json()).data.images as unknown[];
    expect(images.length, 'no images/videos persisted from a rejected mixed request').toBe(0);

    const after = countUploadedFiles();
    if (before >= 0 && after >= 0) {
      expect(after, 'uploads dir must not grow from a rejected mixed request').toBe(before);
    }

    await cleanup(token, request, customerId);
  });

  test('TC-11: a COMPLETION video plus notes lets the order move to DA_GIAO (200)', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    const upload = await uploadToOrder(request, token, orderId, { name: 'completion.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER }, 'COMPLETION');
    expect(upload.status()).toBe(201);

    const res = await request.put(`${API_BASE}/orders/${orderId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status: 'DA_GIAO', notes: 'Đã giao kèm video xác nhận' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DA_GIAO');

    await cleanup(token, request, customerId);
  });

  test('TC-12: HTML declared as video/mp4 is rejected as a content mismatch', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const before = countUploadedFiles();

    const html = Buffer.from('<!DOCTYPE html><html><body>not a video</body></html>');
    const res = await uploadToOrder(request, token, orderId, { name: 'fake.mp4', mimeType: 'video/mp4', buffer: html });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(CONTENT_MISMATCH_MSG);

    const after = countUploadedFiles();
    if (before >= 0 && after >= 0) {
      expect(after, 'uploads dir must not grow from a content-mismatch rejection').toBe(before);
    }

    await cleanup(token, request, customerId);
  });

  test('TC-13: warranty-claim with an oversized/mismatched file is rejected and creates no BAO_HANH order', async ({ request }) => {
    const { orderId: sourceOrderId, orderCode: sourceOrderCode, customerId, branchId } = await seedOrder(token, request);

    // Content mismatch: declared image/png, real bytes are HTML.
    const badFile = Buffer.from('<!DOCTYPE html><html><body>not an image</body></html>');
    const res = await request.post(`${API_BASE}/orders/warranty-claim`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        source_order_id: sourceOrderId,
        branch_id: branchId,
        fault_description: 'PW-23 warranty content-mismatch test',
        images_1: { name: 'fake.png', mimeType: 'image/png', buffer: badFile },
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(CONTENT_MISMATCH_MSG);

    // Files are validated BEFORE any database write, in a transaction — no
    // <sourceOrderCode>-BH order should exist for this source.
    const orders = await ordersOf(request, token, customerId);
    const bhOrder = orders.find((o) => o.order_code === `${sourceOrderCode}-BH`);
    expect(bhOrder, 'no BAO_HANH order created from a rejected warranty-claim upload').toBeUndefined();
    expect(orders.length, 'only the original source order exists for this customer').toBe(1);

    await cleanup(token, request, customerId);
  });

  test('TC-14: 21 files to POST /:id/images is rejected with the file-count cap and leaves no files behind', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const before = countUploadedFiles();

    const jpegBuffer = fs.readFileSync(FIXT('img-a1.jpg'));
    const form = new FormData();
    form.set('image_type', 'INTAKE');
    for (let i = 0; i < IMAGES_MAX_FILES + 1; i += 1) {
      form.append('images', new File([jpegBuffer], `p${i}.jpg`, { type: 'image/jpeg' }));
    }
    const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: form,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(TOO_MANY_FILES_MSG);

    const after = countUploadedFiles();
    if (before >= 0 && after >= 0) {
      expect(after, 'uploads dir must not grow from a rejected over-the-cap request').toBe(before);
    }

    await cleanup(token, request, customerId);
  });

  test('TC-15: a successful /uploads response carries X-Content-Type-Options: nosniff', async ({ request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    const uploadRes = await uploadToOrder(request, token, orderId, { name: 'clip.mp4', mimeType: 'video/mp4', buffer: MP4_BUFFER });
    expect(uploadRes.status()).toBe(201);
    const storedPath: string = (await uploadRes.json()).data[0].image_path;

    const fileRes = await request.get(`${API_ORIGIN}/uploads/${storedPath}`);
    expect(fileRes.ok()).toBeTruthy();
    expect(fileRes.headers()['x-content-type-options']).toBe('nosniff');

    await cleanup(token, request, customerId);
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

test.describe('PW-23 UI — video uploads on the order detail page', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await apiLogin(request);
  });

  test('TC-16: attaching the MP4 and saving shows a video thumbnail and plays in the lightbox', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('input[type="file"]').setInputFiles(MP4_FIXTURE);
    await expect(page.getByText(/Đã chọn 1/)).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText('Cập nhật thành công')).toBeVisible({ timeout: 10_000 });

    // Gallery shows a <video> element (not <img>) for the saved file.
    await expect(page.getByText(/Ảnh đã lưu \(1\)/)).toBeVisible({ timeout: 10_000 });
    const galleryVideo = page.locator('video');
    await expect(galleryVideo).toBeVisible({ timeout: 5_000 });

    // Opening the thumbnail shows the lightbox with a playable <video controls>.
    await page.getByRole('button', { name: 'Mở video đầy đủ' }).click();
    const lightboxVideo = page.locator('video[controls]');
    await expect(lightboxVideo).toBeVisible({ timeout: 5_000 });

    await cleanup(token, request, customerId);
  });

  test('TC-17: a wrong-type file shows the client-side error', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'doc.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    });

    await expect(page.getByText(INVALID_TYPE_MSG)).toBeVisible({ timeout: 5_000 });
    // The bad file must not be added to the pending-upload list.
    await expect(page.getByText(/Đã chọn/)).toHaveCount(0);

    await cleanup(token, request, customerId);
  });

  test('TC-18: the evidence flow works with a video instead of a photo', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(token, request);

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    await page.locator('select').selectOption({ label: 'Đã giao' });
    await expect(page.getByText('Bắt buộc tải lên ít nhất 1 ảnh hoặc video và nhập ghi chú khi chuyển sang trạng thái này')).toBeVisible({ timeout: 5_000 });

    const saveButton = page.getByRole('button', { name: /Lưu thay đổi/i });
    await expect(saveButton).toBeDisabled();

    // Notes alone: still disabled.
    await page.getByPlaceholder('Thêm ghi chú...').fill('Đã giao kèm video');
    await expect(saveButton).toBeDisabled();

    // Notes + video: enabled, and saving succeeds.
    await page.locator('input[type="file"]').setInputFiles(MP4_FIXTURE);
    await expect(page.getByText(/Đã chọn 1/)).toBeVisible({ timeout: 5_000 });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const badge = page.getByTestId('order-status-badge');
    await expect(badge).toContainText('Đã giao', { timeout: 10_000 });

    await cleanup(token, request, customerId);
  });

  test('TC-19: picking 21 files at once on order detail shows the client-side cap message', async ({ page, request }) => {
    const { orderId, customerId } = await seedOrder(token, request);
    const jpegBuffer = fs.readFileSync(FIXT('img-a1.jpg'));

    await loginViaUI(page);
    await page.goto(`/orders/${orderId}`);

    const files = Array.from({ length: IMAGES_MAX_FILES + 1 }, (_, i) => ({
      name: `p${i}.jpg`,
      mimeType: 'image/jpeg',
      buffer: jpegBuffer,
    }));
    await page.locator('input[type="file"]').setInputFiles(files);

    await expect(page.getByText(TOO_MANY_FILES_MSG_UI)).toBeVisible({ timeout: 5_000 });
    // The first 20 files are still added — only the 21st is dropped by the cap.
    await expect(page.getByText(new RegExp(`Đã chọn ${IMAGES_MAX_FILES}`))).toBeVisible({ timeout: 5_000 });

    await cleanup(token, request, customerId);
  });
});

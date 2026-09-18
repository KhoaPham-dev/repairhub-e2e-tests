import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

// Small real JPEG already used by other specs (order-images, warranty-claim).
const COMPLETION_IMAGE_PATH = path.join(__dirname, '..', 'fixtures', 'img-a1.jpg');

/**
 * Statuses that require a fresh COMPLETION photo (uploaded after the order's
 * most recent status change) before the transition is accepted. Mirrors
 * IMAGE_REQUIRED_STATUSES in the backend's PUT /orders/:id/status handler
 * and the frontend's order detail page.
 */
export const IMAGE_REQUIRED_STATUSES = ['DA_GIAO', 'TRA_HANG'];

/** Absolute path to a small JPEG fixture — usable directly with setInputFiles(). */
export const COMPLETION_IMAGE_FIXTURE = COMPLETION_IMAGE_PATH;

/**
 * Upload a COMPLETION image to an order via the API so a subsequent
 * DA_GIAO / TRA_HANG status transition (also driven via the API) satisfies
 * the fresh-image requirement. Throws on failure so callers see a clear
 * error instead of a confusing downstream 400 on the status PUT.
 */
export async function uploadCompletionImage(
  request: APIRequestContext,
  token: string,
  orderId: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      image_type: 'COMPLETION',
      images: {
        name: 'completion.jpg',
        mimeType: 'image/jpeg',
        buffer: fs.readFileSync(COMPLETION_IMAGE_PATH),
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`Failed to upload completion image for order ${orderId}: ${res.status()}`);
  }
}

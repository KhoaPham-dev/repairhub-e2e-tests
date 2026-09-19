import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext, APIResponse } from '@playwright/test';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';

// Small real JPEG already used by other specs (order-images, warranty-claim).
const COMPLETION_IMAGE_PATH = path.join(__dirname, '..', 'fixtures', 'img-a1.jpg');

/**
 * Statuses that require both non-blank notes and a fresh COMPLETION photo
 * (uploaded after the order's most recent REAL status transition) before
 * the transition is accepted. Mirrors EVIDENCE_REQUIRED_STATUSES in the
 * backend's PUT /orders/:id/status handler and the frontend's order detail
 * page. DA_GIAO requires nothing (even if SUA_XONG was skipped); TRA_HANG
 * requires nothing either.
 */
export const EVIDENCE_REQUIRED_STATUSES = ['SUA_XONG', 'HUY_TRA_MAY'];

/** Absolute path to a small JPEG fixture — usable directly with setInputFiles(). */
export const COMPLETION_IMAGE_FIXTURE = COMPLETION_IMAGE_PATH;

/**
 * Upload a COMPLETION image to an order via the API so a subsequent
 * SUA_XONG / HUY_TRA_MAY status transition (also driven via the API)
 * satisfies the fresh-photo requirement. Throws on failure so callers see a
 * clear error instead of a confusing downstream 400 on the status PUT.
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

/**
 * Transition an order to `status` via the API, automatically satisfying the
 * evidence requirement (non-blank notes + fresh COMPLETION photo) when
 * `status` is SUA_XONG or HUY_TRA_MAY. DA_GIAO requires nothing, so no
 * notes are sent for it unless the caller explicitly passes some. Use this
 * instead of a bare PUT when a spec doesn't need to exercise the evidence
 * rule itself.
 */
export async function transitionStatus(
  request: APIRequestContext,
  token: string,
  orderId: string,
  status: string,
  opts: { notes?: string } = {},
): Promise<APIResponse> {
  const evidenceRequired = EVIDENCE_REQUIRED_STATUSES.includes(status);
  const notes = opts.notes ?? (evidenceRequired ? `E2E transition to ${status}` : undefined);
  if (evidenceRequired) {
    await uploadCompletionImage(request, token, orderId);
  }
  return request.put(`${API_BASE}/orders/${orderId}/status`, {
    headers: { Authorization: `Bearer ${token}` },
    data: notes !== undefined ? { status, notes } : { status },
  });
}

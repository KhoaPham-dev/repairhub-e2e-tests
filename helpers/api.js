/**
 * API helper — thin fetch wrapper for RepairHub E2E tests.
 * All helpers return { status, body } so tests can assert both.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { recordCustomerId } = require('./registry');

const BASE_URL = process.env.API_URL || 'http://localhost:6061/api';

async function request(method, endpoint, { body, token, formData } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let fetchBody;
  if (formData) {
    // formData is a FormData instance; let node-fetch set the Content-Type
    fetchBody = formData;
    Object.assign(headers, formData.getHeaders());
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers,
    body: fetchBody,
  });

  let responseBody;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    responseBody = await response.json();
  } else {
    responseBody = await response.buffer();
  }

  // Record every customer this run creates, regardless of which test/helper
  // triggered it, so the DB teardown at the end of the run can find and
  // remove it (and its orders) without every call site having to remember
  // to register it itself. See scripts/db-cleanup.js.
  if (method === 'POST' && endpoint === '/customers' && response.status === 201 && responseBody?.data?.id) {
    recordCustomerId(responseBody.data.id);
  }

  return { status: response.status, body: responseBody };
}

const api = {
  get: (endpoint, opts) => request('GET', endpoint, opts),
  post: (endpoint, opts) => request('POST', endpoint, opts),
  put: (endpoint, opts) => request('PUT', endpoint, opts),
  patch: (endpoint, opts) => request('PATCH', endpoint, opts),
  delete: (endpoint, opts) => request('DELETE', endpoint, opts),
};

/**
 * Login and return the JWT token. Throws if login fails.
 */
async function login(username, password) {
  const { status, body } = await api.post('/auth/login', { body: { username, password } });
  if (status !== 200 || !body.success) {
    throw new Error(`Login failed for ${username}: ${body.error || status}`);
  }
  return body.data.token;
}

/**
 * Create a small dummy PNG buffer for image upload tests.
 */
function createDummyImageBuffer() {
  // Minimal 1x1 red PNG (67 bytes)
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
    '2e000000124944415478016360f8cfc00000000200012184ebb20000000049454e44ae426082',
    'hex'
  );
}

/**
 * Build a multipart FormData for image upload.
 */
function buildImageFormData(imageType = 'INTAKE') {
  const form = new FormData();
  form.append('images', createDummyImageBuffer(), {
    filename: 'test-image.png',
    contentType: 'image/png',
  });
  form.append('image_type', imageType);
  return form;
}

/**
 * Statuses that require both non-blank notes and a fresh COMPLETION photo
 * (uploaded after the order's most recent REAL status transition) before
 * the transition is accepted. Mirrors EVIDENCE_REQUIRED_STATUSES in the
 * backend's PUT /orders/:id/status handler. DA_GIAO requires nothing (even
 * if SUA_XONG was skipped) and TRA_HANG requires nothing either — only
 * SUA_XONG and HUY_TRA_MAY do.
 */
const EVIDENCE_REQUIRED_STATUSES = ['SUA_XONG', 'HUY_TRA_MAY'];

/**
 * Upload a COMPLETION image to an order so a subsequent SUA_XONG / HUY_TRA_MAY
 * status transition satisfies the fresh-image requirement. Throws if the
 * upload itself fails, so callers get a clear error instead of a confusing
 * downstream 400 on the status PUT.
 */
async function uploadCompletionImage(token, orderId) {
  const form = buildImageFormData('COMPLETION');
  const { status, body } = await api.post(`/orders/${orderId}/images`, {
    token,
    formData: form,
  });
  if (status !== 201) {
    throw new Error(
      `Failed to upload completion image for order ${orderId}: ${status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

/**
 * Transition an order to `status`, automatically satisfying the evidence
 * requirement (non-blank notes + fresh COMPLETION photo) when `status` is
 * SUA_XONG or HUY_TRA_MAY. DA_GIAO requires nothing, so no notes are sent
 * for it unless the caller explicitly passes some. Use this instead of a
 * bare `api.put(.../status)` call when a test doesn't need to exercise the
 * evidence rule itself.
 */
async function transitionStatus(token, orderId, status, opts = {}) {
  const evidenceRequired = EVIDENCE_REQUIRED_STATUSES.includes(status);
  const notes = opts.notes ?? (evidenceRequired ? `E2E transition to ${status}` : undefined);
  if (evidenceRequired) {
    await uploadCompletionImage(token, orderId);
  }
  const body = notes !== undefined ? { status, notes } : { status };
  return api.put(`/orders/${orderId}/status`, { token, body });
}

module.exports = {
  api,
  login,
  createDummyImageBuffer,
  buildImageFormData,
  uploadCompletionImage,
  transitionStatus,
  EVIDENCE_REQUIRED_STATUSES,
  BASE_URL,
};

/**
 * API helper — thin fetch wrapper for RepairHub E2E tests.
 * All helpers return { status, body } so tests can assert both.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.API_URL || 'http://localhost:3001/api';

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

  return { status: response.status, body: responseBody };
}

const api = {
  get: (endpoint, opts) => request('GET', endpoint, opts),
  post: (endpoint, opts) => request('POST', endpoint, opts),
  put: (endpoint, opts) => request('PUT', endpoint, opts),
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

module.exports = { api, login, createDummyImageBuffer, buildImageFormData, BASE_URL };

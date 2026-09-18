/**
 * PW-27 — MCP server (repairhub-mcp) — RH-149 / feat/RH-147-mcp-server
 *
 * Covers SRS FR-17 (subsections 17D-17E) and NFR-08, and the "MCP server
 * endpoints" table in guides/mcp-ai-agents.md: a standalone MCP server,
 * reached over the official @modelcontextprotocol/sdk Client +
 * StreamableHTTPClientTransport (not raw HTTP) for every tool-call
 * assertion, that proxies to repairhub-backend's Agent API.
 *
 * Prerequisites:
 *   - backend running at http://localhost:6061 with AGENT_API_KEY /
 *     PUBLIC_MEDIA_BASE_URL set (same as 26-agent-api.spec.ts).
 *   - repairhub-mcp built (`npm run build`) and running at
 *     http://localhost:6062, with MCP_ACCESS_TOKEN = MCP_ACCESS_TOKEN
 *     (below), AGENT_API_BASE_URL=http://localhost:6061,
 *     AGENT_API_KEY = the same key the backend was started with, and
 *     PUBLIC_MEDIA_BASE_URL=http://localhost:6061.
 */

import { test, expect } from './helpers/fixtures';
import * as path from 'path';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { uniqueNow } from './helpers/ids';
import { ADMIN_USER, ADMIN_PASSWORD } from './helpers/auth';
import { AGENT_API_KEY, MCP_ACCESS_TOKEN } from './helpers/agentMcpConfig';

const API_BASE = process.env.API_URL ?? 'http://localhost:6061/api';
const MCP_BASE = process.env.MCP_URL ?? 'http://localhost:6062';
const FIXT = (f: string) => path.join(__dirname, 'fixtures', f);

const EXPECTED_TOOLS = ['tim_don_hang', 'chi_tiet_don_hang', 'don_hang_noi_bat', 'xem_anh'];

async function apiLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  return (await res.json()).data.token as string;
}

async function dbConnect(): Promise<PgClient> {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) throw new Error('E2E_DATABASE_URL must be set to run PW-27 (don_hang_noi_bat needs an isolated seeded date)');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  return client;
}

/** Spreads a large future range across concurrent/repeated runs so no two
 * invocations pick the same VN calendar date — same technique as
 * 26-agent-api.spec.ts, needed here too: querying don_hang_noi_bat on
 * "today" is vulnerable to being crowded out (variety guard / limit) by
 * however much OTHER real "today" test data the rest of the suite is
 * concurrently creating. */
function uniqueFutureDate(): string {
  const n = Number(uniqueNow());
  const dayOffset = n % 3650;
  const base = new Date('2098-01-01T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + dayOffset);
  return base.toISOString().slice(0, 10);
}

async function seedOrderWithRealMedia(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  opts: { kind: 'photo' | 'video'; fault?: string } = { kind: 'photo' },
): Promise<{ orderId: string; orderCode: string; customerId: string; mediaUrl: string }> {
  const runId = uniqueNow();
  const cRes = await request.post(`${API_BASE}/customers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { phone: `091${runId.slice(-7)}`, name: `Khách PW-27 ${runId}`, type: 'RETAIL' },
  });
  const customerId = (await cRes.json()).data.id as string;
  const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${token}` } })).json()).data[0].id;

  const oRes = await request.post(`${API_BASE}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { customer_id: customerId, branch_id: branchId, product_type: 'SPEAKER', device_name: `Loa PW-27-${runId}`, fault_description: opts.fault ?? 'Loi nho', quotation: 0 },
  });
  const oBody = await oRes.json();
  const orderId = oBody.data.id as string;
  const orderCode = oBody.data.order_code as string;

  const fixtureFile = opts.kind === 'video' ? FIXT('tiny.mp4') : FIXT('img-a1.jpg');
  const mimeType = opts.kind === 'video' ? 'video/mp4' : 'image/jpeg';
  const uploadRes = await request.post(`${API_BASE}/orders/${orderId}/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { image_type: 'COMPLETION', images: { name: opts.kind === 'video' ? 'clip.mp4' : 'photo.jpg', mimeType, buffer: require('fs').readFileSync(fixtureFile) } },
  });
  const uploadBody = await uploadRes.json();
  const imagePath: string = uploadBody.data[0].image_path;
  const mediaUrl = `http://localhost:6061/uploads/${imagePath}`;

  return { orderId, orderCode, customerId, mediaUrl };
}

async function cleanup(
  token: string,
  request: import('@playwright/test').APIRequestContext,
  customerId: string,
): Promise<void> {
  await request.delete(`${API_BASE}/customers/${customerId}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
}

async function connectViaPathToken(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_BASE}/mcp/${token}`));
  const client = new Client({ name: 'e2e-pw27-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function connectViaBearer(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'e2e-pw27-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function toolTextJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const textBlock = result.content.find((c) => c.type === 'text');
  return textBlock?.text ? JSON.parse(textBlock.text) : undefined;
}

// ---------------------------------------------------------------------------

test.describe('PW-27 MCP server', () => {
  let staffToken: string;
  let db: PgClient;

  test.beforeAll(async ({ request }) => {
    staffToken = await apiLogin(request);
    db = await dbConnect();
  });

  test.afterAll(async () => {
    await db.end();
  });

  // ---------------------------------------------------------------------
  // Transport-level: auth, method handling, health
  // ---------------------------------------------------------------------

  test.describe('transport', () => {
    test('GET /healthz -> 200 {ok:true}, no auth required', async ({ request }) => {
      const res = await request.get(`${MCP_BASE}/healthz`);
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test('wrong path-token -> 401', async ({ request }) => {
      const res = await request.post(`${MCP_BASE}/mcp/not-the-real-token`, { data: { jsonrpc: '2.0', method: 'tools/list', id: 1 } });
      expect(res.status()).toBe(401);
      expect(await res.json()).toEqual({ success: false, data: null, error: 'Unauthorized' });
    });

    test('missing/wrong Bearer token on /mcp -> 401', async ({ request }) => {
      const noAuth = await request.post(`${MCP_BASE}/mcp`, { data: { jsonrpc: '2.0', method: 'tools/list', id: 1 } });
      expect(noAuth.status()).toBe(401);

      const wrongAuth = await request.post(`${MCP_BASE}/mcp`, {
        headers: { Authorization: 'Bearer not-the-real-token' },
        data: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(wrongAuth.status()).toBe(401);
    });

    test('an unrelated path -> 401 (no hint about route structure)', async ({ request }) => {
      const res = await request.get(`${MCP_BASE}/definitely-not-a-route`);
      expect(res.status()).toBe(401);
    });

    test('GET and DELETE on /mcp and /mcp/:token -> 405', async ({ request }) => {
      for (const url of [`${MCP_BASE}/mcp`, `${MCP_BASE}/mcp/${MCP_ACCESS_TOKEN}`]) {
        const headers = url.endsWith(MCP_ACCESS_TOKEN) ? {} : { Authorization: `Bearer ${MCP_ACCESS_TOKEN}` };
        const getRes = await request.get(url, { headers });
        expect(getRes.status(), url).toBe(405);
        const delRes = await request.delete(url, { headers });
        expect(delRes.status(), url).toBe(405);
      }
    });
  });

  // ---------------------------------------------------------------------
  // listTools
  // ---------------------------------------------------------------------

  test('listTools returns exactly the 4 tools, with Vietnamese descriptions, via both auth modes', async () => {
    const clientA = await connectViaPathToken(MCP_ACCESS_TOKEN);
    const { tools: toolsA } = await clientA.listTools();
    expect(toolsA.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of toolsA) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.description!.length).toBeGreaterThan(10);
      // Vietnamese text — contains at least one diacritic-bearing character.
      expect(t.description).toMatch(/[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ]/i);
    }
    await clientA.close();

    const clientB = await connectViaBearer(MCP_ACCESS_TOKEN);
    const { tools: toolsB } = await clientB.listTools();
    expect(toolsB.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    await clientB.close();
  });

  // ---------------------------------------------------------------------
  // Tool calls against seeded data
  // ---------------------------------------------------------------------

  test.describe('tool calls', () => {
    let client: Client;

    test.beforeAll(async () => {
      client = await connectViaBearer(MCP_ACCESS_TOKEN);
    });
    test.afterAll(async () => {
      await client.close();
    });

    test('tim_don_hang matches the Agent API directly', async ({ request }) => {
      const runId = uniqueNow();
      const { orderId, orderCode, customerId } = await seedOrderWithRealMedia(staffToken, request, { fault: `PW27-timdonhang-${runId}` });

      const direct = await (await request.get(`${API_BASE}/agent/orders?limit=100`, { headers: { 'X-Agent-Key': AGENT_API_KEY } })).json();
      const directOrder = direct.data.items.find((o: { id: string }) => o.id === orderId);
      expect(directOrder, 'order must appear in the direct Agent API response').toBeTruthy();

      const result = await client.callTool({ name: 'tim_don_hang', arguments: { limit: 100 } });
      expect(result.isError).toBeFalsy();
      const parsed = toolTextJson(result as { content: Array<{ type: string; text?: string }> }) as { items: Array<{ id: string; order_code: string }> };
      const viaTool = parsed.items.find((o) => o.id === orderId);
      expect(viaTool, 'order must appear via tim_don_hang too').toBeTruthy();
      expect(viaTool).toEqual(directOrder);
      expect(viaTool!.order_code).toBe(orderCode);

      await cleanup(staffToken, request, customerId);
    });

    test('chi_tiet_don_hang matches the Agent API directly, by order_code', async ({ request }) => {
      // Deliberately uses order_code, not the UUID id — GET
      // /api/agent/orders/:idOrCode 500s for a well-formed UUID (a real
      // backend bug; see 26-agent-api.spec.ts's dedicated "known bug" test
      // and the final QA report). This tool proxies straight to that route,
      // so chi_tiet_don_hang would surface the same bug as a tool error for
      // an id lookup — that's covered by the bug report, not re-asserted here.
      const { orderCode, customerId } = await seedOrderWithRealMedia(staffToken, request);

      const direct = await (await request.get(`${API_BASE}/agent/orders/${orderCode}`, { headers: { 'X-Agent-Key': AGENT_API_KEY } })).json();

      const byCode = await client.callTool({ name: 'chi_tiet_don_hang', arguments: { order_id_or_code: orderCode } });
      expect(byCode.isError).toBeFalsy();
      expect(toolTextJson(byCode as { content: Array<{ type: string; text?: string }> })).toEqual(direct.data);

      await cleanup(staffToken, request, customerId);
    });

    // KNOWN BUG (see 26-agent-api.spec.ts and the final QA report): chi_tiet_don_hang
    // proxies straight to GET /api/agent/orders/:idOrCode, which 500s for
    // any well-formed UUID. This documents the DOCUMENTED contract
    // (isError should be false for an existing order's own id) and fails
    // until that route casts its SQL parameter correctly.
    test('chi_tiet_don_hang by id (UUID) — currently returns a tool error instead of the order (bug)', async ({ request }) => {
      test.fail(true, 'RH-149 finding: proxies GET /api/agent/orders/:idOrCode, which 500s for a well-formed UUID — see 26-agent-api.spec.ts and the final QA report.');
      const { orderId, customerId } = await seedOrderWithRealMedia(staffToken, request);

      const byId = await client.callTool({ name: 'chi_tiet_don_hang', arguments: { order_id_or_code: orderId } });
      expect(byId.isError, 'looking up an existing order by its own id should not be a tool error').toBeFalsy();

      await cleanup(staffToken, request, customerId);
    });

    test('don_hang_noi_bat matches the Agent API directly, on an isolated seeded date', async ({ request }) => {
      const { orderId, customerId } = await seedOrderWithRealMedia(staffToken, request);
      // An isolated far-future date (not "today") so this can't be crowded
      // out of the top `limit` by whatever else the rest of the suite is
      // concurrently creating with a real "today" timestamp — see
      // 26-agent-api.spec.ts's featured tests for the same rationale.
      const isolatedDate = uniqueFutureDate();
      await db.query('UPDATE orders SET created_at = $2 WHERE id = $1', [orderId, `${isolatedDate}T12:00:00+07:00`]);

      const direct = await (await request.get(`${API_BASE}/agent/featured?date=${isolatedDate}&limit=20`, { headers: { 'X-Agent-Key': AGENT_API_KEY } })).json();
      expect(direct.data.orders.some((o: { id: string }) => o.id === orderId), 'seeded order must be a featured candidate on its own isolated date').toBe(true);

      const result = await client.callTool({ name: 'don_hang_noi_bat', arguments: { date: isolatedDate, limit: 20 } });
      expect(result.isError).toBeFalsy();
      const parsed = toolTextJson(result as { content: Array<{ type: string; text?: string }> });
      expect(parsed).toEqual(direct.data);

      await cleanup(staffToken, request, customerId);
    });

    test('xem_anh on a real uploaded photo returns image content, width/height <= 1024', async ({ request }) => {
      const { customerId, mediaUrl } = await seedOrderWithRealMedia(staffToken, request, { kind: 'photo' });

      const result = await client.callTool({ name: 'xem_anh', arguments: { media_url: mediaUrl, kind: 'photo' } }) as {
        isError?: boolean;
        content: Array<{ type: string; data?: string; mimeType?: string }>;
        structuredContent?: { kind: string; width: number | null; height: number | null };
      };
      expect(result.isError).toBeFalsy();
      const imageBlock = result.content.find((c) => c.type === 'image');
      expect(imageBlock, 'must include an image content block').toBeTruthy();
      expect(imageBlock!.mimeType).toBe('image/jpeg');
      expect(imageBlock!.data).toBeTruthy();
      expect(result.structuredContent?.kind).toBe('photo');
      expect(result.structuredContent?.width).toBeTruthy();
      expect(result.structuredContent?.height).toBeTruthy();
      expect(result.structuredContent!.width!).toBeLessThanOrEqual(1024);
      expect(result.structuredContent!.height!).toBeLessThanOrEqual(1024);

      await cleanup(staffToken, request, customerId);
    });

    test('xem_anh on a video returns only its URL/metadata, no image content', async ({ request }) => {
      const { customerId, mediaUrl } = await seedOrderWithRealMedia(staffToken, request, { kind: 'video' });

      const result = await client.callTool({ name: 'xem_anh', arguments: { media_url: mediaUrl, kind: 'video' } }) as {
        isError?: boolean;
        content: Array<{ type: string }>;
        structuredContent?: { kind: string; url: string };
      };
      expect(result.isError).toBeFalsy();
      expect(result.content.some((c) => c.type === 'image'), 'must NOT include image content for a video').toBe(false);
      expect(result.structuredContent?.kind).toBe('video');
      expect(result.structuredContent?.url).toBe(mediaUrl);

      await cleanup(staffToken, request, customerId);
    });

    test('xem_anh on a foreign-origin URL returns a tool error', async () => {
      const result = await client.callTool({ name: 'xem_anh', arguments: { media_url: 'https://evil-example.com/uploads/photo.jpg', kind: 'photo' } });
      expect(result.isError).toBe(true);
    });

    test('xem_anh on a path-traversal URL (percent-encoded) returns a tool error', async () => {
      const result = await client.callTool({
        name: 'xem_anh',
        arguments: { media_url: 'http://localhost:6061/uploads/%2e%2e/%2e%2e/etc/passwd', kind: 'photo' },
      });
      expect(result.isError).toBe(true);
    });

    test('no customer data appears in any tool output', async ({ request }) => {
      const distinctiveName = `KHACHPIIMCP-${uniqueNow()}`;
      const distinctivePhone = `097${uniqueNow().slice(-7)}`;
      const distinctiveSerial = `SERIALPIIMCP${uniqueNow()}`;

      const cRes = await request.post(`${API_BASE}/customers`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: { phone: distinctivePhone, name: distinctiveName, type: 'RETAIL' },
      });
      const customerId = (await cRes.json()).data.id as string;
      const branchId = (await (await request.get(`${API_BASE}/branches`, { headers: { Authorization: `Bearer ${staffToken}` } })).json()).data[0].id;
      const oRes = await request.post(`${API_BASE}/orders`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        data: { customer_id: customerId, branch_id: branchId, product_type: 'SPEAKER', device_name: `Loa PII MCP ${uniqueNow()}`, serial_imei: distinctiveSerial, fault_description: 'Loi nho', quotation: 0 },
      });
      const orderId = (await oRes.json()).data.id as string;
      const orderCode = (await oRes.json()).data.order_code as string;
      await request.post(`${API_BASE}/orders/${orderId}/images`, {
        headers: { Authorization: `Bearer ${staffToken}` },
        multipart: { image_type: 'INTAKE', images: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: require('fs').readFileSync(FIXT('img-a1.jpg')) } },
      });

      const [search, detail] = await Promise.all([
        client.callTool({ name: 'tim_don_hang', arguments: { limit: 100 } }),
        client.callTool({ name: 'chi_tiet_don_hang', arguments: { order_id_or_code: orderCode } }),
      ]);
      const combined = JSON.stringify([search, detail]);
      for (const forbidden of [distinctiveName, distinctivePhone, distinctiveSerial, customerId]) {
        expect(combined, `must not contain "${forbidden}"`).not.toContain(forbidden);
      }

      await cleanup(staffToken, request, customerId);
    });
  });

  // ---------------------------------------------------------------------
  // Rate limit
  // ---------------------------------------------------------------------

  test('rate limit: exceeding the configured per-token limit returns 429', async () => {
    const port = process.env.E2E_MCP_LOW_RATE_LIMIT_PORT;
    if (!port) {
      test.skip(true, 'E2E_MCP_LOW_RATE_LIMIT_PORT not set — no low-rate-limit MCP instance running for this check');
      return;
    }
    const lowLimitBase = `http://localhost:${port}`;

    function isRateLimitError(err: unknown): boolean {
      const message = err instanceof Error ? err.message : String(err);
      return message.includes('429') || /too many/i.test(message);
    }

    let sawRateLimit = false;
    // The low-rate-limit MCP instance's per-token window is shared across
    // however many times this test (or a prior run of this same spec) has
    // already hit it within the last window — so even the very first
    // connect() (which itself sends an HTTP POST counted against the
    // limit) can already come back 429 if the window wasn't exhausted from
    // a previous run. Either way — failing at connect() or at a later
    // tool call — is a valid demonstration that the limit is enforced.
    for (let i = 0; i < 10 && !sawRateLimit; i++) {
      const transport = new StreamableHTTPClientTransport(new URL(`${lowLimitBase}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${MCP_ACCESS_TOKEN}` } },
      });
      const rlClient = new Client({ name: 'e2e-pw27-ratelimit-client', version: '1.0.0' });
      try {
        await rlClient.connect(transport);
        await rlClient.listTools();
      } catch (err) {
        if (isRateLimitError(err)) sawRateLimit = true;
      } finally {
        await rlClient.close().catch(() => null);
      }
    }
    expect(sawRateLimit, 'expected at least one call to be rejected with 429 once the low configured token limit was exceeded').toBe(true);
  });
});

/**
 * Custom Playwright `test`/`expect` that transparently records every
 * customer created via `request.post('.../customers', ...)` to the run
 * registry (see registry.ts), so the DB teardown in global-teardown.ts can
 * find and remove it (and its orders) without every spec having to
 * remember to register it itself.
 *
 * Specs opt in by importing `test`/`expect` from this module instead of
 * directly from '@playwright/test' — everything else behaves identically.
 */
import { test as base, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { recordCustomerId } from './registry';

async function maybeRecordCustomer(url: string, res: APIResponse): Promise<void> {
  if (!res.ok()) return;
  if (!/\/customers(\?.*)?$/.test(url)) return;
  try {
    const body = await res.json();
    const id = body?.data?.id;
    if (typeof id === 'string') recordCustomerId(id);
  } catch {
    // Not a JSON body / no data.id — nothing to record.
  }
}

export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ request }, use) => {
    const originalPost = request.post.bind(request);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).post = async (url: string, options?: Parameters<typeof originalPost>[1]) => {
      const res = await originalPost(url, options);
      await maybeRecordCustomer(url, res);
      return res;
    };
    await use(request);
  },
});

export { expect };

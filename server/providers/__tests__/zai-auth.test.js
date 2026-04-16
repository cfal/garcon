import { afterEach, describe, expect, it } from 'bun:test';

import { getZaiAuthStatus } from '../zai-auth.js';

describe('getZaiAuthStatus', () => {
  const originalApiKey = process.env.ZAI_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = originalApiKey;
    }
  });

  it('treats ZAI_API_KEY as authenticated', async () => {
    process.env.ZAI_API_KEY = 'zk-test-key';

    const status = await getZaiAuthStatus();

    expect(status).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });
});

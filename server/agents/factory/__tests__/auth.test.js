import { afterEach, describe, expect, it } from 'bun:test';

import { getFactoryAuthStatus } from '../factory-auth.js';

describe('getFactoryAuthStatus', () => {
  const originalApiKey = process.env.FACTORY_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = originalApiKey;
    }
  });

  it('treats FACTORY_API_KEY as authenticated', async () => {
    process.env.FACTORY_API_KEY = 'fk-test-key';

    const status = await getFactoryAuthStatus();

    expect(status).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });
});

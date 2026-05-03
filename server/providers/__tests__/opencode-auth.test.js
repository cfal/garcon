import { describe, expect, it, mock } from 'bun:test';
import { getOpenCodeAuthStatus } from '../opencode-auth.js';

describe('getOpenCodeAuthStatus', () => {
  it('treats binary availability as readiness without starting OpenCode', async () => {
    const getClient = mock(() => {
      throw new Error('should not start OpenCode');
    });
    const status = await getOpenCodeAuthStatus({
      isAvailable: () => true,
      getClientIfInitialized: () => null,
      getClient,
    });

    expect(status).toEqual({
      authenticated: true,
      canReauth: false,
      label: 'Installed',
      source: 'cli',
      detail: 'OpenCode manages provider authentication and models internally.',
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('reports unavailable when the binary is missing', async () => {
    const status = await getOpenCodeAuthStatus({
      isAvailable: () => false,
    });

    expect(status).toEqual({
      authenticated: false,
      canReauth: false,
      label: '',
      source: 'none',
    });
  });
});

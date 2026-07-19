import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getCursorAuthStatus } from '../cursor-auth.js';

function procWithJson(body, exitCode = 0, stderrText = '') {
  const encoder = new TextEncoder();
  const stdout = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(body)));
      controller.close();
    },
  });
  const stderr = new ReadableStream({
    start(controller) {
      if (stderrText) controller.enqueue(encoder.encode(stderrText));
      controller.close();
    },
  });

  return {
    stdout,
    stderr,
    exited: Promise.resolve(exitCode),
  };
}

describe('getCursorAuthStatus', () => {
  let apiKey;
  let originalSpawn;
  let spawnMock;
  const config = {
    binary: () => 'cursor-agent',
    apiKey: () => apiKey,
  };

  beforeEach(() => {
    apiKey = null;
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  it('treats CURSOR_API_KEY as authenticated without shelling out', async () => {
    apiKey = 'cursor-test-key';

    await expect(getCursorAuthStatus(config)).resolves.toEqual({
      authenticated: true,
      canReauth: false,
      label: 'CURSOR_API_KEY',
      source: 'environment',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('parses authenticated CLI status JSON', async () => {
    spawnMock.mockReturnValueOnce(procWithJson({
      status: 'authenticated',
      isAuthenticated: true,
      email: 'dev@example.test',
    }));

    await expect(getCursorAuthStatus(config)).resolves.toMatchObject({
      authenticated: true,
      canReauth: false,
      label: 'dev@example.test',
      source: 'cli',
    });
    expect(spawnMock.mock.calls[0][0].slice(-3)).toEqual(['status', '--format', 'json']);
  });

  it('reports unauthenticated CLI status details', async () => {
    spawnMock.mockReturnValueOnce(procWithJson({
      status: 'unauthenticated',
      isAuthenticated: false,
      message: 'Not logged in',
    }));

    await expect(getCursorAuthStatus(config)).resolves.toMatchObject({
      authenticated: false,
      canReauth: false,
      label: '',
      source: 'none',
      detail: 'Not logged in',
    });
  });
});

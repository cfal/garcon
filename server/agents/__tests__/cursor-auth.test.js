import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getCursorAuthStatus } from '../cursor/cursor-auth.js';

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
  const originalApiKey = process.env.CURSOR_API_KEY;
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    if (originalApiKey === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = originalApiKey;
    }
  });

  it('treats CURSOR_API_KEY as authenticated without shelling out', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';

    await expect(getCursorAuthStatus()).resolves.toEqual({
      authenticated: true,
      canReauth: false,
      label: 'CURSOR_API_KEY',
      source: 'environment',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('parses authenticated CLI status JSON', async () => {
    delete process.env.CURSOR_API_KEY;
    spawnMock.mockReturnValueOnce(procWithJson({
      status: 'authenticated',
      isAuthenticated: true,
      email: 'dev@example.test',
    }));

    await expect(getCursorAuthStatus()).resolves.toMatchObject({
      authenticated: true,
      canReauth: false,
      label: 'dev@example.test',
      source: 'cli',
    });
    expect(spawnMock.mock.calls[0][0].slice(-3)).toEqual(['status', '--format', 'json']);
  });

  it('reports unauthenticated CLI status details', async () => {
    delete process.env.CURSOR_API_KEY;
    spawnMock.mockReturnValueOnce(procWithJson({
      status: 'unauthenticated',
      isAuthenticated: false,
      message: 'Not logged in',
    }));

    await expect(getCursorAuthStatus()).resolves.toMatchObject({
      authenticated: false,
      canReauth: false,
      label: '',
      source: 'none',
      detail: 'Not logged in',
    });
  });
});

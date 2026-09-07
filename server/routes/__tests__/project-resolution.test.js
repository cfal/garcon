import { describe, expect, it, mock } from 'bun:test';
import { createProjectResolutionRoutes } from '../project-resolution.ts';

const CHAT_ID = '1783725900000800';

function request(handler, query) {
  const url = new URL(`http://localhost/api/v1/projects/resolve?${query}`);
  return handler(new Request(url), url);
}

function fixture(overrides = {}) {
  const registry = {
    getChat: mock(() => ({ projectPath: '/workspace/project' })),
    ...overrides.registry,
  };
  const inspect = mock(async () => ({ kind: 'available', effectiveProjectKey: '/real/project' }));
  const routes = createProjectResolutionRoutes({ registry, inspect: overrides.inspect ?? inspect });
  return { handler: routes['/api/v1/projects/resolve'].GET, registry, inspect };
}

describe('GET /api/v1/projects/resolve', () => {
  it('resolves chat and raw-path targets without caching', async () => {
    const chat = fixture();
    const chatResponse = await request(
      chat.handler,
      new URLSearchParams({ chatId: CHAT_ID, expectedProjectPath: '/workspace/project' }),
    );
    expect(chatResponse.status).toBe(200);
    expect(chatResponse.headers.get('Cache-Control')).toBe('no-store');
    await expect(chatResponse.json()).resolves.toEqual({
      target: { kind: 'chat', chatId: CHAT_ID, projectPath: '/workspace/project' },
      resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
    });

    const raw = fixture({
      inspect: mock(async () => ({ kind: 'unavailable', reason: 'not-found' })),
    });
    const rawResponse = await request(
      raw.handler,
      new URLSearchParams({ projectPath: '/workspace/missing' }),
    );
    expect(rawResponse.status).toBe(200);
    await expect(rawResponse.json()).resolves.toMatchObject({
      target: { kind: 'path', projectPath: '/workspace/missing' },
      resolution: { kind: 'unavailable', reason: 'not-found' },
    });
  });

  it('rejects missing chats and stale bindings before inspection', async () => {
    const missing = fixture({ registry: { getChat: mock(() => null) } });
    const missingResponse = await request(
      missing.handler,
      new URLSearchParams({ chatId: CHAT_ID, expectedProjectPath: '/workspace/project' }),
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({ errorCode: 'SESSION_NOT_FOUND' });

    const stale = fixture();
    const staleResponse = await request(
      stale.handler,
      new URLSearchParams({ chatId: CHAT_ID, expectedProjectPath: '/workspace/old' }),
    );
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({ errorCode: 'PROJECT_PATH_CHANGED' });
    expect(stale.inspect).not.toHaveBeenCalled();
  });

  it('rejects a binding changed during inspection', async () => {
    let reads = 0;
    const current = fixture({
      registry: {
        getChat: mock(() => ({
          projectPath: reads++ === 0 ? '/workspace/project' : '/workspace/new',
        })),
      },
    });
    const response = await request(
      current.handler,
      new URLSearchParams({ chatId: CHAT_ID, expectedProjectPath: '/workspace/project' }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'PROJECT_PATH_CHANGED' });
  });

  it('accepts only the two exact query forms', async () => {
    const { handler, inspect } = fixture();
    for (const query of [
      '',
      'chatId=1783725900000800',
      'projectPath=%2Fworkspace%2Fproject&extra=true',
      'projectPath=%2Fa&projectPath=%2Fb',
      'chatId=1783725900000800&expectedProjectPath=%2Fa&projectPath=%2Fa',
    ]) {
      const response = await request(handler, query);
      expect(response.status).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it('returns unexpected inspection failures without caching them', async () => {
    const failure = fixture({
      inspect: mock(async () => { throw new Error('device failed'); }),
    });
    const response = await request(
      failure.handler,
      new URLSearchParams({ projectPath: '/workspace/project' }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      retryable: true,
    });
  });
});

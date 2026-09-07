import { describe, expect, it } from 'bun:test';
import { LOCAL_CAPABILITY_PREFIX } from '../../../common/server-runtime.js';
import { isNoAuthHandler } from '../../lib/http-route.js';
import { createServerRuntimeProof } from '../../lib/server-runtime.js';
import { createRuntimeRoutes } from '../runtime.js';

describe('runtime route', () => {
  it('exposes only a fresh instance proof without authentication', async () => {
    const runtime = {
      identity: {
        schemaVersion: 1,
        instanceId: 'instance-1',
        workspaceDir: '/private/workspace',
        startedAt: '2026-08-01T00:00:00.000Z',
      },
      localCapability: `${LOCAL_CAPABILITY_PREFIX}${'a'.repeat(43)}`,
    };
    const challenge = 'b'.repeat(43);
    const route = createRuntimeRoutes(runtime)['/api/v1/runtime'].GET;

    const url = new URL(`http://localhost/api/v1/runtime?challenge=${challenge}`);
    const response = await route(new Request(url), url);

    expect(isNoAuthHandler(route)).toBe(true);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      instanceId: 'instance-1',
      proof: createServerRuntimeProof(runtime, challenge),
    });
  });

  it('rejects a missing proof challenge', async () => {
    const runtime = {
      identity: {
        schemaVersion: 1,
        instanceId: 'instance-1',
        workspaceDir: '/private/workspace',
        startedAt: '2026-08-01T00:00:00.000Z',
      },
      localCapability: `${LOCAL_CAPABILITY_PREFIX}${'a'.repeat(43)}`,
    };
    const route = createRuntimeRoutes(runtime)['/api/v1/runtime'].GET;
    const url = new URL('http://localhost/api/v1/runtime');

    const response = await route(new Request(url), url);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

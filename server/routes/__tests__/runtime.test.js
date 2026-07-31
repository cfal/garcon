import { describe, expect, it } from 'bun:test';
import { isNoAuthHandler } from '../../lib/http-route.js';
import { createRuntimeRoutes } from '../runtime.js';

describe('runtime route', () => {
  it('exposes only the public instance identity without authentication', async () => {
    const probe = { schemaVersion: 1, instanceId: 'instance-1' };
    const route = createRuntimeRoutes(probe)['/api/v1/runtime'].GET;

    const response = await route(new Request('http://localhost/api/v1/runtime'), new URL('http://localhost/api/v1/runtime'));

    expect(isNoAuthHandler(route)).toBe(true);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(probe);
  });
});

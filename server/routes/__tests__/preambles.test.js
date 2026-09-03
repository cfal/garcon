import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import { PreambleDomainError } from '../../preambles/errors.ts';
import createPreambleRoutes from '../preambles.ts';

const emptySnapshot = { revision: 0, preambles: [] };

async function call(handler, body, method) {
  parseJsonBody.mockResolvedValueOnce(body);
  const response = await handler(new Request('http://localhost/test', { method }));
  return { response, body: await response.json() };
}

function service() {
  return {
    snapshot: mock(() => emptySnapshot),
    create: mock(() => Promise.resolve({ revision: 1, preambles: [] })),
    update: mock(() => Promise.resolve({ revision: 2, preambles: [] })),
    remove: mock(() => Promise.resolve({ revision: 3, preambles: [] })),
    reorder: mock(() => Promise.resolve({ revision: 4, preambles: [] })),
  };
}

describe('preamble routes', () => {
  beforeEach(() => parseJsonBody.mockClear());

  it('returns snapshots and exact typed mutation envelopes', async () => {
    const preambles = service();
    const routes = createPreambleRoutes(preambles);
    const get = await routes['/api/v1/preambles'].GET(
      new Request('http://localhost/api/v1/preambles'),
    );
    expect(await get.json()).toEqual(emptySnapshot);

    const definition = {
      title: 'Repository conventions',
      content: 'Follow the repository conventions.',
      scope: { type: 'global' },
    };
    const created = await call(
      routes['/api/v1/preambles'].POST,
      { expectedRevision: 0, preamble: definition },
      'POST',
    );
    expect(created.response.status).toBe(201);
    expect(created.body).toEqual({
      success: true,
      snapshot: { revision: 1, preambles: [] },
    });
    expect(preambles.create).toHaveBeenCalledWith({
      expectedRevision: 0,
      preamble: definition,
    });
  });

  it('forwards update, removal, and exact full-order mutations', async () => {
    const preambles = service();
    const routes = createPreambleRoutes(preambles);
    const definition = {
      title: 'Project conventions',
      content: 'Use the project rules.',
      scope: {
        type: 'project-paths',
        rules: [{ projectPath: '/workspace/project', includeNested: true }],
      },
    };

    await call(routes['/api/v1/preambles'].PUT, {
      expectedRevision: 1,
      id: 'preamble-a',
      preamble: definition,
    }, 'PUT');
    await call(routes['/api/v1/preambles'].DELETE, {
      expectedRevision: 2,
      id: 'preamble-a',
    }, 'DELETE');
    await call(routes['/api/v1/preambles/reorder'].PUT, {
      expectedRevision: 3,
      orderedPreambleIds: ['preamble-b', 'preamble-a'],
    }, 'PUT');

    expect(preambles.update).toHaveBeenCalledWith({
      expectedRevision: 1,
      id: 'preamble-a',
      preamble: definition,
    });
    expect(preambles.remove).toHaveBeenCalledWith({
      expectedRevision: 2,
      id: 'preamble-a',
    });
    expect(preambles.reorder).toHaveBeenCalledWith({
      expectedRevision: 3,
      orderedPreambleIds: ['preamble-b', 'preamble-a'],
    });
  });

  it('rejects malformed and extra request fields before calling the service', async () => {
    const preambles = service();
    const routes = createPreambleRoutes(preambles);
    const malformed = await call(
      routes['/api/v1/preambles'].POST,
      { expectedRevision: 0, preamble: {}, extra: true },
      'POST',
    );
    const nonStringOrder = await call(
      routes['/api/v1/preambles/reorder'].PUT,
      { expectedRevision: 0, orderedPreambleIds: ['a', 2] },
      'PUT',
    );

    expect(malformed.response.status).toBe(400);
    expect(nonStringOrder.response.status).toBe(400);
    expect(preambles.create).not.toHaveBeenCalled();
    expect(preambles.reorder).not.toHaveBeenCalled();
  });

  it('preserves domain status, code, and retryability', async () => {
    const preambles = service();
    preambles.update.mockRejectedValueOnce(new PreambleDomainError(
      'PREAMBLE_REVISION_CONFLICT',
      'Refresh and try again',
      409,
      true,
    ));
    const routes = createPreambleRoutes(preambles);
    const result = await call(routes['/api/v1/preambles'].PUT, {
      expectedRevision: 2,
      id: 'preamble-a',
      preamble: { invalid: true },
    }, 'PUT');

    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({
      errorCode: 'PREAMBLE_REVISION_CONFLICT',
      retryable: true,
    });
  });
});

import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => Promise.resolve({})),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import createSnippetRoutes from '../snippets.ts';
import { SnippetDomainError } from '../../snippets/errors.ts';

const emptySnapshot = { revision: 0, snippets: [] };

async function call(handler, body, method) {
  parseJsonBody.mockResolvedValueOnce(body);
  const response = await handler(
    new Request('http://localhost/test', { method }),
  );
  return { response, body: await response.json() };
}

function service() {
  return {
    snapshot: mock(() => emptySnapshot),
    create: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    update: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    remove: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    reorder: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    expand: mock(() =>
      Promise.resolve({
        success: true,
        snippetId: 'snippet-a',
        snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
        shortName: 'review',
        contextProjectPath: '/repo',
        expandedText: 'Review',
      }),
    ),
  };
}

describe('snippet routes', () => {
  beforeEach(() => parseJsonBody.mockClear());

  it('returns snapshots and typed create envelopes', async () => {
    const snippets = service();
    const routes = createSnippetRoutes(snippets);
    const get = await routes['/api/v1/snippets'].GET(
      new Request('http://localhost/api/v1/snippets'),
    );
    expect(await get.json()).toEqual(emptySnapshot);

    const definition = { shortName: 'review', template: 'Review' };
    const created = await call(
      routes['/api/v1/snippets'].POST,
      { expectedRevision: 0, snippet: definition },
      'POST',
    );
    expect(created.response.status).toBe(201);
    expect(created.body).toEqual({
      success: true,
      snapshot: { revision: 1, snippets: [] },
    });
    expect(snippets.create).toHaveBeenCalledWith({
      expectedRevision: 0,
      snippet: definition,
    });
  });

  it('forwards exact expansion requests', async () => {
    const snippets = service();
    const routes = createSnippetRoutes(snippets);
    const request = {
      shortName: 'review',
      arguments: 'contracts',
      context: { type: 'chat', chatId: 'chat-a' },
    };
    const result = await call(
      routes['/api/v1/snippets/expand'].POST,
      request,
      'POST',
    );
    expect(result.response.status).toBe(200);
    expect(snippets.expand).toHaveBeenCalledWith(request);
    expect(result.body).toEqual({
      success: true,
      snippetId: 'snippet-a',
      snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
      shortName: 'review',
      contextProjectPath: '/repo',
      expandedText: 'Review',
    });
  });

  it('preserves domain error status, code, and retryability', async () => {
    const snippets = service();
    snippets.update.mockRejectedValueOnce(
      new SnippetDomainError('SNIPPET_REVISION_CONFLICT', 'Refresh', 409, true),
    );
    const routes = createSnippetRoutes(snippets);
    const result = await call(
      routes['/api/v1/snippets'].PUT,
      {
        expectedRevision: 1,
        id: 'snippet-a',
        snippet: { shortName: 'review', template: 'x' },
      },
      'PUT',
    );
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({
      errorCode: 'SNIPPET_REVISION_CONFLICT',
      retryable: true,
    });
  });

  it('rejects malformed reorder shells before the service', async () => {
    const snippets = service();
    const routes = createSnippetRoutes(snippets);
    const result = await call(
      routes['/api/v1/snippets/reorder'].PUT,
      { expectedRevision: 1, orderedSnippetIds: ['a', 2] },
      'PUT',
    );
    expect(result.response.status).toBe(400);
    expect(snippets.reorder).not.toHaveBeenCalled();
  });
});

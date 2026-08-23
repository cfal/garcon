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
  const response = await handler(new Request('http://localhost/test', { method }));
  return { response, body: await response.json() };
}

function service() {
  return {
    snapshot: mock(() => emptySnapshot),
    create: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    update: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
    remove: mock(() => Promise.resolve({ revision: 1, snippets: [] })),
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

    const definition = {
      shortName: 'review',
      template: 'Review',
      defaultArguments: '',
    };
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

  it('forwards omitted and explicit-empty expansion requests exactly', async () => {
    const snippets = service();
    const routes = createSnippetRoutes(snippets);
    const omittedRequest = {
      shortName: 'review',
      arguments: { type: 'default' },
      context: { type: 'chat', chatId: '1787471053739199' },
    };
    const result = await call(routes['/api/v1/snippets/expand'].POST, omittedRequest, 'POST');
    expect(result.response.status).toBe(200);
    expect(snippets.expand).toHaveBeenCalledWith(omittedRequest);
    expect(result.body).toEqual({
      success: true,
      snippetId: 'snippet-a',
      snippetUpdatedAt: '2026-01-01T00:00:00.000Z',
      shortName: 'review',
      contextProjectPath: '/repo',
      expandedText: 'Review',
    });

    const explicitEmptyRequest = {
      shortName: 'review',
      arguments: { type: 'value', value: '' },
      context: {
        type: 'new-chat',
        chatId: '1787471053739200',
        projectPath: '/repo',
      },
    };
    await call(routes['/api/v1/snippets/expand'].POST, explicitEmptyRequest, 'POST');
    expect(snippets.expand).toHaveBeenLastCalledWith(explicitEmptyRequest);
  });

  it('preserves validation envelopes for pre-default and malformed argument variants', async () => {
    const snippets = service();
    snippets.expand.mockRejectedValue(
      new SnippetDomainError('SNIPPET_VALIDATION_FAILED', 'Invalid snippet request', 400),
    );
    const routes = createSnippetRoutes(snippets);

    for (const argumentsInput of ['', { type: 'unknown' }]) {
      const result = await call(
        routes['/api/v1/snippets/expand'].POST,
        {
          shortName: 'review',
          arguments: argumentsInput,
          context: { type: 'chat', chatId: '1787471053739199' },
        },
        'POST',
      );
      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({
        errorCode: 'SNIPPET_VALIDATION_FAILED',
      });
    }
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
        snippet: { shortName: 'review', template: 'x', defaultArguments: '' },
      },
      'PUT',
    );
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({
      errorCode: 'SNIPPET_REVISION_CONFLICT',
      retryable: true,
    });
  });
});

import { describe, expect, it, mock } from 'bun:test';
import { isNoAuthHandler } from '../../lib/http-route.js';
import createPromptRefinementRoutes from '../prompt-refinement.js';

function dependencies() {
  return {
    settings: {
      getUiSettings: mock(() => ({
        promptRefinement: {
          agentId: 'claude',
          model: 'opus',
          thinkingMode: 'none',
        },
      })),
    },
    agents: {
      getAgentAuthStatusMap: mock(() => Promise.resolve({})),
      getAgentReadinessMap: mock(() => Promise.resolve({})),
      getAgentCatalogEntries: mock(() => Promise.resolve([])),
      getModels: mock(() => Promise.resolve([])),
      singleQueryRunsToolsWithoutPermission: mock(() => false),
      runSingleQuery: mock(() => Promise.resolve('Refined request')),
    },
  };
}

function request(body) {
  return new Request('http://localhost/api/v1/prompts/refine', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(routes, input, server) {
  const handler = routes['/api/v1/prompts/refine'].POST;
  const response = await handler(request(input), new URL('http://localhost/api/v1/prompts/refine'), server);
  return { response, body: await response.json() };
}

describe('prompt refinement routes', () => {
  it('keeps the endpoint authenticated and returns the typed response', async () => {
    const deps = dependencies();
    const routes = createPromptRefinementRoutes(deps);
    const handler = routes['/api/v1/prompts/refine'].POST;
    expect(isNoAuthHandler(handler)).toBe(false);

    const result = await post(routes, { draft: 'rough request' });
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ success: true, refinedPrompt: 'Refined request' });
    expect(deps.agents.runSingleQuery).toHaveBeenCalledTimes(1);
  });

  it('returns structured validation and provider errors without raw details', async () => {
    const deps = dependencies();
    const routes = createPromptRefinementRoutes(deps);
    const invalid = await post(routes, { draft: ' ' });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toMatchObject({
      success: false,
      errorCode: 'PROMPT_REFINEMENT_INVALID_REQUEST',
      retryable: false,
    });

    deps.agents.runSingleQuery.mockRejectedValueOnce(new Error('private provider detail'));
    const failed = await post(routes, { draft: 'rough request' });
    expect(failed.response.status).toBe(502);
    expect(failed.body).toMatchObject({
      success: false,
      errorCode: 'PROMPT_REFINEMENT_FAILED',
      retryable: true,
    });
    expect(JSON.stringify(failed.body)).not.toContain('private provider detail');
  });

  it('applies its request limiter before parsing or invoking the model', async () => {
    const deps = dependencies();
    const limited = Response.json({
      success: false,
      error: 'Too many requests.',
      errorCode: 'RATE_LIMITED',
      retryable: true,
    }, { status: 429 });
    const limiter = { check: mock(() => limited) };
    const routes = createPromptRefinementRoutes(deps, { limiter });
    const server = { requestIP: mock(() => ({ address: '127.0.0.1' })) };

    const result = await post(routes, '{ malformed', server);
    expect(result.response.status).toBe(429);
    expect(limiter.check).toHaveBeenCalledTimes(1);
    expect(deps.settings.getUiSettings).not.toHaveBeenCalled();
    expect(deps.agents.runSingleQuery).not.toHaveBeenCalled();
  });
});

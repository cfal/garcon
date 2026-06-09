import { beforeEach, describe, expect, it, mock } from 'bun:test';

const parseJsonBody = mock(() => Promise.resolve({}));

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
}));

import createAgentOrchestrationRoutes from '../agent-orchestrations.ts';

describe('agent orchestration routes', () => {
  const orchestration = {
    id: 'orch-1',
    parentChatId: 'parent',
    createdAt: '2026-06-07T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
    status: 'running',
    concurrencyLimit: 2,
    children: [],
  };
  const orchestrator = {
    spawn: mock(() => Promise.resolve(orchestration)),
    list: mock(() => [orchestration]),
    get: mock(() => orchestration),
    wait: mock(() => Promise.resolve({ orchestration, timedOut: false })),
    abort: mock(() => Promise.resolve({ ...orchestration, status: 'aborted' })),
  };
  const routes = createAgentOrchestrationRoutes(orchestrator);

  beforeEach(() => {
    parseJsonBody.mockClear();
    for (const fn of Object.values(orchestrator)) fn.mockClear();
  });

  it('spawns an orchestration through the REST contract', async () => {
    parseJsonBody.mockResolvedValueOnce({
      parentChatId: 'parent',
      concurrencyLimit: 2,
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    });

    const response = await routes['/api/v1/agents/orchestrations'].POST(
      new Request('http://localhost/api/v1/agents/orchestrations', { method: 'POST' }),
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(orchestrator.spawn).toHaveBeenCalledWith({
      parentChatId: 'parent',
      concurrencyLimit: 2,
      tasks: [{ taskName: 'inspect_api', prompt: 'Inspect the API shape.' }],
    });
    expect(body).toEqual({ success: true, orchestration });
  });

  it('lists orchestrations filtered by parentChatId', async () => {
    const url = new URL('http://localhost/api/v1/agents/orchestrations?parentChatId=parent');

    const response = await routes['/api/v1/agents/orchestrations'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(orchestrator.list).toHaveBeenCalledWith('parent');
    expect(body).toEqual({ success: true, orchestrations: [orchestration] });
  });

  it('returns one orchestration by id', async () => {
    const url = new URL('http://localhost/api/v1/agents/orchestrations?orchestrationId=orch-1');

    const response = await routes['/api/v1/agents/orchestrations'].GET(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(orchestrator.get).toHaveBeenCalledWith('orch-1');
    expect(body).toEqual({ success: true, orchestration });
  });

  it('waits for orchestration children', async () => {
    parseJsonBody.mockResolvedValueOnce({ orchestrationId: 'orch-1', childIds: ['child-1'], timeoutMs: 10 });

    const response = await routes['/api/v1/agents/orchestrations/wait'].POST(
      new Request('http://localhost/api/v1/agents/orchestrations/wait', { method: 'POST' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(orchestrator.wait).toHaveBeenCalledWith({
      orchestrationId: 'orch-1',
      childIds: ['child-1'],
      timeoutMs: 10,
    });
    expect(body).toEqual({ success: true, orchestration, timedOut: false });
  });

  it('aborts orchestration children', async () => {
    parseJsonBody.mockResolvedValueOnce({ orchestrationId: 'orch-1', childIds: ['child-1'] });

    const response = await routes['/api/v1/agents/orchestrations/abort'].POST(
      new Request('http://localhost/api/v1/agents/orchestrations/abort', { method: 'POST' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(orchestrator.abort).toHaveBeenCalledWith({ orchestrationId: 'orch-1', childIds: ['child-1'] });
    expect(body.orchestration.status).toBe('aborted');
  });
});

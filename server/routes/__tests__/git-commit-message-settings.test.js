import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.js';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => Promise.resolve({}));
const generateCommitMessageForFiles = mock(() =>
  Promise.resolve({ message: 'feat: generated', directoryPrefix: '' }),
);
mock.module('../../lib/http-request.js', () => ({ parseJsonBody, MalformedJsonError }));
mock.module('../../git/commit-generation.js', () => ({
  generateCommitMessageForFiles: (_agents, _git, request) => generateCommitMessageForFiles(request),
}));

import createGitRoutes from '../git.js';

const agents = {
  assertAgentAvailable: mock(() => undefined),
  getAgentAuthStatusMap: mock(() => Promise.resolve({
    claude: { authenticated: false },
    codex: { authenticated: false },
    opencode: { authenticated: false },
    amp: { authenticated: false },
    factory: { authenticated: false },
    'direct-anthropic-compatible': { authenticated: false },
    'direct-openai-compatible': { authenticated: false },
    'direct-openai-responses-compatible': { authenticated: false },
  })),
  getAgentReadinessMap: mock(() => Promise.resolve({})),
  getAgentCatalogEntries: mock(() => Promise.resolve([])),
  getModels: mock(() => Promise.resolve([])),
  hasAgent: mock((agentId) => ['claude', 'codex', 'opencode', 'amp', 'factory', 'direct-anthropic-compatible', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(agentId)),
  assertExecutionModeSelectionSupported: mock((agentId, selection) => {
    if (agentId === 'amp' && selection.thinkingMode !== undefined && selection.thinkingMode !== 'none') {
      throw new DomainError(
        'VALIDATION_FAILED',
        `Thinking mode ${selection.thinkingMode} is not supported by ${agentId}`,
        422,
      );
    }
  }),
  normalizeThinkingModeForAgent: mock((agentId, value) => agentId === 'amp' ? 'none' : value),
};

const settings = {
  getUiSettings: mock(() => ({})),
};

const repository = { collectCommitMessageContext: mock(async () => ({ diff: '+synthetic' })) };
const resolveGit = mock(async () => repository);
const routes = createGitRoutes(agents, settings, resolveGit);

function makeRequest(body, signal) {
  return new Request('http://localhost/api/v1/git/generate-commit-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

describe('POST /api/v1/git/generate-commit-message persisted settings', () => {
  const handler = routes['/api/v1/git/generate-commit-message'].POST;

  beforeEach(() => {
    agents.assertAgentAvailable.mockReset();
    agents.assertAgentAvailable.mockImplementation(() => undefined);
    parseJsonBody.mockClear();
    generateCommitMessageForFiles.mockClear();
    agents.getAgentAuthStatusMap.mockClear();
    agents.getAgentAuthStatusMap.mockImplementation(() => Promise.resolve({
      claude: { authenticated: false },
      codex: { authenticated: false },
      opencode: { authenticated: false },
      amp: { authenticated: false },
      factory: { authenticated: false },
      'direct-anthropic-compatible': { authenticated: false },
      'direct-openai-compatible': { authenticated: false },
      'direct-openai-responses-compatible': { authenticated: false },
    }));
    agents.getAgentReadinessMap.mockClear();
    agents.getAgentReadinessMap.mockImplementation(() => Promise.resolve({}));
    agents.getAgentCatalogEntries.mockClear();
    agents.getAgentCatalogEntries.mockImplementation(() => Promise.resolve([]));
    agents.getModels.mockClear();
    agents.hasAgent.mockClear();
    agents.hasAgent.mockImplementation((agentId) => ['claude', 'codex', 'opencode', 'amp', 'factory', 'direct-anthropic-compatible', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(agentId));
    agents.assertExecutionModeSelectionSupported.mockClear();
    agents.assertExecutionModeSelectionSupported.mockImplementation((agentId, selection) => {
      if (agentId === 'amp' && selection.thinkingMode !== undefined && selection.thinkingMode !== 'none') {
        throw new DomainError(
          'VALIDATION_FAILED',
          `Thinking mode ${selection.thinkingMode} is not supported by ${agentId}`,
          422,
        );
      }
    });
    agents.normalizeThinkingModeForAgent.mockClear();
    agents.normalizeThinkingModeForAgent.mockImplementation((agentId, value) => agentId === 'amp' ? 'none' : value);
    settings.getUiSettings.mockClear();
    settings.getUiSettings.mockImplementation(() => ({}));
    resolveGit.mockClear();
  });

  it('selects repository and explicit model nodes independently', async () => {
    const repositoryNode = '11111111-1111-4111-8111-111111111111';
    const generationNode = '22222222-2222-4222-8222-222222222222';
    parseJsonBody.mockResolvedValue({ nodeId: repositoryNode, project: '/node-only/project', files: ['file'], generationNodeId: generationNode, agentId: 'codex', model: 'synthetic' });
    const response = await handler(makeRequest({}));
    expect(response.status).toBe(200);
    expect(resolveGit).toHaveBeenCalledWith(repositoryNode);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith(expect.objectContaining({ nodeId: generationNode, projectPath: '/node-only/project' }));
  });

  it('reports an unavailable explicit generation node before reading the repository', async () => {
    const generationNode = '22222222-2222-4222-8222-222222222222';
    parseJsonBody.mockResolvedValue({ project: '/project', files: ['file'], generationNodeId: generationNode, agentId: 'codex', model: 'synthetic' });
    agents.hasAgent.mockReturnValue(false);
    agents.assertAgentAvailable.mockImplementation(() => {
      throw new DomainError('EXECUTION_NODE_UNAVAILABLE', 'Execution node is unavailable', 503, true);
    });
    const response = await handler(makeRequest({}));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'EXECUTION_NODE_UNAVAILABLE' });
    expect(agents.assertAgentAvailable).toHaveBeenCalledWith('codex', generationNode);
    expect(resolveGit).not.toHaveBeenCalled();
    expect(generateCommitMessageForFiles).not.toHaveBeenCalled();
  });

  it('keeps Auto generation Local for a remote repository', async () => {
    const repositoryNode = '11111111-1111-4111-8111-111111111111';
    parseJsonBody.mockResolvedValue({ nodeId: repositoryNode, project: '/node-only/project', files: ['file'] });
    const response = await handler(makeRequest({}));
    expect(response.status).toBe(200);
    expect(resolveGit).toHaveBeenCalledWith(repositoryNode);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'local' }));
  });

  it('normalizes stale persisted commit message effort when the request omits it', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
    }));
    settings.getUiSettings.mockImplementation(() => ({
      commitMessage: {
        agentId: 'amp',
        thinkingMode: 'high',
        customPrompt: 'Summarize {{files}}',
      },
    }));
    agents.getAgentCatalogEntries.mockImplementation(() => Promise.resolve([{
      id: 'amp',
      models: [{ value: 'smart', label: 'Smart' }],
      generation: { priority: 20, model: 'smart' },
    }]));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('feat: generated');
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      nodeId: 'local',
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'amp',
      model: 'smart',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      thinkingMode: 'none',
      customPrompt: 'Summarize {{files}}',
      useCommonDirPrefix: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('passes the persisted directory prefix setting', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
    }));
    settings.getUiSettings.mockImplementation(() => ({
      commitMessage: {
        agentId: 'claude',
        model: 'sonnet',
        useCommonDirPrefix: true,
      },
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      nodeId: 'local',
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'claude',
      model: 'sonnet',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      thinkingMode: 'none',
      customPrompt: '',
      useCommonDirPrefix: true,
      signal: expect.any(AbortSignal),
    });
  });

  it('prefers explicit request settings over persisted commit message settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'codex',
      model: 'gpt-5.4',
      customPrompt: '',
    }));
    settings.getUiSettings.mockImplementation(() => ({
      commitMessage: {
        agentId: 'amp',
        model: 'smart',
        customPrompt: 'Persisted prompt',
      },
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'codex',
      model: 'gpt-5.4',
      customPrompt: '',
    }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      nodeId: 'local',
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'codex',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      thinkingMode: 'none',
      customPrompt: '',
      useCommonDirPrefix: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('resets persisted effort when a legacy request overrides generation routing', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'amp',
      model: 'smart',
    }));
    settings.getUiSettings.mockImplementation(() => ({
      commitMessage: {
        agentId: 'claude',
        model: 'opus',
        thinkingMode: 'high',
      },
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'amp',
        model: 'smart',
        thinkingMode: 'none',
      }),
    );
  });

  it('accepts an explicit canonical effort with a legacy routing override', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'codex',
      model: 'gpt-5.4',
      thinkingMode: 'max',
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingMode: 'max' }),
    );
  });

  it('rejects an unsupported explicit effort for the selected agent', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'amp',
      model: 'medium',
      thinkingMode: 'high',
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.errorCode).toBe('VALIDATION_FAILED');
    expect(generateCommitMessageForFiles).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit effort', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      thinkingMode: 'extreme',
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));

    expect(response.status).toBe(400);
    expect(generateCommitMessageForFiles).not.toHaveBeenCalled();
  });

  it('passes API provider endpoint metadata through to generation', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-openai-compatible',
      model: 'glm-5.1',
      apiProviderId: 'zai',
      modelEndpointId: 'zai_openai',
      modelProtocol: 'openai-compatible',
      customPrompt: '',
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-openai-compatible',
      model: 'glm-5.1',
      apiProviderId: 'zai',
      modelEndpointId: 'zai_openai',
      modelProtocol: 'openai-compatible',
      customPrompt: '',
    }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      nodeId: 'local',
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-openai-compatible',
      model: 'glm-5.1',
      apiProviderId: 'zai',
      modelEndpointId: 'zai_openai',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'none',
      customPrompt: '',
      useCommonDirPrefix: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('passes Direct Anthropic endpoint metadata through to generation', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-anthropic-compatible',
      model: 'acme-sonnet',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
      modelProtocol: 'anthropic-messages',
      customPrompt: '',
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-anthropic-compatible',
      model: 'acme-sonnet',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
      modelProtocol: 'anthropic-messages',
      customPrompt: '',
    }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      nodeId: 'local',
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'direct-anthropic-compatible',
      model: 'acme-sonnet',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
      modelProtocol: 'anthropic-messages',
      thinkingMode: 'none',
      customPrompt: '',
      useCommonDirPrefix: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('stops automatic configuration discovery when the request is cancelled', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
    }));
    let markDiscoveryStarted;
    const discoveryStarted = new Promise((resolve) => {
      markDiscoveryStarted = resolve;
    });
    agents.getAgentAuthStatusMap.mockImplementation(() => {
      markDiscoveryStarted();
      return new Promise(() => {});
    });
    agents.getAgentCatalogEntries.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();

    const generation = handler(makeRequest(
      { project: '/proj', files: ['src/a.ts'] },
      controller.signal,
    ));
    await discoveryStarted;
    controller.abort(new DOMException('request cancelled', 'AbortError'));

    const response = await generation;
    expect(response.status).toBe(500);
    expect(generateCommitMessageForFiles).not.toHaveBeenCalled();
  });
});

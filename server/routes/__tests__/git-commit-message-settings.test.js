import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { DomainError } from '../../lib/domain-error.js';
import { createLocalWorkspaceGitService } from '../../execution-node/local-workspace-git.js';
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from '../../../common/generation-prompts.js';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => Promise.resolve({}));
const diffContext = 'synthetic staged diff';
const canonicalProjectPath = '/owner/canonical-project';
const captureCommitMessageSource = mock(async ({ files }) => ({
  projectPath: canonicalProjectPath, files: [...files], diffContext,
}));
/** @satisfies {import('../../execution-nodes/workspace-git.js').WorkspaceGitService} */
const git = {
  ...createLocalWorkspaceGitService({
    assertProjectPathAllowed: async () => { throw new Error('Unexpected filesystem operation'); },
    networkTimeoutMs: 30_000,
  }),
  captureCommitMessageSource,
};

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

import createGitRoutes from '../git.js';

const agents = {
  runSingleQuery: mock(async () => 'feat: generated'),
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

const routes = createGitRoutes(git, agents, settings);

function makeRequest(body, signal) {
  return new Request('http://localhost/api/v1/git/generate-commit-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

function expectGeneration({
  projectPath, files, agentId, model, apiProviderId, modelEndpointId, modelProtocol,
  thinkingMode, customPrompt, signal,
}) {
  expect(captureCommitMessageSource).toHaveBeenCalledTimes(1);
  expect(captureCommitMessageSource).toHaveBeenCalledWith({ projectPath, files, signal });
  const capturedSignal = captureCommitMessageSource.mock.calls[0][0].signal;
  const template = customPrompt?.trim() ? customPrompt : DEFAULT_COMMIT_MESSAGE_PROMPT;
  const prompt = template.replaceAll('{{files}}', () => files.map((file) => '- ' + file).join('\n'))
    .replaceAll('{{diff}}', () => diffContext);
  expect(agents.runSingleQuery).toHaveBeenCalledWith(prompt, {
    agentId, cwd: canonicalProjectPath, thinkingMode, timeoutMs: 110_000, signal: capturedSignal,
    ...(model ? { model } : {}),
    ...(apiProviderId ? { apiProviderId } : {}),
    ...(modelEndpointId ? { modelEndpointId } : {}),
    ...(modelProtocol ? { modelProtocol } : {}),
  });
}

describe('POST /api/v1/git/generate-commit-message persisted settings', () => {
  const handler = routes['/api/v1/git/generate-commit-message'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    captureCommitMessageSource.mockClear();
    agents.runSingleQuery.mockClear();
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
    expectGeneration({
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
    expect(await response.json()).toEqual({ message: 'a.ts: feat: generated', directoryPrefix: 'a.ts' });
    expectGeneration({
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
    expectGeneration({
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
    expect(agents.runSingleQuery).toHaveBeenCalledWith(
      expect.any(String),
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
    expect(agents.runSingleQuery).toHaveBeenCalledWith(
      expect.any(String),
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
    expect(captureCommitMessageSource).not.toHaveBeenCalled();
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit effort', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      thinkingMode: 'extreme',
    }));

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));

    expect(response.status).toBe(400);
    expect(captureCommitMessageSource).not.toHaveBeenCalled();
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
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
    expectGeneration({
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
    expectGeneration({
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
    expect(captureCommitMessageSource).not.toHaveBeenCalled();
    expect(agents.runSingleQuery).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => Promise.resolve({}));
const generateCommitMessageForFiles = mock(() =>
  Promise.resolve({ message: 'feat: generated', directoryPrefix: '' }),
);
const assertRealWithinProjectBase = mock((targetPath) => Promise.resolve(targetPath));
const isProjectBoundaryError = mock(() => false);

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

mock.module('../../lib/path-boundary.ts', () => ({
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse: mock(() => Response.json({ error: 'boundary' }, { status: 403 })),
}));

mock.module('../../git/git-service.js', () => ({
  createGitService: mock(() => ({
    generateCommitMessageForFiles,
    toHttpError: (error) => Response.json({ error: error.message }, { status: error.status || 500 }),
  })),
}));

import createGitRoutes from '../git.js';

const agents = {
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
};

const settings = {
  getUiSettings: mock(() => ({})),
};

const routes = createGitRoutes(agents, settings);

function makeRequest(body) {
  return new Request('http://localhost/api/v1/git/generate-commit-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/git/generate-commit-message persisted settings', () => {
  const handler = routes['/api/v1/git/generate-commit-message'].POST;

  beforeEach(() => {
    parseJsonBody.mockClear();
    generateCommitMessageForFiles.mockClear();
    agents.getAgentAuthStatusMap.mockClear();
    agents.getAgentReadinessMap.mockClear();
    agents.getAgentCatalogEntries.mockClear();
    agents.getModels.mockClear();
    agents.hasAgent.mockClear();
    agents.hasAgent.mockImplementation((agentId) => ['claude', 'codex', 'opencode', 'amp', 'factory', 'direct-anthropic-compatible', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(agentId));
    settings.getUiSettings.mockClear();
    settings.getUiSettings.mockImplementation(() => ({}));
    assertRealWithinProjectBase.mockClear();
    assertRealWithinProjectBase.mockImplementation((targetPath) => Promise.resolve(targetPath));
    isProjectBoundaryError.mockClear();
    isProjectBoundaryError.mockImplementation(() => false);
  });

  it('uses persisted commit message settings when the request omits them', async () => {
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

    const response = await handler(makeRequest({ project: '/proj', files: ['src/a.ts'] }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('feat: generated');
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      projectPath: '/proj',
      files: ['src/a.ts'],
      agentId: 'amp',
      model: 'smart',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      thinkingMode: 'high',
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
});

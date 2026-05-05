import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => Promise.resolve({}));
const generateCommitMessageForFiles = mock(() => Promise.resolve({ message: 'feat: generated' }));

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

mock.module('../../git/git-service.js', () => ({
  createGitService: mock(() => ({
    generateCommitMessageForFiles,
    toHttpError: (error) => Response.json({ error: error.message }, { status: error.status || 500 }),
  })),
}));

import createGitRoutes from '../git.js';

const providers = {
  getHarnessAuthStatusMap: mock(() => Promise.resolve({
    claude: { authenticated: false },
    codex: { authenticated: false },
    opencode: { authenticated: false },
    amp: { authenticated: false },
    factory: { authenticated: false },
    'direct-anthropic-compatible': { authenticated: false },
    'direct-openai-compatible': { authenticated: false },
    'direct-openai-responses-compatible': { authenticated: false },
  })),
  getModels: mock(() => Promise.resolve([])),
  hasHarness: mock((harnessId) => ['claude', 'codex', 'opencode', 'amp', 'factory', 'direct-anthropic-compatible', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(harnessId)),
};

const settings = {
  getUiSettings: mock(() => Promise.resolve({})),
};

const routes = createGitRoutes(providers, settings);

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
    providers.getHarnessAuthStatusMap.mockClear();
    providers.getModels.mockClear();
    providers.hasHarness.mockClear();
    providers.hasHarness.mockImplementation((harnessId) => ['claude', 'codex', 'opencode', 'amp', 'factory', 'direct-anthropic-compatible', 'direct-openai-compatible', 'direct-openai-responses-compatible'].includes(harnessId));
    settings.getUiSettings.mockClear();
  });

  it('uses persisted commit message settings when the request omits them', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
    }));
    settings.getUiSettings.mockImplementation(() => Promise.resolve({
      commitMessage: {
        enabled: true,
        provider: 'amp',
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
      provider: 'amp',
      model: 'smart',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      customPrompt: 'Summarize {{files}}',
    });
  });

  it('prefers explicit request settings over persisted commit message settings', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'codex',
      model: 'gpt-5.4',
      customPrompt: '',
    }));
    settings.getUiSettings.mockImplementation(() => Promise.resolve({
      commitMessage: {
        enabled: true,
        provider: 'amp',
        model: 'smart',
        customPrompt: 'Persisted prompt',
      },
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'codex',
      model: 'gpt-5.4',
      customPrompt: '',
    }));

    expect(response.status).toBe(200);
    expect(generateCommitMessageForFiles).toHaveBeenCalledWith({
      projectPath: '/proj',
      files: ['src/a.ts'],
      provider: 'codex',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      customPrompt: '',
    });
  });

  it('passes API provider endpoint metadata through to generation', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'direct-openai-compatible',
      model: 'glm-5.1',
      apiProviderId: 'zai',
      modelEndpointId: 'zai_openai',
      modelProtocol: 'openai-compatible',
      customPrompt: '',
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'direct-openai-compatible',
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
      provider: 'direct-openai-compatible',
      model: 'glm-5.1',
      apiProviderId: 'zai',
      modelEndpointId: 'zai_openai',
      modelProtocol: 'openai-compatible',
      customPrompt: '',
    });
  });

  it('passes Direct Anthropic endpoint metadata through to generation', async () => {
    parseJsonBody.mockImplementation(() => Promise.resolve({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'direct-anthropic-compatible',
      model: 'acme-sonnet',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
      modelProtocol: 'anthropic-messages',
      customPrompt: '',
    }));

    const response = await handler(makeRequest({
      project: '/proj',
      files: ['src/a.ts'],
      provider: 'direct-anthropic-compatible',
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
      provider: 'direct-anthropic-compatible',
      model: 'acme-sonnet',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
      modelProtocol: 'anthropic-messages',
      customPrompt: '',
    });
  });
});

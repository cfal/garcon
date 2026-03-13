import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

const parseJsonBody = mock(() => Promise.resolve({}));
const generateCommitMessageForFiles = mock(() => Promise.resolve({ message: 'feat: generated' }));

mock.module('../../lib/http-native.js', () => ({
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
  getAuthStatusMap: mock(() => Promise.resolve({
    claude: { authenticated: false },
    codex: { authenticated: false },
    opencode: { authenticated: false },
    amp: { authenticated: false },
  })),
  getModels: mock(() => Promise.resolve([])),
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
    providers.getAuthStatusMap.mockClear();
    providers.getModels.mockClear();
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
      model: 'default',
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
        model: 'default',
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
      customPrompt: '',
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const getClaudeBinary = mock(() => 'claude');

mock.module('../../config.js', () => ({
  getClaudeBinary,
}));

import { getClaudeAuthStatus } from '../claude-auth.js';

function createFakeProc({ stdout = '', stderr = '', exitCode = 0 }) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exited: Promise.resolve(exitCode),
  };
}

describe('getClaudeAuthStatus', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  let originalSpawn;
  let spawnMock;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;
    getClaudeBinary.mockReset();
    getClaudeBinary.mockReturnValue('/tmp/custom-claude');

    if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  });

  it('uses the configured Claude binary and returns the OAuth email from auth status', async () => {
    spawnMock.mockReturnValue(createFakeProc({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'person@example.com',
      }),
    }));

    expect(await getClaudeAuthStatus()).toEqual({
      authenticated: true,
      canReauth: true,
      label: 'person@example.com',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, options] = spawnMock.mock.calls[0];
    expect(command).toEqual(['/tmp/custom-claude', 'auth', 'status']);
    expect(options.stdin).toBe('ignore');
    expect(options.stdout).toBe('pipe');
    expect(options.stderr).toBe('pipe');
  });

  it('treats API key auth as connected without reauth even when the CLI prints warnings', async () => {
    spawnMock.mockReturnValue(createFakeProc({
      stderr: `warning: using fallback\n${JSON.stringify({ loggedIn: true, authMethod: 'api_key' })}`,
    }));

    expect(await getClaudeAuthStatus()).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });

  it('short-circuits ANTHROPIC_API_KEY without spawning the CLI', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    expect(await getClaudeAuthStatus()).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('short-circuits ANTHROPIC_BASE_URL without spawning the CLI', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:11434';

    expect(await getClaudeAuthStatus()).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

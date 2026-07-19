import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getCodexAuthStatus } from '../codex-auth.js';

function createFakeProc({ stdout = '', stderr = '', exitCode = 0 }) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exited: Promise.resolve(exitCode),
  };
}

function createJwtPayload(payload) {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}

describe('getCodexAuthStatus', () => {
  let originalSpawn;
  let spawnMock;
  let tempDir;
  let codexHome;
  let openAiApiKey;
  let openAiBaseUrl;
  const config = {
    openAiApiKey: () => openAiApiKey,
    openAiBaseUrl: () => openAiBaseUrl,
    home: () => codexHome,
    packageVersion: () => 'test',
  };

  beforeEach(async () => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-auth-'));
    codexHome = tempDir;
    openAiApiKey = null;
    openAiBaseUrl = null;
  });

  afterEach(async () => {
    Bun.spawn = originalSpawn;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('uses codex login status and reads the label from CODEX_HOME auth.json', async () => {
    codexHome = path.join(tempDir, 'custom-codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: createJwtPayload({ email: 'person@example.com' }),
      },
    }));
    spawnMock.mockReturnValue(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: true,
      label: 'person@example.com',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, options] = spawnMock.mock.calls[0];
    expect(command).toEqual(['codex', 'login', 'status']);
    expect(options.stdin).toBe('ignore');
    expect(options.stdout).toBe('pipe');
    expect(options.stderr).toBe('pipe');
  });

  it('treats API key auth as connected without reauth even with warning output', async () => {
    spawnMock.mockReturnValue(createFakeProc({
      stderr: 'warning: helper install skipped\nLogged in using an API key - sk-proj-***12345\n',
    }));

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });

  it('short-circuits OPENAI_API_KEY without spawning the CLI', async () => {
    openAiApiKey = 'test-key';

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('short-circuits OPENAI_BASE_URL without spawning the CLI', async () => {
    openAiBaseUrl = 'http://localhost:11434/v1';

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

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
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalCodexHome = process.env.CODEX_HOME;
  let originalSpawn;
  let spawnMock;
  let tempDir;

  beforeEach(async () => {
    originalSpawn = Bun.spawn;
    spawnMock = mock();
    Bun.spawn = spawnMock;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-codex-auth-'));
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  afterEach(async () => {
    Bun.spawn = originalSpawn;
    if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('uses codex login status and reads the label from CODEX_HOME auth.json', async () => {
    const codexHome = path.join(tempDir, 'custom-codex-home');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        id_token: createJwtPayload({ email: 'person@example.com' }),
      },
    }));
    process.env.CODEX_HOME = codexHome;
    spawnMock.mockReturnValue(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));

    expect(await getCodexAuthStatus()).toEqual({
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

    expect(await getCodexAuthStatus()).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
  });

  it('short-circuits OPENAI_API_KEY without spawning the CLI', async () => {
    process.env.OPENAI_API_KEY = 'test-key';

    expect(await getCodexAuthStatus()).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodexLoginStatusCommand,
  createCodexAuthStatusResolver,
  getCodexAuthStatus,
  resolveCodexExecAuthStatus,
} from '../codex-auth.js';

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
  let codexApiKey;
  let openAiApiKey;
  let openAiBaseUrl;
  const config = {
    codexApiKey: () => codexApiKey,
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
    codexApiKey = null;
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
      kind: 'chatgpt',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, options] = spawnMock.mock.calls[0];
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toEndWith('/node_modules/.bin/codex');
    expect(command.slice(2)).toEqual(['login', 'status']);
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
      kind: 'api-key',
    });
  });

  it('uses an unopposed OPENAI_API_KEY when no stored login exists', async () => {
    openAiApiKey = 'test-key';
    spawnMock.mockReturnValue(createFakeProc({
      stderr: 'Not logged in\n',
      exitCode: 1,
    }));

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
      kind: 'api-key',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('initializes a fresh CODEX_HOME before checking login status', async () => {
    codexHome = path.join(tempDir, 'fresh-codex-home');
    spawnMock.mockImplementation(() => {
      expect(existsSync(codexHome)).toBe(true);
      return createFakeProc({ stderr: 'Not logged in\n', exitCode: 1 });
    });

    await expect(getCodexAuthStatus(config)).resolves.toMatchObject({ kind: 'none' });
    await expect(fs.stat(codexHome)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('invokes a bundled Windows batch shim directly', () => {
    expect(buildCodexLoginStatusCommand(
      { command: 'C:\\repo\\node_modules\\.bin\\codex.cmd', source: 'bundled' },
      { platform: 'win32', executable: 'C:\\bun.exe' },
    )).toEqual([
      'C:\\repo\\node_modules\\.bin\\codex.cmd',
      'login',
      'status',
    ]);
  });

  it('does not let an incidental OPENAI_API_KEY override stored ChatGPT auth', async () => {
    openAiApiKey = 'test-key';
    spawnMock.mockReturnValue(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));

    expect(await getCodexAuthStatus(config)).toMatchObject({
      authenticated: true,
      canReauth: true,
      kind: 'chatgpt',
    });
  });

  it('uses CODEX_API_KEY for exec without changing stored app-server auth', async () => {
    codexApiKey = 'codex-test-key';
    spawnMock.mockReturnValue(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));
    const storedStatus = await getCodexAuthStatus(config);

    expect(storedStatus.kind).toBe('chatgpt');
    expect(await resolveCodexExecAuthStatus(config, async () => storedStatus)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
      kind: 'api-key',
    });
  });

  it('short-circuits OPENAI_BASE_URL without spawning the CLI', async () => {
    openAiBaseUrl = 'http://localhost:11434/v1';

    expect(await getCodexAuthStatus(config)).toEqual({
      authenticated: true,
      canReauth: false,
      label: '',
      kind: 'external',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('caches auth classification until explicitly refreshed or invalidated', async () => {
    spawnMock.mockReturnValue(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));
    const resolver = createCodexAuthStatusResolver(config);

    await resolver.current();
    await resolver.current();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await resolver.refresh();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    resolver.invalidate();
    await resolver.current();
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('retries after the login status process fails to spawn', async () => {
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error('transient EAGAIN');
      })
      .mockReturnValueOnce(createFakeProc({ stderr: 'Logged in using an API key\n' }));
    const resolver = createCodexAuthStatusResolver(config);

    await expect(resolver.current()).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE',
      retryable: true,
    });
    await expect(resolver.current()).resolves.toMatchObject({ kind: 'api-key' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('retries after an unexpected login status exit', async () => {
    spawnMock
      .mockReturnValueOnce(createFakeProc({
        stderr: 'Error checking login status: keyring temporarily unavailable',
        exitCode: 1,
      }))
      .mockReturnValueOnce(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));
    const resolver = createCodexAuthStatusResolver(config);

    await expect(resolver.current()).rejects.toMatchObject({
      code: 'PROVIDER_FAILURE',
      retryable: true,
    });
    await expect(resolver.current()).resolves.toMatchObject({ kind: 'chatgpt' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('terminates a stalled auth probe when its caller is cancelled', async () => {
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    const kill = mock(() => finish(1));
    spawnMock.mockReturnValue({
      stdout: null,
      stderr: null,
      exited,
      killed: false,
      kill,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = getCodexAuthStatus(config, { signal: controller.signal });
    while (spawnMock.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(spawnMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('bounds stalled probes and retries after a failed lookup', async () => {
    let finish;
    const exited = new Promise((resolve) => {
      finish = resolve;
    });
    spawnMock
      .mockReturnValueOnce({
        stdout: null,
        stderr: null,
        exited,
        killed: false,
        kill: () => finish(1),
      })
      .mockReturnValueOnce(createFakeProc({ stderr: 'Logged in using ChatGPT\n' }));
    const resolver = createCodexAuthStatusResolver(config, { probeTimeoutMs: 20 });

    await expect(resolver.current()).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Codex authentication check timed out after 20ms.',
      retryable: true,
    });
    await expect(resolver.current()).resolves.toMatchObject({ kind: 'chatgpt' });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

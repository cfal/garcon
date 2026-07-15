import os from 'os';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const spawn = mock();

mock.module('bun-pty', () => ({
  spawn,
}));

import { AgentAuthLoginManager, parseDeviceAuth } from '../auth-login.js';

function createFakePty() {
  let exitHandler = null;
  let dataHandler = null;
  return {
    onExit(handler) {
      exitHandler = handler;
    },
    onData(handler) {
      dataHandler = handler;
    },
    emitExit(exit) {
      exitHandler?.(exit);
    },
    emitData(chunk) {
      dataHandler?.(chunk);
    },
  };
}

const DEVICE_AUTH_OUTPUT = `Welcome to Codex [v0.118.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   AB12-CD34

Device codes are a common phishing target. Never share this code.
`;

describe('parseDeviceAuth', () => {
  it('extracts URL and code from codex --device-auth output', () => {
    expect(parseDeviceAuth(DEVICE_AUTH_OUTPUT)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'AB12-CD34',
    });
  });

  it('returns null for unrecognized output', () => {
    expect(parseDeviceAuth('some random text')).toBeNull();
  });
});

describe('AgentAuthLoginManager', () => {
  const originalClaudeCode = process.env.CLAUDECODE;
  const originalClaudeBinary = process.env.CLAUDE_BINARY;

  beforeEach(() => {
    spawn.mockReset();
    if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalClaudeCode;
    if (originalClaudeBinary === undefined) delete process.env.CLAUDE_BINARY;
    else process.env.CLAUDE_BINARY = originalClaudeBinary;
  });

  it('launches Claude auth login with the configured binary and strips nested Claude env', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_BINARY = '/tmp/custom-claude';
    const manager = new AgentAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    expect(await manager.launch('claude')).toEqual({ launched: true, alreadyRunning: false });
    expect(await manager.launch('claude')).toEqual({ launched: false, alreadyRunning: true });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('delete process.env.CLAUDECODE');
    expect(args[1]).toContain('process.argv.slice(1)');
    expect(args[1]).toContain('env: process.env');
    expect(args.slice(2)).toEqual(['/tmp/custom-claude', 'auth', 'login']);
    expect(options.cwd).toBe(os.homedir());
    expect(options.env.CLAUDECODE).toBeUndefined();

    pty.emitExit({ exitCode: 0, signal: null });

    const nextPty = createFakePty();
    spawn.mockImplementationOnce(() => nextPty);
    expect(await manager.launch('claude')).toEqual({ launched: true, alreadyRunning: false });
  });

  it('launches Codex with --device-auth and returns parsed device info', async () => {
    const manager = new AgentAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    // launch() awaits device auth output from the PTY
    const resultPromise = manager.launch('codex');

    // Simulate PTY output arriving after the dynamic import installs handlers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData(DEVICE_AUTH_OUTPUT);

    const result = await resultPromise;

    expect(result.launched).toBe(true);
    expect(result.alreadyRunning).toBe(false);
    expect(result.deviceAuth).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'AB12-CD34',
    });

    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe('codex');
    expect(args).toEqual(['login', '--device-auth']);
  });

  it('returns alreadyRunning with the cached device auth when a codex session is in progress', async () => {
    const manager = new AgentAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    const resultPromise = manager.launch('codex');
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData(DEVICE_AUTH_OUTPUT);
    await resultPromise;

    const second = await manager.launch('codex');
    expect(second).toEqual({
      launched: false,
      alreadyRunning: true,
      deviceAuth: {
        url: 'https://auth.openai.com/codex/device',
        code: 'AB12-CD34',
      },
    });
  });

  it('drops the cached device auth once the codex session exits', async () => {
    const manager = new AgentAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    const resultPromise = manager.launch('codex');
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData(DEVICE_AUTH_OUTPUT);
    await resultPromise;

    pty.emitExit({ exitCode: 0, signal: null });

    const nextPty = createFakePty();
    spawn.mockImplementationOnce(() => nextPty);
    const relaunchPromise = manager.launch('codex');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const followUp = await manager.launch('codex');
    expect(followUp.deviceAuth).toBeUndefined();

    nextPty.emitData(DEVICE_AUTH_OUTPUT);
    const relaunch = await relaunchPromise;
    expect(relaunch.launched).toBe(true);
  });

  it('reports a running login session with device auth until it exits', async () => {
    const manager = new AgentAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    expect(manager.status('codex')).toEqual({ running: false });

    const resultPromise = manager.launch('codex');
    await new Promise((resolve) => setTimeout(resolve, 0));
    pty.emitData(DEVICE_AUTH_OUTPUT);
    await resultPromise;

    expect(manager.status('codex')).toEqual({
      running: true,
      deviceAuth: {
        url: 'https://auth.openai.com/codex/device',
        code: 'AB12-CD34',
      },
    });

    pty.emitExit({ exitCode: 0, signal: null });
    expect(manager.status('codex')).toEqual({ running: false });
  });

  it('rejects agents without a supported UI login flow', async () => {
    const manager = new AgentAuthLoginManager();

    expect(manager.launch('amp')).rejects.toThrow('Agent does not support UI login: amp');
    expect(spawn).not.toHaveBeenCalled();
  });
});

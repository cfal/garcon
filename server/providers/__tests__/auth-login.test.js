import os from 'os';
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const spawn = mock();

mock.module('bun-pty', () => ({
  spawn,
}));

import { ProviderAuthLoginManager } from '../auth-login.js';

function createFakePty() {
  let exitHandler = null;
  return {
    onExit(handler) {
      exitHandler = handler;
    },
    emitExit(exit) {
      exitHandler?.(exit);
    },
  };
}

describe('ProviderAuthLoginManager', () => {
  const originalClaudeCode = process.env.CLAUDECODE;
  const originalClaudeBinary = process.env.CLAUDE_BINARY;

  beforeEach(() => {
    spawn.mockReset();
    if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalClaudeCode;
    if (originalClaudeBinary === undefined) delete process.env.CLAUDE_BINARY;
    else process.env.CLAUDE_BINARY = originalClaudeBinary;
  });

  it('launches Claude auth login with the configured binary and strips nested Claude env', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_BINARY = '/tmp/custom-claude';
    const manager = new ProviderAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    expect(manager.launch('claude')).toEqual({ launched: true, alreadyRunning: false });
    expect(manager.launch('claude')).toEqual({ launched: false, alreadyRunning: true });

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
    expect(manager.launch('claude')).toEqual({ launched: true, alreadyRunning: false });
  });

  it('launches Codex auth login in a PTY', () => {
    const manager = new ProviderAuthLoginManager();
    const pty = createFakePty();
    spawn.mockImplementation(() => pty);

    expect(manager.launch('codex')).toEqual({ launched: true, alreadyRunning: false });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe('codex');
    expect(args).toEqual(['login']);
  });

  it('rejects providers without a supported UI login flow', () => {
    const manager = new ProviderAuthLoginManager();

    expect(() => manager.launch('amp')).toThrow('Provider does not support UI login: amp');
    expect(spawn).not.toHaveBeenCalled();
  });
});

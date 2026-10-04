import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  CliLoginController, parseBrowserAuth, parseDeviceAuth,
  type CliLoginControllerOptions, type CliLoginProcess,
} from '../cli-login-controller.js';

const logger = { debug: mock(), info: mock(), warn: mock(), error: mock() };
const controllers: CliLoginController[] = [];
function loginController(options: Partial<CliLoginControllerOptions> = {}) {
  const controller = new CliLoginController({ command: () => ['synthetic-cli', 'login'], mode: 'browser-code', logger, ...options });
  controllers.push(controller);
  return controller;
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const log of Object.values(logger)) log.mockClear();
});

describe('CliLoginController', () => {
  it('parses browser and device login output without ANSI decoration', () => {
    expect(parseBrowserAuth('\u001b[32mOpen https://auth.example/login\u001b[0m')).toEqual({ url: 'https://auth.example/login', needsCode: true });
    expect(parseDeviceAuth('Visit https://auth.example/device\n  ABCD-EFGH\n')).toEqual({ url: 'https://auth.example/device', code: 'ABCD-EFGH' });
  });

  it('owns one session per controller and keeps stdin open while rejecting duplicate completion', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    const controller = loginController({ spawnProcess: () => fixture.process });
    const independent = loginController();
    const launched = await controller.launch();
    expect(await controller.launch()).toMatchObject({ launched: false, alreadyRunning: true, sessionId: launched.sessionId });
    expect(independent.status()).toEqual({ state: 'idle', running: false });
    await controller.complete(launched.sessionId, 'callback-code');
    expect(fixture.writes).toEqual(['callback-code\n']);
    expect(fixture.end).not.toHaveBeenCalled();
    expect(controller.status(launched.sessionId)).toMatchObject({ completionPending: true });
    await expect(controller.complete(launched.sessionId, 'second-code')).rejects.toThrow('already pending');
    expect(fixture.writes).toHaveLength(1);
    fixture.resolveExit(0);
    await nextTurn();
    expect(controller.status(launched.sessionId)).toMatchObject({ state: 'succeeded', running: false });
  });

  it('continues draining separate stdout/stderr and accepts a retry after a chunked rejection', async () => {
    const fixture = browserProcess();
    const controller = loginController({
      spawnProcess: () => fixture.process,
      parseOutputError: line => line === 'Invalid synthetic code.' ? { retryable: true, message: 'Copy the full code and try again.' } : null,
    });
    const launched = controller.launch();
    fixture.stdout('Open https://auth.example/');
    fixture.stderr('separate output\n');
    fixture.stdout('login?complete=url\n');
    const { sessionId, deviceAuth } = await launched;
    expect(deviceAuth?.url).toBe('https://auth.example/login?complete=url');
    await controller.complete(sessionId, 'partial');
    fixture.stderr('x'.repeat(100_000));
    fixture.stderr('\nInvalid synthetic ');
    fixture.stdout('unrelated stdout\n');
    fixture.stderr('code.\n');
    await nextTurn();
    expect(controller.status(sessionId)).toMatchObject({ state: 'running', completionPending: false, retryableError: 'Copy the full code and try again.' });
    await controller.complete(sessionId, 'complete#suffix');
    expect(fixture.writes).toEqual(['partial\n', 'complete#suffix\n']);
    expect(fixture.end).not.toHaveBeenCalled();
    expect(controller.status(sessionId)).not.toHaveProperty('retryableError');
    fixture.resolveExit(0);
    await nextTurn();
    expect(controller.status(sessionId).state).toBe('succeeded');
  });

  it('validates codes before writing and retains a safe retry error', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    const controller = loginController({ spawnProcess: () => fixture.process, validateCode: code => code.includes('#') ? null : 'Full code required.' });
    const { sessionId } = await controller.launch();
    await expect(controller.complete(sessionId, 'synthetic-secret')).rejects.toMatchObject({ code: 'AUTH_LOGIN_CODE_INVALID', retryable: true, message: 'Full code required.' });
    expect(fixture.writes).toEqual([]);
    expect(controller.status(sessionId)).toMatchObject({ completionPending: false, retryableError: 'Full code required.' });
    await controller.complete(sessionId, 'valid#suffix');
    expect(fixture.writes).toEqual(['valid#suffix\n']);
  });

  it('classifies terminal failures after draining diagnostics without exposing raw output', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    const controller = loginController({ spawnProcess: () => fixture.process, parseOutputError: line => line.startsWith('Failure:') ? { retryable: false, message: 'Provider sign-in failed. Start again.' } : null });
    const { sessionId } = await controller.launch();
    fixture.stderr('Failure: synthetic-secret-token\n');
    fixture.resolveExit(1);
    await nextTurn();
    expect(controller.status(sessionId)).toMatchObject({ state: 'failed', error: 'Provider sign-in failed. Start again.' });
    expect(JSON.stringify(Object.values(logger).flatMap(log => log.mock.calls))).not.toContain('synthetic-secret-token');
  });

  it('retires uncertain writes instead of reusing possibly submitted input', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    fixture.process.stdin!.write = () => { throw new Error('synthetic-secret-in-write-error'); };
    const controller = loginController({ spawnProcess: () => fixture.process });
    const { sessionId } = await controller.launch();
    await expect(controller.complete(sessionId, 'complete#suffix')).rejects.toThrow('Sign-in failed.');
    expect(controller.status(sessionId).state).toBe('failed');
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(Object.values(logger).flatMap(log => log.mock.calls))).not.toContain('synthetic-secret');
  });

  it('ignores stale output and exit callbacks after a stopped session is replaced', async () => {
    const old = browserProcess('Open https://auth.example/old\n');
    const replacement = browserProcess('Open https://auth.example/new\n');
    old.process.kill = mock();
    let next = old;
    const controller = loginController({ spawnProcess: () => next.process, parseOutputError: () => ({ retryable: true, message: 'stale rejection' }) });
    await controller.launch();
    controller.stop();
    next = replacement;
    const { sessionId } = await controller.launch();
    await controller.complete(sessionId, 'complete#suffix');
    old.stderr('stale output\n');
    old.resolveExit(1);
    await nextTurn();
    expect(controller.status(sessionId)).toMatchObject({ state: 'running', completionPending: true });
    expect(controller.status(sessionId)).not.toHaveProperty('retryableError');
  });

  it('expires and kills a pending process, preserving timeout despite its later exit', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    const controller = loginController({ spawnProcess: () => fixture.process, sessionTimeoutMs: 5 });
    const { sessionId } = await controller.launch();
    await fixture.killed;
    await nextTurn();
    expect(controller.status(sessionId)).toMatchObject({ state: 'failed', error: 'Sign-in timed out. Start a new sign-in attempt.' });
    await expect(controller.complete(sessionId, 'complete#suffix')).rejects.toThrow('No matching pending auth login');
  });

  it('does not publish a URL after stop interrupts its discovery', async () => {
    const fixture = browserProcess();
    const controller = loginController({ spawnProcess: () => fixture.process });
    const launched = controller.launch();
    controller.stop();
    await expect(launched).rejects.toThrow('no longer available');
    expect(controller.status()).toEqual({ state: 'idle', running: false });
  });

  it('drains real process pipes after the URL and retries without closing stdin', async () => {
    const script = `
      const { createInterface } = require('node:readline');
      process.stdout.write('Open https://auth.example/login\\n');
      const input = createInterface({ input: process.stdin });
      input.on('line', (code) => {
        if (!code.includes('#')) {
          process.stderr.write('Synthetic code rejected.\\n');
          return;
        }
        process.stderr.write('x'.repeat(2 * 1024 * 1024) + '\\n', () => {
          process.stdout.write('Login successful.\\n', () => process.exit(0));
        });
      });
    `;
    const rejected = Promise.withResolvers<void>();
    const succeeded = Promise.withResolvers<void>();
    const controller = loginController({
      command: () => [process.execPath, '-e', script],
      parseOutputError: line => {
        if (line === 'Login successful.') succeeded.resolve();
        if (line !== 'Synthetic code rejected.') return null;
        rejected.resolve();
        return { retryable: true, message: 'Copy the full code.' };
      },
    });
    const { sessionId } = await controller.launch();
    await controller.complete(sessionId, 'partial');
    await rejected.promise;
    await controller.complete(sessionId, 'complete#suffix');
    await succeeded.promise;
  }, 5_000);

  it('parses device codes and kills active processes during stop', async () => {
    const kill = mock();
    const controller = loginController({ mode: 'device-code', spawnPty: async () => ({ onData(listener) { listener('Visit https://auth.example/device\n  WXYZ-1234\n'); }, onExit() {}, kill }) });
    await expect(controller.launch()).resolves.toMatchObject({ launched: true, deviceAuth: { url: 'https://auth.example/device', code: 'WXYZ-1234' } });
    expect(controller.status()).toMatchObject({ completionPending: false });
    controller.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

function nextTurn() { return new Promise<void>(resolve => setImmediate(resolve)); }
function browserProcess(output = '') {
  const writes: string[] = [];
  const end = mock(() => 0);
  const exit = Promise.withResolvers<number>();
  const killed = Promise.withResolvers<void>();
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const encode = (value: string) => new TextEncoder().encode(value);
  const resolveExit = (exitCode: number) => {
    if (closed) return;
    closed = true;
    stdout.close(); stderr.close(); exit.resolve(exitCode);
  };
  const kill = mock(() => { killed.resolve(); resolveExit(1); });
  const proc: CliLoginProcess = {
    stdin: { write(value) { writes.push(value); return value.length; }, flush() { return 0; }, end },
    stdout: new ReadableStream({ start(controller) { stdout = controller; if (output) stdout.enqueue(encode(output)); } }),
    stderr: new ReadableStream({ start(controller) { stderr = controller; } }),
    exited: exit.promise, kill,
  };
  return { process: proc, writes, end, kill, killed: killed.promise, resolveExit,
    stdout: (value: string) => stdout.enqueue(encode(value)), stderr: (value: string) => stderr.enqueue(encode(value)),
  };
}

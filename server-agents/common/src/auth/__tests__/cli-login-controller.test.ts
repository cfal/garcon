import { describe, expect, it } from 'bun:test';
import {
  CliLoginController,
  parseBrowserAuth,
  parseDeviceAuth,
  type CliLoginProcess,
} from '../cli-login-controller.js';

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('CliLoginController', () => {
  it('parses browser and device login output without ANSI decoration', () => {
    expect(parseBrowserAuth('\u001b[32mOpen https://auth.example/login\u001b[0m')).toEqual({
      url: 'https://auth.example/login',
      needsCode: true,
    });
    expect(parseDeviceAuth('Visit https://auth.example/device\n  ABCD-EFGH\n')).toEqual({
      url: 'https://auth.example/device',
      code: 'ABCD-EFGH',
    });
  });

  it('owns one browser-code session per controller and retains terminal status', async () => {
    const fixture = browserProcess('Open https://auth.example/login\n');
    const controller = new CliLoginController({
      command: () => ['claude', 'auth', 'login'],
      mode: 'browser-code',
      logger,
      spawnProcess: () => fixture.process,
    });
    const independent = new CliLoginController({
      command: () => ['claude', 'auth', 'login'],
      mode: 'browser-code',
      logger,
      spawnProcess: () => browserProcess('Open https://other.example/login\n').process,
    });

    const launched = await controller.launch();
    expect(await controller.launch()).toMatchObject({
      launched: false,
      alreadyRunning: true,
      sessionId: launched.sessionId,
    });
    expect(independent.status()).toEqual({ state: 'idle', running: false });
    await controller.complete(launched.sessionId, 'callback-code');
    expect(fixture.writes).toEqual(['callback-code\n']);

    fixture.resolveExit(0);
    await Promise.resolve();
    expect(controller.status(launched.sessionId)).toMatchObject({
      state: 'succeeded',
      running: false,
      sessionId: launched.sessionId,
    });
    controller.stop();
    independent.stop();
  });

  it('parses device codes and kills active processes during stop', async () => {
    let killed = false;
    const controller = new CliLoginController({
      command: () => ['codex', 'login', '--device-auth'],
      mode: 'device-code',
      logger,
      spawnPty: async () => ({
        onData(listener) {
          listener('Visit https://auth.example/device\n  WXYZ-1234\n');
        },
        onExit() {},
        kill() { killed = true; },
      }),
    });

    await expect(controller.launch()).resolves.toMatchObject({
      launched: true,
      deviceAuth: { url: 'https://auth.example/device', code: 'WXYZ-1234' },
    });
    controller.stop();
    expect(killed).toBe(true);
    expect(controller.status()).toEqual({ state: 'idle', running: false });
  });
});

function browserProcess(output: string): {
  readonly process: CliLoginProcess;
  readonly writes: string[];
  readonly resolveExit: (exitCode: number) => void;
} {
  const writes: string[] = [];
  let resolveExit!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(output));
    },
  });
  return {
    process: {
      stdin: {
        write(value) { writes.push(value); return value.length; },
        flush() { return 0; },
        end() { return 0; },
      },
      stdout: stream,
      stderr: null,
      exited,
      kill() {},
    },
    writes,
    resolveExit,
  };
}

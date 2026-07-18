import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';

const ADDRESS_PATTERN = /address\s*=\s*127\.0\.0\.1:(\d+)|127\.0\.0\.1:(\d+)/;
const LOG_CAPACITY = 2_000;

type LightpandaChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

async function pump(
  stream: ReadableStream<Uint8Array>,
  channel: 'stdout' | 'stderr',
  onText: (text: string) => void,
  logs: BoundedLog<string>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      onText(text);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) logs.push(`[${channel}] ${line.replace(/\r$/, '')}`);
    }
    pending += decoder.decode();
    if (pending) logs.push(`[${channel}] ${pending.replace(/\r$/, '')}`);
  } finally {
    reader.releaseLock();
  }
}

export function requireLightpandaBinary(): string {
  const path = process.env.LIGHTPANDA_BIN;
  if (!path) {
    throw new Error('LIGHTPANDA_BIN must point to an executable Lightpanda binary.');
  }
  return path;
}

export class LightpandaProcess {
  readonly #child: LightpandaChild;
  readonly #logs = new BoundedLog<string>(LOG_CAPACITY);
  readonly #stdoutPump: Promise<void>;
  readonly #stderrPump: Promise<void>;
  #expectedExit = false;
  #exitCode: number | null = null;
  #unexpectedExit: string | null = null;
  #cdpUrl = '';
  #browserWsEndpoint = '';

  private constructor(child: LightpandaChild, ready: Deferred<number>) {
    this.#child = child;
    let readinessText = '';
    const inspect = (text: string) => {
      readinessText = `${readinessText}${text}`.slice(-4_000);
      const match = ADDRESS_PATTERN.exec(readinessText);
      const port = Number(match?.[1] ?? match?.[2]);
      if (Number.isInteger(port) && port > 0) ready.resolve(port);
    };
    this.#stdoutPump = pump(child.stdout, 'stdout', inspect, this.#logs);
    this.#stderrPump = pump(child.stderr, 'stderr', inspect, this.#logs);
    void child.exited.then((exitCode) => {
      this.#exitCode = exitCode;
      if (!this.#expectedExit) {
        this.#unexpectedExit = `Lightpanda exited unexpectedly with code ${exitCode}`;
        ready.reject(new Error(`${this.#unexpectedExit}\n${this.describeLogs()}`));
      }
    });
  }

  static async start(binaryPath = requireLightpandaBinary()): Promise<LightpandaProcess> {
    await access(binaryPath, constants.X_OK);
    const ready = new Deferred<number>();
    const child = Bun.spawn({
      cmd: [
        '/bin/sh',
        '-c',
        'ulimit -c 0; exec "$@"',
        'lightpanda-e2e',
        binaryPath,
        'serve',
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--http-max-host-open',
        '20',
        '--http-timeout',
        '0',
        '--log-level',
        'info',
        '--log-format',
        'logfmt',
      ],
      env: {
        HOME: process.env.HOME ?? '/tmp',
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        LIGHTPANDA_DISABLE_CORE_DUMP: 'true',
        LIGHTPANDA_DISABLE_TELEMETRY: 'true',
        NO_COLOR: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const instance = new LightpandaProcess(child, ready);
    try {
      const port = await withTimeout(
        ready.promise,
        10_000,
        () => `Timed out waiting for Lightpanda startup.\n${instance.describeLogs()}`,
      );
      instance.#cdpUrl = `http://127.0.0.1:${port}`;
      instance.#browserWsEndpoint = await withTimeout(
        instance.#waitForCdp(),
        10_000,
        () => `Lightpanda CDP endpoint did not become ready.\n${instance.describeLogs()}`,
      );
      return instance;
    } catch (error) {
      await instance.#terminate();
      throw error;
    }
  }

  get cdpUrl(): string {
    return this.#cdpUrl;
  }

  get browserWsEndpoint(): string {
    return this.#browserWsEndpoint;
  }

  get logs(): readonly string[] {
    return this.#logs.values();
  }

  describeLogs(): string {
    return this.logs.length > 0 ? this.logs.join('\n') : '(no Lightpanda logs captured)';
  }

  assertNoUnexpectedExit(): void {
    if (this.#unexpectedExit) throw new Error(`${this.#unexpectedExit}\n${this.describeLogs()}`);
  }

  async stop(): Promise<void> {
    if (this.#exitCode !== null) return;
    this.#expectedExit = true;
    this.#child.kill('SIGTERM');
    await withTimeout(
      this.#child.exited,
      10_000,
      () => `Lightpanda did not stop after SIGTERM.\n${this.describeLogs()}`,
    );
    await Promise.allSettled([this.#stdoutPump, this.#stderrPump]);
  }

  async #waitForCdp(): Promise<string> {
    while (this.#exitCode === null) {
      try {
        const response = await fetch(`${this.#cdpUrl}/json/version`);
        if (response.ok) {
          const version = await response.json() as { webSocketDebuggerUrl?: unknown };
          if (typeof version.webSocketDebuggerUrl === 'string') return version.webSocketDebuggerUrl;
        }
      } catch {
        // Retries until the already-bounded startup deadline expires.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Lightpanda exited before CDP became ready.\n${this.describeLogs()}`);
  }

  async #terminate(): Promise<void> {
    if (this.#exitCode === null) {
      this.#expectedExit = true;
      this.#child.kill('SIGKILL');
      await this.#child.exited;
    }
    await Promise.allSettled([this.#stdoutPump, this.#stderrPump]);
  }
}

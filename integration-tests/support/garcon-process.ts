import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const LOG_CAPACITY = 2_000;

export interface GarconProcessOptions {
  repoRoot: string;
  configDir: string;
  workspaceDir: string;
  projectDir: string;
  homeDir: string;
  startupTimeoutMs?: number;
}

type GarconChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

function isolatedEnvironment(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NO_COLOR: '1',
    NODE_ENV: 'test',
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  channel: 'stdout' | 'stderr',
  onText: (text: string) => void,
  onLine: (line: string) => void,
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
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        onLine(`[${channel}] ${line}`);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending) onLine(`[${channel}] ${pending.replace(/\r$/, '')}`);
  } finally {
    reader.releaseLock();
  }
}

export class GarconProcess {
  readonly #child: GarconChild;
  readonly #logs = new BoundedLog<string>(LOG_CAPACITY);
  readonly #stdoutPump: Promise<void>;
  readonly #stderrPump: Promise<void>;
  #baseUrl = '';
  #expectedExit = false;
  #unexpectedExit: string | null = null;
  #exitCode: number | null = null;

  private constructor(child: GarconChild, ready: Deferred<string>) {
    this.#child = child;
    let readinessText = '';
    const inspectText = (text: string) => {
      readinessText = `${readinessText}${text}`.slice(-2_000);
      const match = SERVER_READY_PATTERN.exec(readinessText);
      if (match) ready.resolve(match[1]);
    };
    this.#stdoutPump = pumpLines(child.stdout, 'stdout', inspectText, (line) => this.#logs.push(line));
    this.#stderrPump = pumpLines(child.stderr, 'stderr', inspectText, (line) => this.#logs.push(line));
    void child.exited.then((exitCode) => {
      this.#exitCode = exitCode;
      if (!this.#expectedExit) {
        this.#unexpectedExit = `Garcon exited unexpectedly with code ${exitCode}`;
        ready.reject(new Error(`${this.#unexpectedExit}\n${this.describeLogs()}`));
      }
    });
  }

  static async start(options: GarconProcessOptions): Promise<GarconProcess> {
    const ready = new Deferred<string>();
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        'server/main.ts',
        '--port',
        '0',
        '--bind-address',
        '127.0.0.1',
        '--disable-auth',
        '--config-dir',
        options.configDir,
        '--workspace-dir',
        options.workspaceDir,
        '--project-base-dir',
        options.projectDir,
      ],
      cwd: options.repoRoot,
      env: isolatedEnvironment(options.homeDir),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const instance = new GarconProcess(child, ready);

    try {
      instance.#baseUrl = await withTimeout(
        ready.promise,
        options.startupTimeoutMs ?? 20_000,
        () => `Timed out waiting for Garcon startup.\n${instance.describeLogs()}`,
      );
      return instance;
    } catch (error) {
      await instance.#terminateAfterStartupFailure();
      throw error;
    }
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get logs(): readonly string[] {
    return this.#logs.values();
  }

  get isRunning(): boolean {
    return this.#exitCode === null;
  }

  async stop(): Promise<void> {
    if (this.#exitCode !== null) return;
    this.#expectedExit = true;
    this.#child.kill('SIGTERM');
    const exitCode = await withTimeout(
      this.#child.exited,
      15_000,
      () => `Garcon did not stop gracefully.\n${this.describeLogs()}`,
    );
    await this.#finishPumps();
    if (exitCode !== 0) {
      throw new Error(`Garcon graceful shutdown exited with code ${exitCode}.\n${this.describeLogs()}`);
    }
  }

  async crash(): Promise<void> {
    if (this.#exitCode !== null) return;
    this.#expectedExit = true;
    this.#child.kill('SIGKILL');
    await withTimeout(
      this.#child.exited,
      10_000,
      () => `Garcon did not exit after SIGKILL.\n${this.describeLogs()}`,
    );
    await this.#finishPumps();
  }

  assertNoUnexpectedExit(): void {
    if (this.#unexpectedExit) {
      throw new Error(`${this.#unexpectedExit}\n${this.describeLogs()}`);
    }
  }

  describeLogs(): string {
    const logs = this.logs;
    return logs.length > 0 ? logs.join('\n') : '(no Garcon logs captured)';
  }

  async #terminateAfterStartupFailure(): Promise<void> {
    if (this.#exitCode === null) {
      this.#expectedExit = true;
      this.#child.kill('SIGKILL');
      await this.#child.exited;
    }
    await this.#finishPumps();
  }

  async #finishPumps(): Promise<void> {
    await Promise.allSettled([this.#stdoutPump, this.#stderrPump]);
  }
}

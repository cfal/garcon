import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BoundedLog } from './bounded-log.js';
import { Deferred, withTimeout } from './deferred.js';
import { fixtureAuthToken, prepareFixtureAuth } from './fixture-auth.js';
import { SERVER_RUNTIME_FILENAME } from '../../common/server-runtime.js';

const SERVER_READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const LOG_CAPACITY = 2_000;

export interface GarconProcessOptions {
  repoRoot: string;
  configDir: string;
  workspaceDir: string;
  workspaceName?: string;
  projectDir: string;
  homeDir: string;
  startupTimeoutMs?: number;
  environment?: Record<string, string>;
  redactEnvironmentValues?: boolean;
  authentication?: 'existing';
  port?: number;
}

type GarconChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:api[_-]?key|auth[_-]?token|credential|password|secret|token)/i;

export function redactSensitiveEnvironmentText(
  text: string,
  environment: Record<string, string> = {},
): string {
  const values = Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_ENVIRONMENT_NAME.test(name) && value.length > 0)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  return values.reduce(
    (redacted, value) => redacted.replaceAll(value, '[REDACTED]'),
    text,
  );
}

export function isolatedEnvironment(
  homeDir: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    TMPDIR: join(homeDir, 'tmp'),
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NO_COLOR: '1',
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...overrides,
  };
}

export async function pumpLines(
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

// GARCON_TEST_CONTROLLER=front-door starts the controller behind the Rust front
// door (rust/README.md) so every suite also verifies it; the default starts the
// TypeScript controller directly. Front-door settings (GARCON_RS_*), such as the
// shadow log and unit kill switches, pass through to it.
export function controllerLaunch(repoRoot: string, value = process.env.GARCON_TEST_CONTROLLER ?? 'original'): {
  command: string[];
  environment: Record<string, string>;
} {
  if (value === 'original') return { command: [process.execPath, 'server/main.ts'], environment: {} };
  if (value !== 'front-door') throw new Error(`Unknown controller: ${value}`);
  return {
    // GARCON_TEST_FRONT_DOOR_BINARY selects a build other than the local release build.
    command: [process.env.GARCON_TEST_FRONT_DOOR_BINARY ?? join(repoRoot, 'rust/target/release/garcon-server')],
    environment: {
      GARCON_RS_BUN: process.execPath,
      ...Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[0].startsWith('GARCON_RS_') && Boolean(entry[1]))),
    },
  };
}

// Reads the controller pid from the runtime descriptor it publishes before it
// reports readiness; absent when publication was suppressed or failed.
async function publishedControllerPid(configDir: string): Promise<number | null> {
  try {
    const descriptor = JSON.parse(await readFile(join(configDir, SERVER_RUNTIME_FILENAME), 'utf8')) as { pid?: unknown };
    return typeof descriptor.pid === 'number' ? descriptor.pid : null;
  } catch {
    return null;
  }
}

export class GarconProcess {
  readonly #child: GarconChild;
  readonly #logs = new BoundedLog<string>(LOG_CAPACITY);
  readonly #stdoutPump: Promise<void>;
  readonly #stderrPump: Promise<void>;
  #baseUrl = '';
  #authToken: string | null = null;
  #controllerPid: number | null = null;
  #credentials: { username: string; password: string } | null = null;
  #expectedExit = false;
  #unexpectedExit: string | null = null;
  #exitCode: number | null = null;

  private constructor(
    child: GarconChild,
    ready: Deferred<string>,
    redactedEnvironment: Record<string, string>,
  ) {
    this.#child = child;
    let readinessText = '';
    const inspectText = (text: string) => {
      readinessText = `${readinessText}${text}`.slice(-2_000);
      const match = SERVER_READY_PATTERN.exec(readinessText);
      if (match) {
        const clientUrl = new URL(match[1]);
        clientUrl.hostname = '127.0.0.1';
        ready.resolve(clientUrl.href.replace(/\/$/, ''));
      }
    };
    const captureLine = (line: string) => {
      this.#logs.push(redactSensitiveEnvironmentText(line, redactedEnvironment));
    };
    this.#stdoutPump = pumpLines(child.stdout, 'stdout', inspectText, captureLine);
    this.#stderrPump = pumpLines(child.stderr, 'stderr', inspectText, captureLine);
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
    const launch = controllerLaunch(options.repoRoot);
    const environment = isolatedEnvironment(options.homeDir, { ...launch.environment, ...options.environment });
    await mkdir(environment.TMPDIR, { recursive: true });
    const credentials = options.authentication === 'existing' ? null : await prepareFixtureAuth(options.configDir);
    const workspaceArguments = options.workspaceName
      ? ['--workspace', options.workspaceName]
      : ['--workspace-dir', options.workspaceDir];
    const child = Bun.spawn({
      cmd: [
        ...launch.command,
        '--port',
        String(options.port ?? 0),
        '--bind-address',
        '0.0.0.0',
        '--config-dir',
        options.configDir,
        ...workspaceArguments,
        '--project-base-dir',
        options.projectDir,
      ],
      cwd: options.repoRoot,
      env: environment,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const instance = new GarconProcess(
      child,
      ready,
      options.redactEnvironmentValues ? options.environment ?? {} : {},
    );

    try {
      instance.#baseUrl = await withTimeout(
        ready.promise,
        options.startupTimeoutMs ?? 20_000,
        () => `Timed out waiting for Garcon startup.\n${instance.describeLogs()}`,
      );
      if (credentials) instance.#authToken = await fixtureAuthToken(instance.#baseUrl, credentials);
      instance.#credentials = credentials;
      instance.#controllerPid = await publishedControllerPid(options.configDir);
      return instance;
    } catch (error) {
      await instance.#terminateAfterStartupFailure();
      throw error;
    }
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get authToken(): string | null {
    return this.#authToken;
  }

  get credentials(): { username: string; password: string } | null { return this.#credentials; }

  // The controller process, which spawns providers and executes work. Behind
  // the front door it is the front door's child; lifecycle signals still go to
  // the spawned process, whose exit ends the controller.
  get pid(): number | null {
    return this.#exitCode === null ? this.#controllerPid ?? this.#child.pid : null;
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
    let exitCode: number;
    try {
      exitCode = await withTimeout(
        this.#child.exited,
        15_000,
        () => `Garcon did not stop gracefully.\n${this.describeLogs()}`,
      );
    } catch (gracefulError) {
      this.#child.kill('SIGKILL');
      await withTimeout(
        this.#child.exited,
        10_000,
        () => `Garcon did not exit after forced teardown.\n${this.describeLogs()}`,
      );
      await this.#finishPumps();
      throw gracefulError;
    }
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

  capturedOutput(): string {
    return this.logs.join('\n');
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

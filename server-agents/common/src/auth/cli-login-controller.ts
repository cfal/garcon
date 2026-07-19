import crypto from 'node:crypto';
import os from 'node:os';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
  AgentDeviceAuthInfo,
} from '@garcon/common/agent-auth';
import {
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';

export type CliLoginCommand = readonly [string, ...string[]];

export interface CliLoginPty {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: {
    readonly exitCode: number;
    readonly signal?: string | number;
  }) => void): void;
  kill(): void;
}

export interface CliLoginProcess {
  readonly stdin: {
    write(value: string): number | Promise<number>;
    flush(): number | Promise<number>;
    end(): number | Promise<number>;
  } | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface CliLoginControllerOptions {
  readonly command: () => CliLoginCommand;
  readonly mode: 'browser-code' | 'device-code';
  readonly logger: AgentLogger;
  readonly cwd?: string;
  readonly environment?: () => Record<string, string>;
  readonly spawnProcess?: (
    command: CliLoginCommand,
    options: { readonly cwd: string; readonly env: Record<string, string> },
  ) => CliLoginProcess;
  readonly spawnPty?: (
    command: CliLoginCommand,
    options: { readonly cwd: string; readonly env: Record<string, string> },
  ) => Promise<CliLoginPty>;
  readonly sessionTimeoutMs?: number;
  readonly initialResponseTimeoutMs?: number;
  readonly terminalStatusTtlMs?: number;
}

interface LoginSession {
  readonly id: string;
  phase: 'running' | 'completing';
  process?: { kill(): void };
  browserProcess?: CliLoginProcess;
  deviceAuth?: AgentDeviceAuthInfo;
  watchdog?: ReturnType<typeof setTimeout>;
}

type TerminalStatus = Extract<AgentAuthLoginStatus, { state: 'succeeded' | 'failed' }>;

const INITIAL_RESPONSE_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 15 * 60_000;
const TERMINAL_STATUS_TTL_MS = 15 * 60_000;
const SESSION_EXPIRED_ERROR = 'Sign-in timed out. Start a new sign-in attempt.';
const SESSION_UNAVAILABLE_ERROR = 'This sign-in session is no longer available.';
const SESSION_FAILED_ERROR = 'Sign-in failed. Start a new sign-in attempt.';

export class CliLoginController {
  #active: LoginSession | null = null;
  readonly #terminal = new Map<string, {
    readonly status: TerminalStatus;
    readonly cleanup: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly options: CliLoginControllerOptions) {}

  async launch(): Promise<AgentAuthLoginLaunchResult> {
    if (this.#active) {
      return {
        launched: false,
        alreadyRunning: true,
        sessionId: this.#active.id,
        deviceAuth: this.#active.deviceAuth,
      };
    }

    const session: LoginSession = {
      id: crypto.randomUUID(),
      phase: 'running',
    };
    this.#active = session;
    this.#startWatchdog(session);
    try {
      return this.options.mode === 'browser-code'
        ? await this.#launchBrowserCode(session)
        : await this.#launchDeviceCode(session);
    } catch (error) {
      if (this.#active === session) {
        this.#finish(session, { state: 'failed', error: SESSION_FAILED_ERROR });
      }
      throw error;
    }
  }

  status(expectedSessionId?: string): AgentAuthLoginStatus {
    const active = this.#active;
    if (active && (!expectedSessionId || active.id === expectedSessionId)) {
      return {
        state: 'running',
        running: true,
        sessionId: active.id,
        deviceAuth: active.deviceAuth,
      };
    }
    if (!expectedSessionId) return { state: 'idle', running: false };
    return this.#terminal.get(expectedSessionId)?.status ?? {
      state: 'failed',
      running: false,
      sessionId: expectedSessionId,
      error: SESSION_UNAVAILABLE_ERROR,
    };
  }

  async complete(sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult> {
    const session = this.#active;
    const proc = session?.browserProcess;
    if (!session || session.id !== sessionId || !proc) {
      throw new CliLoginSessionError('No matching pending auth login');
    }
    if (!code.trim()) throw new Error('code is required');
    if (!proc.stdin) throw new Error('Pending auth login cannot accept a code');
    if (session.phase !== 'running') {
      throw new CliLoginSessionError('Auth login completion is already pending');
    }

    session.phase = 'completing';
    try {
      await proc.stdin.write(`${code.trim()}\n`);
      await proc.stdin.flush();
      await proc.stdin.end();
    } catch (error) {
      if (this.#active === session) session.phase = 'running';
      throw error;
    }
    return { submitted: true, sessionId };
  }

  stop(): void {
    const active = this.#active;
    this.#active = null;
    if (active?.watchdog) clearTimeout(active.watchdog);
    try {
      active?.process?.kill();
    } catch (error) {
      this.options.logger.debug('Auth login termination failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const entry of this.#terminal.values()) clearTimeout(entry.cleanup);
    this.#terminal.clear();
  }

  async #launchBrowserCode(session: LoginSession): Promise<AgentAuthLoginLaunchResult> {
    const proc = (this.options.spawnProcess ?? spawnLoginProcess)(
      this.options.command(),
      this.#processOptions(),
    );
    session.browserProcess = proc;
    session.process = proc;
    const deviceAuth = await readBrowserAuth(
      proc,
      this.options.initialResponseTimeoutMs ?? INITIAL_RESPONSE_TIMEOUT_MS,
      this.options.logger,
    );
    if (!deviceAuth) {
      proc.kill();
      throw new Error('Auth login did not print a sign-in URL');
    }
    session.deviceAuth = deviceAuth;
    void proc.exited.then(
      (exitCode) => this.#finishFromExit(session, exitCode),
      (error) => {
        this.options.logger.warn('Auth login process failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.#finish(session, { state: 'failed', error: SESSION_FAILED_ERROR });
      },
    );
    return {
      launched: true,
      alreadyRunning: false,
      sessionId: session.id,
      deviceAuth,
    };
  }

  async #launchDeviceCode(session: LoginSession): Promise<AgentAuthLoginLaunchResult> {
    if (!this.options.spawnPty) {
      throw new Error('Device-code login requires a PTY spawner');
    }
    const proc = await this.options.spawnPty(this.options.command(), this.#processOptions());
    if (this.#active !== session) {
      proc.kill();
      throw new Error(SESSION_EXPIRED_ERROR);
    }
    session.process = proc;
    proc.onExit((event) => {
      this.#finishFromExit(session, event.exitCode);
      if (event.exitCode !== 0) {
        this.options.logger.warn('Auth login exited unsuccessfully', {
          exitCode: event.exitCode,
          ...(event.signal === undefined ? {} : { signal: event.signal }),
        });
      }
    });
    const deviceAuth = await readDeviceAuth(
      proc,
      (parsed) => {
        if (this.#active === session) session.deviceAuth = parsed;
      },
      this.options.initialResponseTimeoutMs ?? INITIAL_RESPONSE_TIMEOUT_MS,
    );
    return {
      launched: true,
      alreadyRunning: false,
      sessionId: session.id,
      deviceAuth: deviceAuth ?? undefined,
    };
  }

  #processOptions() {
    return {
      cwd: this.options.cwd ?? os.homedir(),
      env: this.options.environment?.() ?? defaultLoginEnvironment(),
    };
  }

  #startWatchdog(session: LoginSession): void {
    session.watchdog = setTimeout(() => {
      if (this.#active !== session) return;
      this.#finish(session, { state: 'failed', error: SESSION_EXPIRED_ERROR });
      try {
        session.process?.kill();
      } catch (error) {
        this.options.logger.debug('Expired auth login termination failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
    session.watchdog.unref?.();
  }

  #finishFromExit(session: LoginSession, exitCode: number): void {
    this.#finish(
      session,
      exitCode === 0
        ? { state: 'succeeded' }
        : { state: 'failed', error: SESSION_FAILED_ERROR },
    );
  }

  #finish(
    session: LoginSession,
    outcome: { readonly state: 'succeeded' } | { readonly state: 'failed'; readonly error: string },
  ): void {
    if (this.#active !== session) return;
    this.#active = null;
    if (session.watchdog) clearTimeout(session.watchdog);
    const status: TerminalStatus = {
      ...outcome,
      running: false,
      sessionId: session.id,
    };
    const cleanup = setTimeout(() => {
      if (this.#terminal.get(session.id)?.status === status) this.#terminal.delete(session.id);
    }, this.options.terminalStatusTtlMs ?? TERMINAL_STATUS_TTL_MS);
    cleanup.unref?.();
    this.#terminal.set(session.id, { status, cleanup });
  }
}

export class CliLoginSessionError extends AgentIntegrationError {
  constructor(message: string) {
    super('AUTH_LOGIN_SESSION_MISMATCH', message, false);
    this.name = 'CliLoginSessionError';
  }
}

export function parseDeviceAuth(raw: string): AgentDeviceAuthInfo | null {
  const output = stripAnsi(raw);
  const url = output.match(/https:\/\/\S+/)?.[0];
  const code = output.match(/^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$/m)?.[1];
  return url && code ? { url, code } : null;
}

export function parseBrowserAuth(raw: string): AgentDeviceAuthInfo | null {
  const url = stripAnsi(raw).match(/https:\/\/\S+/)?.[0];
  return url ? { url, needsCode: true } : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function defaultLoginEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
}

function spawnLoginProcess(
  command: CliLoginCommand,
  options: { readonly cwd: string; readonly env: Record<string, string> },
): CliLoginProcess {
  return Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function readDeviceAuth(
  proc: CliLoginPty,
  onDeviceAuth: (value: AgentDeviceAuthInfo) => void,
  timeoutMs: number,
): Promise<AgentDeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let parsedDeviceAuth = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
    timeout.unref?.();
    proc.onData((chunk) => {
      if (parsedDeviceAuth) return;
      output += chunk;
      const parsed = parseDeviceAuth(output);
      if (!parsed) return;
      parsedDeviceAuth = true;
      onDeviceAuth(parsed);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(parsed);
    });
  });
}

function readBrowserAuth(
  proc: CliLoginProcess,
  timeoutMs: number,
  logger: AgentLogger,
): Promise<AgentDeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: AgentDeviceAuthInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    timeout.unref?.();
    const read = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          const parsed = parseBrowserAuth(output);
          if (parsed) return finish(parsed);
        }
      } catch (error) {
        logger.debug('Auth login output read failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void read(proc.stdout);
    void read(proc.stderr);
    void proc.exited.then(
      () => finish(null),
      () => finish(null),
    );
  });
}

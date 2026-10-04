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

export type CliLoginOutputError = {
  readonly retryable: boolean;
  readonly message: string;
};

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
  readonly validateCode?: (code: string) => string | null;
  readonly parseOutputError?: (line: string) => CliLoginOutputError | null;
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
  retryableError?: string;
  failureError?: string;
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
        completionPending: active.phase === 'completing',
        ...(active.retryableError ? { retryableError: active.retryableError } : {}),
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
    const trimmedCode = code.trim();
    if (!trimmedCode) throw new Error('code is required');
    if (!proc.stdin) throw new Error('Pending auth login cannot accept a code');
    if (session.phase !== 'running') {
      throw new CliLoginSessionError('Auth login completion is already pending');
    }
    const validationError = this.options.validateCode?.(trimmedCode);
    if (validationError) {
      session.retryableError = validationError;
      throw new AgentIntegrationError('AUTH_LOGIN_CODE_INVALID', validationError, true);
    }

    session.phase = 'completing';
    session.retryableError = undefined;
    try {
      await proc.stdin.write(`${trimmedCode}\n`);
      await proc.stdin.flush();
    } catch {
      // A partial write cannot safely be retried against the same process.
      this.#finish(session, { state: 'failed', error: SESSION_FAILED_ERROR });
      try { proc.kill(); } catch { /* Process exit already owns cleanup. */ }
      throw new Error(SESSION_FAILED_ERROR);
    }
    return { submitted: true, sessionId };
  }

  stop(): void {
    const active = this.#active;
    this.#active = null;
    if (active?.watchdog) clearTimeout(active.watchdog);
    try {
      active?.process?.kill();
    } catch {
      this.options.logger.debug('Auth login termination failed');
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
    const output = readBrowserAuth(
      proc,
      this.options.initialResponseTimeoutMs ?? INITIAL_RESPONSE_TIMEOUT_MS,
      this.options.logger,
      (line) => {
        if (this.#active !== session) return;
        const error = this.options.parseOutputError?.(line);
        if (!error) return;
        if (error.retryable && session.phase === 'completing') {
          session.phase = 'running';
          session.retryableError = error.message;
        } else if (!error.retryable) {
          session.failureError = error.message;
        }
      },
    );
    void proc.exited.then(async (exitCode) => {
      await output.drained;
      this.#finishFromExit(session, exitCode);
    }, () => {
      this.options.logger.warn('Auth login process failed');
      this.#finish(session, { state: 'failed', error: SESSION_FAILED_ERROR });
    });
    const deviceAuth = await output.initial;
    if (this.#active !== session) throw new Error(SESSION_UNAVAILABLE_ERROR);
    if (!deviceAuth) {
      proc.kill();
      throw new Error('Auth login did not print a sign-in URL');
    }
    session.deviceAuth = deviceAuth;
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
      } catch {
        this.options.logger.debug('Expired auth login termination failed');
      }
    }, this.options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS);
    session.watchdog.unref?.();
  }

  #finishFromExit(session: LoginSession, exitCode: number): void {
    this.#finish(
      session,
      exitCode === 0
        ? { state: 'succeeded' }
        : { state: 'failed', error: session.failureError ?? SESSION_FAILED_ERROR },
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
  onLine: (line: string) => void,
): {
  readonly initial: Promise<AgentDeviceAuthInfo | null>;
  readonly drained: Promise<void>;
} {
  let resolveInitial!: (value: AgentDeviceAuthInfo | null) => void;
  const initial = new Promise<AgentDeviceAuthInfo | null>((resolve) => { resolveInitial = resolve; });
  let settled = false;
  const finish = (value: AgentDeviceAuthInfo | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolveInitial(value);
  };
  const timeout = setTimeout(() => finish(null), timeoutMs);
  timeout.unref?.();
  const lineReceived = (line: string) => {
    if (!settled) {
      const parsed = parseBrowserAuth(line);
      if (parsed) finish(parsed);
    }
    onLine(stripAnsi(line));
  };
  // Both pipes remain drained after URL discovery so diagnostics cannot block the CLI.
  const drained = Promise.all([
    drainLoginOutput(proc.stdout, lineReceived, logger),
    drainLoginOutput(proc.stderr, lineReceived, logger),
  ]).then(() => { finish(null); });
  return { initial, drained };
}

async function drainLoginOutput(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
  logger: AgentLogger,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const maxLineLength = 16_384;
  let pending = '';
  const consume = (chunk: string) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const end = newline === -1 ? chunk.length : newline;
      pending = (pending + chunk.slice(offset, end)).slice(-maxLineLength);
      if (newline === -1) return;
      onLine(pending);
      pending = '';
      offset = newline + 1;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (pending) onLine(pending);
  } catch {
    logger.debug('Auth login output read failed');
  } finally {
    reader.releaseLock();
  }
}

import os from 'os';
import type { IPty, IExitEvent } from 'bun-pty';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
  AgentDeviceAuthInfo,
} from '../../common/agent-auth.js';
import { getClaudeBinary, getCursorBinary } from '../config.js';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agents:auth-login');

type LoginCommand = [string, ...string[]];

type SpawnedLoginProcess = Bun.PipedSubprocess;
type LoginProcessSpawner = (command: LoginCommand, agentId: string) => SpawnedLoginProcess;

interface AuthLoginSession {
  id: string;
  phase: 'running' | 'completing';
  process?: { kill(): void };
  browserProcess?: SpawnedLoginProcess;
  deviceAuth?: AgentDeviceAuthInfo;
  watchdog?: ReturnType<typeof setTimeout>;
}

type TerminalAuthLoginStatus = Extract<AgentAuthLoginStatus, { state: 'succeeded' | 'failed' }>;

interface CachedTerminalAuthLoginStatus {
  agentId: string;
  status: TerminalAuthLoginStatus;
}

const CLAUDE_LOGIN_WRAPPER = `
delete process.env.CLAUDECODE;
const [binary, ...args] = process.argv.slice(1);
const child = Bun.spawn({
  cmd: [binary, ...args],
  cwd: process.cwd(),
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
`.trim();

function getClaudeLoginCommand(): LoginCommand {
  // Removes CLAUDECODE inside the spawned process because bun-pty merges its env with the parent env.
  return [process.execPath, '-e', CLAUDE_LOGIN_WRAPPER, getClaudeBinary(), 'auth', 'login'];
}

function getClaudePipeLoginCommand(): LoginCommand {
  return [getClaudeBinary(), 'auth', 'login'];
}

function getLoginCommand(agentId: string): LoginCommand | null {
  if (agentId === 'claude') return getClaudeLoginCommand();
  if (agentId === 'codex') return ['codex', 'login', '--device-auth'];
  if (agentId === 'cursor') return [getCursorBinary(), 'login'];
  return null;
}

// Agents that use device-code auth instead of browser redirect.
const DEVICE_AUTH_AGENTS = new Set(['codex']);

const DEVICE_AUTH_TIMEOUT_MS = 10_000;
const LOGIN_SESSION_TIMEOUT_MS = 15 * 60_000;
const TERMINAL_SESSION_TTL_MS = 15 * 60_000;
const SESSION_EXPIRED_ERROR = 'Sign-in timed out. Start a new sign-in attempt.';
const SESSION_UNAVAILABLE_ERROR = 'This sign-in session is no longer available.';
const SESSION_FAILED_ERROR = 'Sign-in failed. Start a new sign-in attempt.';

// Strip ANSI escape sequences so the regex can match clean text.
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Parses device auth URL and one-time code from CLI output.
export function parseDeviceAuth(raw: string): AgentDeviceAuthInfo | null {
  const output = stripAnsi(raw);
  const urlMatch = output.match(/https:\/\/\S+/);
  const codeMatch = output.match(/^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$/m);
  if (urlMatch && codeMatch) {
    return { url: urlMatch[0], code: codeMatch[1] };
  }
  return null;
}

export function parseBrowserAuth(raw: string): AgentDeviceAuthInfo | null {
  const output = stripAnsi(raw);
  const urlMatch = output.match(/https:\/\/\S+/);
  if (!urlMatch) return null;
  return { url: urlMatch[0], needsCode: true };
}

// Reads PTY output via onData until device auth info is found or timeout.
function readDeviceAuthFromPty(
  proc: IPty,
  onDeviceAuth: (deviceAuth: AgentDeviceAuthInfo) => void,
  initialResponseTimeoutMs: number,
): Promise<AgentDeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    let initialResponseSettled = false;
    let parsedDeviceAuth = false;
    const timeout = setTimeout(() => {
      initialResponseSettled = true;
      resolve(null);
    }, initialResponseTimeoutMs);

    proc.onData((chunk) => {
      if (parsedDeviceAuth) return;
      output += chunk;
      const parsed = parseDeviceAuth(output);
      if (parsed) {
        parsedDeviceAuth = true;
        onDeviceAuth(parsed);
        clearTimeout(timeout);
        if (!initialResponseSettled) {
          initialResponseSettled = true;
          resolve(parsed);
        }
      }
    });
  });
}

function readBrowserAuthFromProcess(proc: SpawnedLoginProcess): Promise<AgentDeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(null), DEVICE_AUTH_TIMEOUT_MS);

    function finish(value: AgentDeviceAuthInfo | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }

    async function read(stream: ReadableStream<Uint8Array> | null): Promise<void> {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          const parsed = parseBrowserAuth(output);
          if (parsed) {
            finish(parsed);
            return;
          }
        }
      } catch (error) {
        logger.debug(
          `agents: auth login output read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    void read(proc.stdout as ReadableStream<Uint8Array> | null);
    void read(proc.stderr as ReadableStream<Uint8Array> | null);
    void proc.exited
      .then((exitCode) => {
        if (exitCode !== 0) {
          logger.warn(`agents: browser auth login exited before auth URL with code ${exitCode}`);
        }
        finish(null);
      })
      .catch((error) => {
        logger.warn(
          `agents: browser auth login failed before auth URL: ${error instanceof Error ? error.message : String(error)}`,
        );
        finish(null);
      });
  });
}

function buildLoginEnv(agentId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  });

  // Claude refuses to launch inside another Claude Code session.
  if (agentId === 'claude') {
    delete env.CLAUDECODE;
  }

  return env;
}

function defaultProcessSpawner(command: LoginCommand, agentId: string): SpawnedLoginProcess {
  const [binary, ...args] = command;
  return Bun.spawn([binary, ...args], {
    cwd: os.homedir(),
    env: buildLoginEnv(agentId),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export class AgentAuthLoginManager {
  #sessions = new Map<string, AuthLoginSession>();
  #terminalSessions = new Map<string, CachedTerminalAuthLoginStatus>();
  #spawnProcess: LoginProcessSpawner;
  #sessionTimeoutMs: number;
  #deviceAuthTimeoutMs: number;
  #terminalSessionTtlMs: number;

  constructor(
    options: {
      spawnProcess?: LoginProcessSpawner;
      sessionTimeoutMs?: number;
      deviceAuthTimeoutMs?: number;
      terminalSessionTtlMs?: number;
    } = {},
  ) {
    this.#spawnProcess = options.spawnProcess ?? defaultProcessSpawner;
    this.#sessionTimeoutMs = options.sessionTimeoutMs ?? LOGIN_SESSION_TIMEOUT_MS;
    this.#deviceAuthTimeoutMs = options.deviceAuthTimeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
    this.#terminalSessionTtlMs = options.terminalSessionTtlMs ?? TERMINAL_SESSION_TTL_MS;
  }

  async launch(agentId: string): Promise<AgentAuthLoginLaunchResult> {
    const command = getLoginCommand(agentId);
    if (!command) {
      throw new Error(`Agent does not support UI login: ${agentId}`);
    }

    const existingSession = this.#sessions.get(agentId);
    if (existingSession) {
      return {
        launched: false,
        alreadyRunning: true,
        sessionId: existingSession.id,
        deviceAuth: existingSession.deviceAuth,
      };
    }

    // Claims the agent before loading bun-pty so concurrent requests cannot both spawn a login.
    const session: AuthLoginSession = {
      id: crypto.randomUUID(),
      phase: 'running',
    };
    this.#sessions.set(agentId, session);
    this.#startWatchdog(agentId, session);

    try {
      const proc = await this.#spawnPty(agentId, command, session);
      const useDeviceAuth = DEVICE_AUTH_AGENTS.has(agentId);
      const deviceAuth = useDeviceAuth
        ? ((await readDeviceAuthFromPty(
            proc,
            (parsed) => this.#cacheDeviceAuth(agentId, session, parsed),
            this.#deviceAuthTimeoutMs,
          )) ?? undefined)
        : undefined;
      return {
        launched: true,
        alreadyRunning: false,
        sessionId: session.id,
        deviceAuth,
      };
    } catch (error) {
      if (this.#sessions.get(agentId) !== session) throw error;
      if (agentId !== 'claude') {
        this.#finishSession(agentId, session, {
          state: 'failed',
          error: SESSION_FAILED_ERROR,
        });
        throw error;
      }
      logger.warn(
        `agents: Claude PTY login failed, falling back to browser-code flow: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.#launchClaudeBrowserCodeLogin(agentId, session);
    }
  }

  // Reports whether a login session is still in progress so clients can keep
  // device auth details visible until the session actually ends. Auth status
  // is not a usable completion signal because agents with stale credentials
  // report authenticated throughout a re-login.
  status(agentId: string, expectedSessionId?: string): AgentAuthLoginStatus {
    const session = this.#sessions.get(agentId);
    if (session && (!expectedSessionId || session.id === expectedSessionId)) {
      return {
        state: 'running',
        running: true,
        sessionId: session.id,
        deviceAuth: session.deviceAuth,
      };
    }
    if (!expectedSessionId) return { state: 'idle', running: false };

    const terminal = this.#terminalSessions.get(expectedSessionId);
    if (terminal?.agentId === agentId) return terminal.status;
    return {
      state: 'failed',
      running: false,
      sessionId: expectedSessionId,
      error: SESSION_UNAVAILABLE_ERROR,
    };
  }

  async complete(agentId: string, sessionId: string, code: string): Promise<AgentAuthLoginCompleteResult> {
    const session = this.#sessions.get(agentId);
    const proc = session?.browserProcess;
    if (!session || session.id !== sessionId || !proc) {
      throw new AgentAuthLoginSessionError(`No matching pending auth login for agent: ${agentId}`);
    }

    if (!code.trim()) {
      throw new Error('code is required');
    }

    const sink = proc.stdin;
    if (!sink || typeof sink.write !== 'function') {
      throw new Error(`Pending auth login for ${agentId} cannot accept a code`);
    }

    if (session.phase !== 'running') {
      throw new AgentAuthLoginSessionError(`Auth login completion is already pending for agent: ${agentId}`);
    }
    // Claims completion before the first asynchronous sink operation.
    session.phase = 'completing';
    try {
      await sink.write(`${code.trim()}\n`);
      await sink.flush();
      await sink.end();
    } catch (error) {
      if (this.#sessions.get(agentId) === session) session.phase = 'running';
      throw error;
    }

    return { submitted: true, sessionId };
  }

  async #launchClaudeBrowserCodeLogin(agentId: string, session: AuthLoginSession): Promise<AgentAuthLoginLaunchResult> {
    let proc: SpawnedLoginProcess;
    try {
      proc = this.#spawnProcess(getClaudePipeLoginCommand(), agentId);
    } catch (error) {
      this.#finishSession(agentId, session, {
        state: 'failed',
        error: SESSION_FAILED_ERROR,
      });
      throw error;
    }
    session.browserProcess = proc;
    session.process = proc;

    const deviceAuth = await readBrowserAuthFromProcess(proc);
    if (!deviceAuth) {
      this.#finishSession(agentId, session, {
        state: 'failed',
        error: SESSION_FAILED_ERROR,
      });
      proc.kill();
      throw new Error('Claude auth login did not print a sign-in URL');
    }
    void proc.exited.then(
      (exitCode) => this.#finishFromExit(agentId, session, exitCode),
      (error) => {
        logger.warn(
          `agents: Claude auth login process failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#finishSession(agentId, session, {
          state: 'failed',
          error: SESSION_FAILED_ERROR,
        });
      },
    );
    if (this.#sessions.get(agentId) === session) {
      session.deviceAuth = deviceAuth;
    }
    return {
      launched: true,
      alreadyRunning: false,
      sessionId: session.id,
      deviceAuth,
    };
  }

  async #spawnPty(agentId: string, command: LoginCommand, session: AuthLoginSession): Promise<IPty> {
    const { spawn: ptySpawn } = await import('bun-pty');
    if (this.#sessions.get(agentId) !== session) {
      throw new Error(SESSION_EXPIRED_ERROR);
    }
    const [binary, ...args] = command;
    const proc = ptySpawn(binary, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: buildLoginEnv(agentId),
    });
    session.process = proc;

    proc.onExit((exit: IExitEvent) => {
      this.#finishFromExit(agentId, session, exit.exitCode);
      if (exit.exitCode !== 0) {
        logger.warn(
          `agents: ${agentId} auth login exited with code ${exit.exitCode}${exit.signal ? ` (${exit.signal})` : ''}`,
        );
      }
    });

    return proc;
  }

  #cacheDeviceAuth(agentId: string, session: AuthLoginSession, deviceAuth: AgentDeviceAuthInfo): void {
    if (this.#sessions.get(agentId) === session) session.deviceAuth = deviceAuth;
  }

  #startWatchdog(agentId: string, session: AuthLoginSession): void {
    session.watchdog = setTimeout(() => {
      if (this.#sessions.get(agentId) !== session) return;
      this.#finishSession(agentId, session, {
        state: 'failed',
        error: SESSION_EXPIRED_ERROR,
      });
      try {
        session.process?.kill();
      } catch (error) {
        logger.debug(
          `agents: expired auth login termination failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, this.#sessionTimeoutMs);
  }

  #finishFromExit(agentId: string, session: AuthLoginSession, exitCode: number): void {
    this.#finishSession(
      agentId,
      session,
      exitCode === 0 ? { state: 'succeeded' } : { state: 'failed', error: SESSION_FAILED_ERROR },
    );
  }

  #finishSession(
    agentId: string,
    session: AuthLoginSession,
    outcome: { state: 'succeeded' } | { state: 'failed'; error: string },
  ): void {
    if (this.#sessions.get(agentId) !== session) return;
    this.#sessions.delete(agentId);
    if (session.watchdog) clearTimeout(session.watchdog);
    const status: TerminalAuthLoginStatus = {
      ...outcome,
      running: false,
      sessionId: session.id,
    };
    const cleanup = setTimeout(() => {
      if (this.#terminalSessions.get(session.id)?.status === status) {
        this.#terminalSessions.delete(session.id);
      }
    }, this.#terminalSessionTtlMs);
    cleanup.unref?.();
    this.#terminalSessions.set(session.id, { agentId, status });
  }
}

const agentAuthLogin = new AgentAuthLoginManager();

export class AgentAuthLoginSessionError extends DomainError {
  constructor(message: string) {
    super('AUTH_LOGIN_SESSION_MISMATCH', message, 409);
    this.name = 'AgentAuthLoginSessionError';
  }
}

export function launchAgentAuthLogin(agentId: string): Promise<AgentAuthLoginLaunchResult> {
  return agentAuthLogin.launch(agentId);
}

export function completeAgentAuthLogin(
  agentId: string,
  sessionId: string,
  code: string,
): Promise<AgentAuthLoginCompleteResult> {
  return agentAuthLogin.complete(agentId, sessionId, code);
}

export function getAgentAuthLoginStatus(agentId: string, expectedSessionId?: string): AgentAuthLoginStatus {
  return agentAuthLogin.status(agentId, expectedSessionId);
}

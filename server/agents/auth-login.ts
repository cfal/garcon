import os from 'os';
import type { IPty, IExitEvent } from 'bun-pty';
import type {
  AgentAuthLoginCompleteResult,
  AgentAuthLoginLaunchResult,
  AgentAuthLoginStatus,
  AgentDeviceAuthInfo,
} from '../../common/agent-auth.js';
import { getClaudeBinary, getCursorBinary } from "../config.js";
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agents:auth-login');

type LoginCommand = [string, ...string[]];

type SpawnedLoginProcess = ReturnType<typeof Bun.spawn>;
type LoginProcessSpawner = (command: LoginCommand, agentId: string) => SpawnedLoginProcess;

interface AuthLoginSession {
  id: string;
  browserProcess?: SpawnedLoginProcess;
  deviceAuth?: AgentDeviceAuthInfo;
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
function readDeviceAuthFromPty(proc: IPty): Promise<AgentDeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    const timeout = setTimeout(() => resolve(null), DEVICE_AUTH_TIMEOUT_MS);

    proc.onData((chunk) => {
      output += chunk;
      const parsed = parseDeviceAuth(output);
      if (parsed) {
        clearTimeout(timeout);
        resolve(parsed);
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
        logger.debug(`agents: auth login output read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    void read(proc.stdout as ReadableStream<Uint8Array> | null);
    void read(proc.stderr as ReadableStream<Uint8Array> | null);
    void proc.exited.then((exitCode) => {
      if (exitCode !== 0) {
        logger.warn(`agents: browser auth login exited before auth URL with code ${exitCode}`);
      }
      finish(null);
    }).catch((error) => {
      logger.warn(`agents: browser auth login failed before auth URL: ${error instanceof Error ? error.message : String(error)}`);
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
  #spawnProcess: LoginProcessSpawner;

  constructor(options: { spawnProcess?: LoginProcessSpawner } = {}) {
    this.#spawnProcess = options.spawnProcess ?? defaultProcessSpawner;
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
    const session: AuthLoginSession = { id: crypto.randomUUID() };
    this.#sessions.set(agentId, session);

    try {
      const proc = await this.#spawnPty(agentId, command, session);
      const useDeviceAuth = DEVICE_AUTH_AGENTS.has(agentId);
      const deviceAuth = useDeviceAuth ? (await readDeviceAuthFromPty(proc)) ?? undefined : undefined;
      if (deviceAuth && this.#sessions.get(agentId) === session) {
        session.deviceAuth = deviceAuth;
      }
      return { launched: true, alreadyRunning: false, sessionId: session.id, deviceAuth };
    } catch (error) {
      if (agentId !== 'claude') {
        this.#releaseSession(agentId, session);
        throw error;
      }
      logger.warn(`agents: Claude PTY login failed, falling back to browser-code flow: ${error instanceof Error ? error.message : String(error)}`);
      return this.#launchClaudeBrowserCodeLogin(agentId, session);
    }
  }

  // Reports whether a login session is still in progress so clients can keep
  // device auth details visible until the session actually ends. Auth status
  // is not a usable completion signal because agents with stale credentials
  // report authenticated throughout a re-login.
  status(agentId: string): AgentAuthLoginStatus {
    const session = this.#sessions.get(agentId);
    if (session) {
      return { running: true, sessionId: session.id, deviceAuth: session.deviceAuth };
    }
    return { running: false };
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

    const stdin = proc.stdin;
    if (!stdin || typeof stdin !== 'object' || !('write' in stdin)) {
      throw new Error(`Pending auth login for ${agentId} cannot accept a code`);
    }

    const sink = stdin as {
      write(data: string): number | Promise<number>;
      flush?(): number | Promise<number>;
      end?(): number | Promise<number>;
    };
    await sink.write(`${code.trim()}\n`);
    await sink.flush?.();
    await sink.end?.();

    return { completed: true, sessionId };
  }

  async #launchClaudeBrowserCodeLogin(agentId: string, session: AuthLoginSession): Promise<AgentAuthLoginLaunchResult> {
    let proc: SpawnedLoginProcess;
    try {
      proc = this.#spawnProcess(getClaudePipeLoginCommand(), agentId);
    } catch (error) {
      this.#releaseSession(agentId, session);
      throw error;
    }
    session.browserProcess = proc;
    void proc.exited.finally(() => {
      this.#releaseSession(agentId, session);
    });

    const deviceAuth = await readBrowserAuthFromProcess(proc);
    if (!deviceAuth) {
      this.#releaseSession(agentId, session);
      proc.kill();
      throw new Error('Claude auth login did not print a sign-in URL');
    }
    if (this.#sessions.get(agentId) === session) {
      session.deviceAuth = deviceAuth;
    }
    return { launched: true, alreadyRunning: false, sessionId: session.id, deviceAuth };
  }

  async #spawnPty(agentId: string, command: LoginCommand, session: AuthLoginSession): Promise<IPty> {
    const { spawn: ptySpawn } = await import('bun-pty');
    const [binary, ...args] = command;
    const proc = ptySpawn(binary, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: buildLoginEnv(agentId),
    });

    proc.onExit((exit: IExitEvent) => {
      this.#releaseSession(agentId, session);
      if (exit.exitCode !== 0) {
        logger.warn(`agents: ${agentId} auth login exited with code ${exit.exitCode}${exit.signal ? ` (${exit.signal})` : ''}`);
      }
    });

    return proc;
  }

  #releaseSession(agentId: string, session: AuthLoginSession): void {
    if (this.#sessions.get(agentId) === session) {
      this.#sessions.delete(agentId);
    }
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

export function getAgentAuthLoginStatus(agentId: string): AgentAuthLoginStatus {
  return agentAuthLogin.status(agentId);
}

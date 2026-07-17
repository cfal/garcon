import os from 'os';
import type { IPty, IExitEvent } from 'bun-pty';
import { getClaudeBinary, getCursorBinary } from "../config.js";
import { createLogger } from '../lib/log.js';

const logger = createLogger('agents:auth-login');

type LoginCommand = [string, ...string[]];

type SpawnedLoginProcess = Bun.PipedSubprocess;
type LoginProcessSpawner = (command: LoginCommand, agentId: string) => SpawnedLoginProcess;

interface DeviceAuthInfo {
  url: string;
  code?: string;
  needsCode?: boolean;
}

interface AuthLoginLaunchResult {
  launched: boolean;
  alreadyRunning: boolean;
  deviceAuth?: DeviceAuthInfo;
}

interface AuthLoginCompleteResult {
  completed: boolean;
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
export function parseDeviceAuth(raw: string): DeviceAuthInfo | null {
  const output = stripAnsi(raw);
  const urlMatch = output.match(/https:\/\/\S+/);
  const codeMatch = output.match(/^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$/m);
  if (urlMatch && codeMatch) {
    return { url: urlMatch[0], code: codeMatch[1] };
  }
  return null;
}

export function parseBrowserAuth(raw: string): DeviceAuthInfo | null {
  const output = stripAnsi(raw);
  const urlMatch = output.match(/https:\/\/\S+/);
  if (!urlMatch) return null;
  return { url: urlMatch[0], needsCode: true };
}

// Reads PTY output via onData until device auth info is found or timeout.
function readDeviceAuthFromPty(proc: IPty): Promise<DeviceAuthInfo | null> {
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

function readBrowserAuthFromProcess(proc: SpawnedLoginProcess): Promise<DeviceAuthInfo | null> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => finish(null), DEVICE_AUTH_TIMEOUT_MS);

    function finish(value: DeviceAuthInfo | null): void {
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
  #sessions = new Map<string, IPty>();
  #browserSessions = new Map<string, SpawnedLoginProcess>();
  #spawnProcess: LoginProcessSpawner;

  constructor(options: { spawnProcess?: LoginProcessSpawner } = {}) {
    this.#spawnProcess = options.spawnProcess ?? defaultProcessSpawner;
  }

  async launch(agentId: string): Promise<AuthLoginLaunchResult> {
    const command = getLoginCommand(agentId);
    if (!command) {
      throw new Error(`Agent does not support UI login: ${agentId}`);
    }

    if (this.#sessions.has(agentId) || this.#browserSessions.has(agentId)) {
      return { launched: false, alreadyRunning: true };
    }

    try {
      const proc = await this.#spawnPty(agentId, command);
      const useDeviceAuth = DEVICE_AUTH_AGENTS.has(agentId);
      const deviceAuth = useDeviceAuth ? (await readDeviceAuthFromPty(proc)) ?? undefined : undefined;
      return { launched: true, alreadyRunning: false, deviceAuth };
    } catch (error) {
      if (agentId !== 'claude') throw error;
      logger.warn(`agents: Claude PTY login failed, falling back to browser-code flow: ${error instanceof Error ? error.message : String(error)}`);
      return this.#launchClaudeBrowserCodeLogin(agentId);
    }
  }

  async complete(agentId: string, code: string): Promise<AuthLoginCompleteResult> {
    const proc = this.#browserSessions.get(agentId);
    if (!proc) {
      throw new Error(`No pending auth login for agent: ${agentId}`);
    }

    if (!code.trim()) {
      throw new Error('code is required');
    }

    const sink = proc.stdin;
    if (!sink || typeof sink.write !== 'function') {
      throw new Error(`Pending auth login for ${agentId} cannot accept a code`);
    }

    await sink.write(`${code.trim()}\n`);
    await sink.flush();
    await sink.end();

    return { completed: true };
  }

  async #launchClaudeBrowserCodeLogin(agentId: string): Promise<AuthLoginLaunchResult> {
    const proc = this.#spawnProcess(getClaudePipeLoginCommand(), agentId);
    this.#browserSessions.set(agentId, proc);
    void proc.exited.finally(() => this.#browserSessions.delete(agentId));

    const deviceAuth = await readBrowserAuthFromProcess(proc);
    if (!deviceAuth) {
      this.#browserSessions.delete(agentId);
      proc.kill();
      throw new Error('Claude auth login did not print a sign-in URL');
    }
    return { launched: true, alreadyRunning: false, deviceAuth };
  }

  async #spawnPty(agentId: string, command: LoginCommand): Promise<IPty> {
    const { spawn: ptySpawn } = await import('bun-pty');
    const [binary, ...args] = command;
    const proc = ptySpawn(binary, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: buildLoginEnv(agentId),
    });

    this.#sessions.set(agentId, proc);
    proc.onExit((exit: IExitEvent) => {
      this.#sessions.delete(agentId);
      if (exit.exitCode !== 0) {
        logger.warn(`agents: ${agentId} auth login exited with code ${exit.exitCode}${exit.signal ? ` (${exit.signal})` : ''}`);
      }
    });

    return proc;
  }
}

const agentAuthLogin = new AgentAuthLoginManager();

export function launchAgentAuthLogin(agentId: string): Promise<AuthLoginLaunchResult> {
  return agentAuthLogin.launch(agentId);
}

export function completeAgentAuthLogin(agentId: string, code: string): Promise<AuthLoginCompleteResult> {
  return agentAuthLogin.complete(agentId, code);
}

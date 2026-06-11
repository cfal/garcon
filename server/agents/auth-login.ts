import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import type { IPty, IExitEvent } from 'bun-pty';
import { getClaudeBinary, getCursorBinary } from "../config.js";

type LoginCommand = [string, ...string[]];

interface DeviceAuthInfo {
  url: string;
  code: string;
}

interface AuthLoginLaunchResult {
  launched: boolean;
  alreadyRunning: boolean;
  deviceAuth?: DeviceAuthInfo;
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

export class AgentAuthLoginManager {
  #sessions = new Map<string, IPty>();

  async launch(agentId: string): Promise<AuthLoginLaunchResult> {
    const command = getLoginCommand(agentId);
    if (!command) {
      throw new Error(`Agent does not support UI login: ${agentId}`);
    }

    if (this.#sessions.has(agentId)) {
      return { launched: false, alreadyRunning: true };
    }

    const proc = this.#spawnPty(agentId, command);
    const useDeviceAuth = DEVICE_AUTH_AGENTS.has(agentId);
    const deviceAuth = useDeviceAuth ? (await readDeviceAuthFromPty(proc)) ?? undefined : undefined;
    return { launched: true, alreadyRunning: false, deviceAuth };
  }

  #spawnPty(agentId: string, command: LoginCommand): IPty {
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
        console.warn(`agents: ${agentId} auth login exited with code ${exit.exitCode}${exit.signal ? ` (${exit.signal})` : ''}`);
      }
    });

    return proc;
  }
}

const agentAuthLogin = new AgentAuthLoginManager();

export function launchAgentAuthLogin(agentId: string): Promise<AuthLoginLaunchResult> {
  return agentAuthLogin.launch(agentId);
}

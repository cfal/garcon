import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import { getClaudeBinary } from '../config.js';

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

function getClaudeLoginCommand() {
  // Removes CLAUDECODE inside the spawned process because bun-pty merges its env with the parent env.
  return [process.execPath, '-e', CLAUDE_LOGIN_WRAPPER, getClaudeBinary(), 'auth', 'login'];
}

function getLoginCommand(provider) {
  if (provider === 'claude') return getClaudeLoginCommand();
  if (provider === 'codex') return ['codex', 'login', '--device-auth'];
  return null;
}

// Providers that use device-code auth instead of browser redirect.
const DEVICE_AUTH_PROVIDERS = new Set(['codex']);

const DEVICE_AUTH_TIMEOUT_MS = 10_000;

// Strip ANSI escape sequences so the regex can match clean text.
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Parses device auth URL and one-time code from CLI output.
export function parseDeviceAuth(raw) {
  const output = stripAnsi(raw);
  const urlMatch = output.match(/https:\/\/\S+/);
  const codeMatch = output.match(/^\s+([A-Z0-9]+-[A-Z0-9]+)\s*$/m);
  if (urlMatch && codeMatch) {
    return { url: urlMatch[0], code: codeMatch[1] };
  }
  return null;
}

// Reads PTY output via onData until device auth info is found or timeout.
function readDeviceAuthFromPty(proc) {
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

function buildLoginEnv(provider) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };

  // Claude refuses to launch inside another Claude Code session.
  if (provider === 'claude') {
    delete env.CLAUDECODE;
  }

  return env;
}

export class ProviderAuthLoginManager {
  #sessions = new Map();

  async launch(provider) {
    const command = getLoginCommand(provider);
    if (!command) {
      throw new Error(`Provider does not support UI login: ${provider}`);
    }

    if (this.#sessions.has(provider)) {
      return { launched: false, alreadyRunning: true };
    }

    const proc = this.#spawnPty(provider, command);
    const useDeviceAuth = DEVICE_AUTH_PROVIDERS.has(provider);
    const deviceAuth = useDeviceAuth ? (await readDeviceAuthFromPty(proc)) ?? undefined : undefined;
    return { launched: true, alreadyRunning: false, deviceAuth };
  }

  #spawnPty(provider, command) {
    const [binary, ...args] = command;
    const proc = ptySpawn(binary, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: buildLoginEnv(provider),
    });

    this.#sessions.set(provider, proc);
    proc.onExit((exit) => {
      this.#sessions.delete(provider);
      if (exit.exitCode !== 0) {
        console.warn(`providers: ${provider} auth login exited with code ${exit.exitCode}${exit.signal ? ` (${exit.signal})` : ''}`);
      }
    });

    return proc;
  }
}

const providerAuthLogin = new ProviderAuthLoginManager();

export function launchProviderAuthLogin(provider) {
  return providerAuthLogin.launch(provider);
}

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
  if (provider === 'codex') return ['codex', 'login'];
  return null;
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

  launch(provider) {
    const command = getLoginCommand(provider);
    if (!command) {
      throw new Error(`Provider does not support UI login: ${provider}`);
    }

    if (this.#sessions.has(provider)) {
      return { launched: false, alreadyRunning: true };
    }

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

    return { launched: true, alreadyRunning: false };
  }
}

const providerAuthLogin = new ProviderAuthLoginManager();

export function launchProviderAuthLogin(provider) {
  return providerAuthLogin.launch(provider);
}

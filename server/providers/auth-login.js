import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';

const LOGIN_COMMANDS = {
  claude: ['claude', 'auth', 'login'],
  codex: ['codex', 'login'],
};

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
    const command = LOGIN_COMMANDS[provider];
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

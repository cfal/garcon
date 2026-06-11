import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import { sendWebSocketJson } from './utils.js';
import { getUserShell } from '../config.js';
import { parseShellClientMessage, shellError, shellExit, shellOutput } from '../../common/shell-ws.ts';
import {
  assertWithinProjectBase,
  isProjectBoundaryError,
  PROJECT_BOUNDARY_ERROR_CODE,
  PROJECT_BOUNDARY_ERROR_MESSAGE,
} from '../lib/path-boundary.ts';

const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;

class PtySessionStore {
  #sessions = new Map();

  get(key) { return this.#sessions.get(key) ?? null; }
  set(key, session) { this.#sessions.set(key, session); }
  delete(key) { this.#sessions.delete(key); }
  clear() { this.#sessions.clear(); }
  entries() { return this.#sessions.entries(); }
}

export class ShellManager {
  #sessions = new PtySessionStore();

  #getShellState(ws) {
    if (!ws.data.shellState) {
      ws.data.shellState = {
        shellProcess: null,
        ptySessionKey: null,
      };
    }
    return ws.data.shellState;
  }

  createHandler() {
    return {
      open: (ws) => this.#handleOpen(ws),
      message: (ws, data) => this.#handleMessage(ws, data),
      close: (ws, code, reason) => this.#handleClose(ws, code, reason),
    };
  }

  shutdown() {
    for (const [ptySessionKey, session] of this.#sessions.entries()) {
      this.#killSession(ptySessionKey, session);
    }
    this.#sessions.clear();
  }

  #killSession(ptySessionKey, session) {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
    if (session.pty?.kill) {
      try {
        session.pty.kill();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('shell: failed to kill PTY session:', ptySessionKey, message);
      }
    }
  }

  #handleOpen(ws) {
    console.log('shell: client connected');
    this.#getShellState(ws);
  }

  async #handleMessage(ws, data) {
    const message = parseShellClientMessage(data);
    if (!message) {
      sendWebSocketJson(ws, shellError('Invalid shell message'));
      return;
    }

    try {
      console.log('shell: message received:', message.type);
      if (message.type === 'init') {
        await this.#handleInit(ws, message);
      } else if (message.type === 'input') {
        this.#handleInput(ws, message);
      } else if (message.type === 'resize') {
        this.#handleResize(ws, message);
      }
    } catch (error) {
      console.error('shell: websocket error:', error.message);
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`));
    }
  }

  async #handleInit(ws, message) {
    const shellState = this.#getShellState(ws);
    let projectPath;
    try {
      projectPath = assertWithinProjectBase(message.projectPath || process.cwd());
    } catch (error) {
      if (!isProjectBoundaryError(error)) throw error;
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${PROJECT_BOUNDARY_ERROR_MESSAGE}\x1b[0m\r\n`));
      ws.close?.(1008, PROJECT_BOUNDARY_ERROR_CODE);
      return;
    }

    const chatId = message.chatId;
    const initialCommand = message.initialCommand;
    const baseKey = `${projectPath}_chat_${chatId || 'none'}`;
    const ptySessionKey = message.sessionPolicy === 'fresh'
      ? `${baseKey}_fresh_${crypto.randomUUID()}`
      : `${baseKey}_shared`;
    shellState.ptySessionKey = ptySessionKey;

    if (message.sessionPolicy === 'fresh') {
      const oldSession = this.#sessions.get(ptySessionKey);
      if (oldSession) {
        this.#killSession(ptySessionKey, oldSession);
        this.#sessions.delete(ptySessionKey);
      }
    }

    const existingSession = message.sessionPolicy === 'reuse'
      ? this.#sessions.get(ptySessionKey)
      : null;
    if (existingSession) {
      this.#attachExistingSession(ws, shellState, ptySessionKey, existingSession);
      return;
    }

    this.#startSession(ws, shellState, {
      ptySessionKey,
      projectPath,
      initialCommand,
      cols: message.cols,
      rows: message.rows,
    });
  }

  #attachExistingSession(ws, shellState, ptySessionKey, existingSession) {
    console.log('shell: reconnecting to existing PTY session:', ptySessionKey);
    shellState.shellProcess = existingSession.pty;

    clearTimeout(existingSession.timeoutId);

    sendWebSocketJson(ws, shellOutput('\x1b[36m[Reconnected to existing session]\x1b[0m\r\n'));

    if (existingSession.buffer && existingSession.buffer.length > 0) {
      console.log(`shell: sending ${existingSession.buffer.length} buffered messages`);
      existingSession.buffer.forEach((bufferedData) => {
        sendWebSocketJson(ws, shellOutput(bufferedData));
      });
    }

    existingSession.ws = ws;
  }

  #startSession(ws, shellState, { ptySessionKey, projectPath, initialCommand, cols, rows }) {
    console.log('shell: starting in:', projectPath);
    if (initialCommand) {
      console.log('shell: initial command:', initialCommand);
    }

    sendWebSocketJson(ws, shellOutput(`\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`));

    try {
      const ptyEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
      };

      let shell;
      let shellArgs;
      let shellCwd;
      if (initialCommand) {
        if (os.platform() === 'win32') {
          shell = 'powershell.exe';
          shellArgs = ['-Command', `Set-Location -Path "${projectPath}"; ${initialCommand}`];
        } else {
          shell = 'bash';
          shellArgs = ['-c', `cd "${projectPath}" && ${initialCommand}`];
        }
        shellCwd = os.homedir();
      } else {
        shell = getUserShell();
        shellArgs = [];
        shellCwd = projectPath;
      }

      const shellProcess = ptySpawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: shellCwd,
        env: ptyEnv,
      });
      shellState.shellProcess = shellProcess;

      console.log('shell: process started, PID:', shellProcess.pid);

      this.#sessions.set(ptySessionKey, {
        pty: shellProcess,
        ws,
        buffer: [],
        timeoutId: null,
        projectPath,
      });

      this.#wirePtySession(shellState, ptySessionKey, shellProcess);
    } catch (spawnError) {
      console.error('shell: error spawning process:', spawnError);
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`));
    }
  }

  #wirePtySession(shellState, ptySessionKey, shellProcess) {
    shellProcess.onData((chunk) => {
      const session = this.#sessions.get(ptySessionKey);
      if (!session) return;

      if (session.buffer.length < 5000) {
        session.buffer.push(chunk);
      } else {
        session.buffer.shift();
        session.buffer.push(chunk);
      }

      if (session.ws) {
        sendWebSocketJson(session.ws, shellOutput(chunk));
      }
    });

    shellProcess.onExit((exitCode) => {
      console.log('shell: process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
      const session = this.#sessions.get(ptySessionKey);
      if (session && session.ws) {
        sendWebSocketJson(session.ws, shellOutput(`\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`));
        sendWebSocketJson(session.ws, shellExit(exitCode.exitCode, exitCode.signal));
      }
      if (session && session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = null;
      }
      this.#sessions.delete(ptySessionKey);
      if (shellState.ptySessionKey === ptySessionKey) {
        shellState.shellProcess = null;
      }
    });
  }

  #handleInput(ws, message) {
    const shellState = this.#getShellState(ws);
    if (shellState.shellProcess && shellState.shellProcess.write) {
      try {
        shellState.shellProcess.write(message.data);
      } catch (error) {
        console.error('Error writing to shell:', error);
      }
    } else {
      console.warn('No active shell process to send input to');
    }
  }

  #handleResize(ws, message) {
    const shellState = this.#getShellState(ws);
    if (shellState.shellProcess && shellState.shellProcess.resize) {
      console.log('Terminal resize requested:', message.cols, 'x', message.rows);
      shellState.shellProcess.resize(message.cols, message.rows);
    }
  }

  #handleClose(ws, code, reason) {
    console.log('shell: client disconnected', code ?? '', reason ? `(${reason})` : '');
    const shellState = this.#getShellState(ws);
    const { ptySessionKey } = shellState;
    if (!ptySessionKey) return;

    const session = this.#sessions.get(ptySessionKey);
    if (session) {
      console.log('shell: PTY session kept alive, will timeout in 30 minutes:', ptySessionKey);
      session.ws = null;
      if (session.timeoutId) clearTimeout(session.timeoutId);

      session.timeoutId = setTimeout(() => {
        console.log('shell: PTY session timeout, killing process:', ptySessionKey);
        this.#killSession(ptySessionKey, session);
        this.#sessions.delete(ptySessionKey);
      }, PTY_SESSION_TIMEOUT);
      session.timeoutId.unref?.();
    }
  }
}

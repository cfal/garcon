import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import { sendWebSocketJson } from './utils.js';
import { getUserShell } from '../config.js';
import {
  parseShellClientMessage,
  shellError,
  shellExit,
  shellOutput,
  type ShellInitRequest,
  type ShellInputRequest,
  type ShellResizeRequest,
} from '../../common/shell-ws.ts';
import {
  assertWithinProjectBase,
  isProjectBoundaryError,
  PROJECT_BOUNDARY_ERROR_CODE,
  PROJECT_BOUNDARY_ERROR_MESSAGE,
} from '../lib/path-boundary.ts';

const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;

interface ShellSocketState {
  shellProcess: IPty | null;
  ptySessionKey: string | null;
}

interface ShellWebSocketData {
  pathname?: string;
  shellState?: ShellSocketState;
}

type ShellWebSocket = import('bun').ServerWebSocket<ShellWebSocketData>;

interface PtySession {
  pty: IPty;
  ws: ShellWebSocket | null;
  buffer: string[];
  timeoutId: ReturnType<typeof setTimeout> | null;
  projectPath: string;
}

interface ShellHandler {
  open(ws: ShellWebSocket): void;
  message(ws: ShellWebSocket, data: unknown): Promise<void>;
  close(ws: ShellWebSocket, code?: number, reason?: string): void;
}

interface StartSessionOptions {
  ptySessionKey: string;
  projectPath: string;
  initialCommand?: string;
  cols: number;
  rows: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPtyEnv(): Record<string, string> {
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

class PtySessionStore {
  #sessions = new Map<string, PtySession>();

  get(key: string): PtySession | null { return this.#sessions.get(key) ?? null; }
  set(key: string, session: PtySession): void { this.#sessions.set(key, session); }
  delete(key: string): void { this.#sessions.delete(key); }
  clear(): void { this.#sessions.clear(); }
  entries(): IterableIterator<[string, PtySession]> { return this.#sessions.entries(); }
}

export class ShellManager {
  #sessions = new PtySessionStore();

  #getShellState(ws: ShellWebSocket): ShellSocketState {
    if (!ws.data.shellState) {
      ws.data.shellState = {
        shellProcess: null,
        ptySessionKey: null,
      };
    }
    return ws.data.shellState;
  }

  createHandler(): ShellHandler {
    return {
      open: (ws) => this.#handleOpen(ws),
      message: (ws, data) => this.#handleMessage(ws, data),
      close: (ws, code, reason) => this.#handleClose(ws, code, reason),
    };
  }

  shutdown(): void {
    for (const [ptySessionKey, session] of this.#sessions.entries()) {
      this.#killSession(ptySessionKey, session);
    }
    this.#sessions.clear();
  }

  #killSession(ptySessionKey: string, session: PtySession): void {
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
    if (session.pty?.kill) {
      try {
        session.pty.kill();
      } catch (error) {
        console.warn('shell: failed to kill PTY session:', ptySessionKey, errorMessage(error));
      }
    }
  }

  #handleOpen(ws: ShellWebSocket): void {
    console.log('shell: client connected');
    this.#getShellState(ws);
  }

  async #handleMessage(ws: ShellWebSocket, data: unknown): Promise<void> {
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
      const message = errorMessage(error);
      console.error('shell: websocket error:', message);
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${message}\x1b[0m\r\n`));
    }
  }

  async #handleInit(ws: ShellWebSocket, message: ShellInitRequest): Promise<void> {
    const shellState = this.#getShellState(ws);
    let projectPath: string;
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

  #attachExistingSession(
    ws: ShellWebSocket,
    shellState: ShellSocketState,
    ptySessionKey: string,
    existingSession: PtySession,
  ): void {
    console.log('shell: reconnecting to existing PTY session:', ptySessionKey);
    shellState.shellProcess = existingSession.pty;

    if (existingSession.timeoutId) {
      clearTimeout(existingSession.timeoutId);
      existingSession.timeoutId = null;
    }

    sendWebSocketJson(ws, shellOutput('\x1b[36m[Reconnected to existing session]\x1b[0m\r\n'));

    if (existingSession.buffer && existingSession.buffer.length > 0) {
      console.log(`shell: sending ${existingSession.buffer.length} buffered messages`);
      existingSession.buffer.forEach((bufferedData) => {
        sendWebSocketJson(ws, shellOutput(bufferedData));
      });
    }

    existingSession.ws = ws;
  }

  #startSession(
    ws: ShellWebSocket,
    shellState: ShellSocketState,
    { ptySessionKey, projectPath, initialCommand, cols, rows }: StartSessionOptions,
  ): void {
    console.log('shell: starting in:', projectPath);
    if (initialCommand) {
      console.log('shell: initial command:', initialCommand);
    }

    sendWebSocketJson(ws, shellOutput(`\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`));

    try {
      const ptyEnv = buildPtyEnv();

      let shell: string;
      let shellArgs: string[];
      let shellCwd: string;
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
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${errorMessage(spawnError)}\x1b[0m\r\n`));
    }
  }

  #wirePtySession(shellState: ShellSocketState, ptySessionKey: string, shellProcess: IPty): void {
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
      const signal = typeof exitCode.signal === 'string' ? exitCode.signal : undefined;
      const session = this.#sessions.get(ptySessionKey);
      if (session && session.ws) {
        sendWebSocketJson(session.ws, shellOutput(`\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${signal ? ` (${signal})` : ''}\x1b[0m\r\n`));
        sendWebSocketJson(session.ws, shellExit(exitCode.exitCode, signal));
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

  #handleInput(ws: ShellWebSocket, message: ShellInputRequest): void {
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

  #handleResize(ws: ShellWebSocket, message: ShellResizeRequest): void {
    const shellState = this.#getShellState(ws);
    if (shellState.shellProcess && shellState.shellProcess.resize) {
      console.log('Terminal resize requested:', message.cols, 'x', message.rows);
      shellState.shellProcess.resize(message.cols, message.rows);
    }
  }

  #handleClose(ws: ShellWebSocket, code?: number, reason?: string): void {
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

import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import { sendWebSocketJson } from './utils.js';
import { getUserShell } from '../config.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';

const logger = createLogger('ws:shell');
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
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  PROJECT_BOUNDARY_ERROR_CODE,
  PROJECT_BOUNDARY_ERROR_MESSAGE,
} from '../lib/path-boundary.ts';

const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const MAX_REPLAY_BUFFER_BYTES = 1024 * 1024;

export interface ShellSocketState {
  shellProcess: IPty | null;
  ptySessionKey: string | null;
}

export interface ShellWebSocketData {
  pathname?: string;
  shellState?: ShellSocketState;
}

type ShellWebSocket = import('bun').ServerWebSocket<ShellWebSocketData>;

interface PtySession {
  pty: IPty;
  ws: ShellWebSocket | null;
  buffer: string[];
  bufferBytes: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
  projectPath: string;
  sessionPolicy: 'reuse' | 'fresh';
}

interface ShellHandler {
  open(ws: ShellWebSocket): void;
  message(ws: ShellWebSocket, data: unknown): Promise<void>;
  close(ws: ShellWebSocket, code?: number, reason?: string): void;
}

interface StartSessionOptions {
  ptySessionKey: string;
  projectPath: string;
  sessionPolicy: 'reuse' | 'fresh';
  initialCommand?: string;
  cols: number;
  rows: number;
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
        logger.warn('shell: failed to kill PTY session:', ptySessionKey, errorMessage(error));
      }
    }
  }

  #handleOpen(ws: ShellWebSocket): void {
    logger.info('shell: client connected');
    this.#getShellState(ws);
  }

  async #handleMessage(ws: ShellWebSocket, data: unknown): Promise<void> {
    const message = parseShellClientMessage(data);
    if (!message) {
      sendWebSocketJson(ws, shellError('Invalid shell message'));
      return;
    }

    try {
      logger.info('shell: message received:', message.type);
      if (message.type === 'init') {
        await this.#handleInit(ws, message);
      } else if (message.type === 'input') {
        this.#handleInput(ws, message);
      } else if (message.type === 'resize') {
        this.#handleResize(ws, message);
      }
    } catch (error) {
      const message = errorMessage(error);
      logger.error('shell: websocket error:', message);
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${message}\x1b[0m\r\n`));
    }
  }

  async #handleInit(ws: ShellWebSocket, message: ShellInitRequest): Promise<void> {
    const shellState = this.#getShellState(ws);
    let projectPath: string;
    try {
      projectPath = await assertRealWithinProjectBase(message.projectPath || process.cwd());
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
    this.#detachSocketSession(ws, shellState);
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
      sessionPolicy: message.sessionPolicy,
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
    logger.info('shell: reconnecting to existing PTY session:', ptySessionKey);
    shellState.shellProcess = existingSession.pty;

    if (existingSession.timeoutId) {
      clearTimeout(existingSession.timeoutId);
      existingSession.timeoutId = null;
    }

    sendWebSocketJson(ws, shellOutput('\x1b[36m[Reconnected to existing session]\x1b[0m\r\n'));

    if (existingSession.buffer.length > 0) {
      logger.info(`shell: replaying ${existingSession.bufferBytes} buffered bytes`);
      sendWebSocketJson(ws, shellOutput(existingSession.buffer.join('')));
    }

    existingSession.ws = ws;
  }

  #startSession(
    ws: ShellWebSocket,
    shellState: ShellSocketState,
    { ptySessionKey, projectPath, sessionPolicy, initialCommand, cols, rows }: StartSessionOptions,
  ): void {
    logger.info('shell: starting in:', projectPath);
    if (initialCommand) {
      logger.debug('shell: initial command provided');
    }

    sendWebSocketJson(ws, shellOutput(`\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`));

    try {
      const ptyEnv = buildPtyEnv();

      let shell: string;
      let shellArgs: string[];
      if (initialCommand) {
        if (os.platform() === 'win32') {
          shell = 'powershell.exe';
          shellArgs = ['-Command', initialCommand];
        } else {
          shell = 'bash';
          shellArgs = ['-c', initialCommand];
        }
      } else {
        shell = getUserShell();
        shellArgs = [];
      }

      const shellProcess = ptySpawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: projectPath,
        env: ptyEnv,
      });
      shellState.shellProcess = shellProcess;

      logger.info('shell: process started, PID:', shellProcess.pid);

      this.#sessions.set(ptySessionKey, {
        pty: shellProcess,
        ws,
        buffer: [],
        bufferBytes: 0,
        timeoutId: null,
        projectPath,
        sessionPolicy,
      });

      this.#wirePtySession(shellState, ptySessionKey, shellProcess);
    } catch (spawnError) {
      logger.error('shell: error spawning process:', spawnError);
      sendWebSocketJson(ws, shellOutput(`\r\n\x1b[31mError: ${errorMessage(spawnError)}\x1b[0m\r\n`));
    }
  }

  #wirePtySession(shellState: ShellSocketState, ptySessionKey: string, shellProcess: IPty): void {
    shellProcess.onData((chunk) => {
      const session = this.#sessions.get(ptySessionKey);
      if (!session) return;

      this.#appendReplayBuffer(session, chunk);

      if (session.ws) {
        sendWebSocketJson(session.ws, shellOutput(chunk));
      }
    });

    shellProcess.onExit((exitCode) => {
      logger.info('shell: process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
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

  #appendReplayBuffer(session: PtySession, chunk: string): void {
    let nextChunk = chunk;
    let chunkBytes = Buffer.byteLength(nextChunk, 'utf8');
    if (chunkBytes > MAX_REPLAY_BUFFER_BYTES) {
      const bytes = Buffer.from(nextChunk, 'utf8');
      nextChunk = bytes.subarray(bytes.length - MAX_REPLAY_BUFFER_BYTES).toString('utf8');
      chunkBytes = Buffer.byteLength(nextChunk, 'utf8');
    }

    session.buffer.push(nextChunk);
    session.bufferBytes += chunkBytes;
    while (session.bufferBytes > MAX_REPLAY_BUFFER_BYTES && session.buffer.length > 0) {
      const removed = session.buffer.shift();
      if (removed) session.bufferBytes -= Buffer.byteLength(removed, 'utf8');
    }
  }

  #handleInput(ws: ShellWebSocket, message: ShellInputRequest): void {
    const shellState = this.#getShellState(ws);
    const session = shellState.ptySessionKey ? this.#sessions.get(shellState.ptySessionKey) : null;
    if (session?.ws === ws && session.pty.write) {
      try {
        session.pty.write(message.data);
      } catch (error) {
        logger.error('Error writing to shell:', error);
      }
    } else {
      logger.warn('No active shell process to send input to');
    }
  }

  #handleResize(ws: ShellWebSocket, message: ShellResizeRequest): void {
    const shellState = this.#getShellState(ws);
    const session = shellState.ptySessionKey ? this.#sessions.get(shellState.ptySessionKey) : null;
    if (session?.ws === ws && session.pty.resize) {
      logger.info('Terminal resize requested:', message.cols, 'x', message.rows);
      session.pty.resize(message.cols, message.rows);
    }
  }

  #detachSocketSession(ws: ShellWebSocket, shellState: ShellSocketState): void {
    const { ptySessionKey } = shellState;
    if (!ptySessionKey) return;

    const session = this.#sessions.get(ptySessionKey);
    if (session?.ws === ws) {
      this.#detachSession(ptySessionKey, session);
    }
    shellState.shellProcess = null;
    shellState.ptySessionKey = null;
  }

  #detachSession(ptySessionKey: string, session: PtySession): void {
    if (session.sessionPolicy === 'fresh') {
      logger.info('shell: fresh PTY session replaced, killing process:', ptySessionKey);
      this.#killSession(ptySessionKey, session);
      this.#sessions.delete(ptySessionKey);
      return;
    }

    logger.info('shell: PTY session detached, will timeout in 30 minutes:', ptySessionKey);
    session.ws = null;
    if (session.timeoutId) clearTimeout(session.timeoutId);
    session.timeoutId = setTimeout(() => {
      logger.info('shell: PTY session timeout, killing process:', ptySessionKey);
      this.#killSession(ptySessionKey, session);
      this.#sessions.delete(ptySessionKey);
    }, PTY_SESSION_TIMEOUT);
    session.timeoutId.unref?.();
  }

  #handleClose(ws: ShellWebSocket, code?: number, reason?: string): void {
    logger.info('shell: client disconnected', code ?? '', reason ? `(${reason})` : '');
    const shellState = this.#getShellState(ws);
    const { ptySessionKey } = shellState;
    if (!ptySessionKey) return;

    const session = this.#sessions.get(ptySessionKey);
    if (session) {
      if (session.ws !== ws) return;
      this.#detachSession(ptySessionKey, session);
      shellState.shellProcess = null;
      shellState.ptySessionKey = null;
    }
  }
}

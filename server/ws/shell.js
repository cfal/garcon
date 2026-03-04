import os from 'os';
import { spawn as ptySpawn } from 'bun-pty';
import { sendWebSocketJson } from './utils.js';
import { getUserShell } from '../config.js';

const DEBUG_SHELL = process.env.GARCON_DEBUG_SHELL === '1';

const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;

export class ShellManager {
  #sessions = new Map();

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

  #handleOpen(ws) {
    console.log('shell: client connected');
    this.#getShellState(ws);
  }

  async #handleMessage(ws, data) {
    const shellState = this.#getShellState(ws);

    try {
      if (DEBUG_SHELL) console.log('shell: message received:', data.type);

      if (data.type === 'init') {
        const projectPath = data.projectPath || process.cwd();
        const chatId = data.chatId;
        const initialCommand = data.initialCommand;

        const sessionPolicy = data.sessionPolicy === 'fresh' ? 'fresh' : 'reuse';

        const baseKey = `${projectPath}_chat_${chatId || 'none'}`;
        const ptySessionKey = sessionPolicy === 'fresh'
          ? `${baseKey}_fresh_${crypto.randomUUID()}`
          : `${baseKey}_shared`;
        shellState.ptySessionKey = ptySessionKey;

        if (sessionPolicy === 'fresh') {
          const oldSession = this.#sessions.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
            if (oldSession.pty?.kill) oldSession.pty.kill();
            this.#sessions.delete(ptySessionKey);
          }
        }

        const existingSession = sessionPolicy === 'reuse'
          ? this.#sessions.get(ptySessionKey)
          : null;
        if (existingSession) {
          if (DEBUG_SHELL) console.log('shell: reconnecting to existing PTY session:', ptySessionKey);
          shellState.shellProcess = existingSession.pty;

          clearTimeout(existingSession.timeoutId);

          sendWebSocketJson(ws, {
            type: 'output',
            data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
          });

          if (existingSession.buffer && existingSession.buffer.length > 0) {
            if (DEBUG_SHELL) console.log(`shell: sending ${existingSession.buffer.length} buffered messages`);
            existingSession.buffer.forEach((bufferedData) => {
              sendWebSocketJson(ws, {
                type: 'output',
                data: bufferedData,
              });
            });
          }

          existingSession.ws = ws;
          return;
        }

        console.log('shell: starting in:', projectPath);
        if (initialCommand) {
          console.log('shell: initial command:', initialCommand);
        }

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (chatId) {
          welcomeMsg += `\x1b[90mResume session: claude --resume ${chatId}\x1b[0m\r\n`;
        }

        sendWebSocketJson(ws, {
          type: 'output',
          data: welcomeMsg,
        });

        try {
          const termCols = data.cols || 80;
          const termRows = data.rows || 24;

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
            cols: termCols,
            rows: termRows,
            cwd: shellCwd,
            env: ptyEnv,
          });
          shellState.shellProcess = shellProcess;

          if (DEBUG_SHELL) console.log('shell: process started, PID:', shellProcess.pid);

          this.#sessions.set(ptySessionKey, {
            pty: shellProcess,
            ws,
            buffer: [],
            timeoutId: null,
            projectPath,
          });

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
              sendWebSocketJson(session.ws, {
                type: 'output',
                data: chunk,
              });
            }
          });

          shellProcess.onExit((exitCode) => {
            console.log('shell: process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
            const session = this.#sessions.get(ptySessionKey);
            if (session && session.ws) {
              sendWebSocketJson(session.ws, {
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`,
              });
              sendWebSocketJson(session.ws, {
                type: 'exit',
                exitCode: exitCode.exitCode,
                signal: exitCode.signal,
              });
            }
            if (session && session.timeoutId) {
              clearTimeout(session.timeoutId);
            }
            this.#sessions.delete(ptySessionKey);
            if (shellState.ptySessionKey === ptySessionKey) {
              shellState.shellProcess = null;
            }
          });
        } catch (spawnError) {
          console.error('shell: error spawning process:', spawnError);
          sendWebSocketJson(ws, {
            type: 'output',
            data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`,
          });
        }
      } else if (data.type === 'input') {
        if (shellState.shellProcess && shellState.shellProcess.write) {
          try {
            shellState.shellProcess.write(data.data);
          } catch (error) {
            console.error('Error writing to shell:', error);
          }
        } else {
          console.warn('No active shell process to send input to');
        }
      } else if (data.type === 'resize') {
        if (shellState.shellProcess && shellState.shellProcess.resize) {
          console.log('Terminal resize requested:', data.cols, 'x', data.rows);
          shellState.shellProcess.resize(data.cols, data.rows);
        }
      }
    } catch (error) {
      console.error('shell: websocket error:', error.message);
      sendWebSocketJson(ws, {
        type: 'output',
        data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`,
      });
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

      session.timeoutId = setTimeout(() => {
        console.log('shell: PTY session timeout, killing process:', ptySessionKey);
        if (session.pty && session.pty.kill) {
          session.pty.kill();
        }
        this.#sessions.delete(ptySessionKey);
      }, PTY_SESSION_TIMEOUT);
    }
  }
}

// Backward-compat shim: module-level default instance.
const _default = new ShellManager();
export const shellHandler = _default.createHandler();

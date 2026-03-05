// Amp CLI integration. Uses `--stream-json` (Claude-compatible event
// schema) and maps events into unified ChatMessage types.

import { getAmpBinary } from '../config.js';
import { normalizeToolResultContent } from '../chats/normalize.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, ErrorMessage } from '../../common/chat-types.js';
import { convertClaudeToolUse } from './converters/claude-tool-use.js';
import { AbsProvider } from './base.js';

function extractContentParts(msg) {
  return Array.isArray(msg?.content)
    ? msg.content
    : Array.isArray(msg?.message?.content)
      ? msg.message.content
      : [];
}

function extractToolResultId(part) {
  return part?.tool_use_id || part?.toolUseID || part?.toolUseId || '';
}

function extractToolResultPayload(part) {
  if (part?.run && typeof part.run === 'object') {
    if (part.run.result !== undefined) return part.run.result;
    if (part.run.error !== undefined) return part.run.error;
    return part.run;
  }
  return part?.content;
}

function isToolResultError(part) {
  if (typeof part?.is_error === 'boolean') return part.is_error;
  if (typeof part?.isError === 'boolean') return part.isError;
  if (part?.run?.status) {
    return String(part.run.status).toLowerCase() !== 'done';
  }
  return false;
}

// Converts a single Amp stream event into ChatMessage objects.
export function convertAmpEventToChatMessages(msg) {
  const ts = new Date().toISOString();
  const out = [];

  if (msg?.type === 'assistant') {
    const content = extractContentParts(msg);
    for (const part of content) {
      if (part?.type === 'text' && part.text?.trim()) {
        out.push(new AssistantMessage(ts, part.text));
      } else if (part?.type === 'thinking' && part.thinking) {
        out.push(new ThinkingMessage(ts, part.thinking));
      } else if (part?.type === 'tool_use') {
        out.push(convertClaudeToolUse(ts, part));
      } else if (part?.type === 'tool_result') {
        out.push(new ToolResultMessage(
          ts,
          extractToolResultId(part),
          normalizeToolResultContent(extractToolResultPayload(part)),
          isToolResultError(part),
        ));
      }
    }
    return out;
  }

  if (msg?.type === 'user') {
    const content = extractContentParts(msg);
    for (const part of content) {
      if (part?.type !== 'tool_result') continue;
      out.push(new ToolResultMessage(
        ts,
        extractToolResultId(part),
        normalizeToolResultContent(extractToolResultPayload(part)),
        isToolResultError(part),
      ));
    }
    return out;
  }

  if (msg?.type === 'error' && typeof msg.message === 'string' && msg.message.trim()) {
    out.push(new ErrorMessage(ts, msg.message));
  }

  return out;
}

function buildAmpArgs({ sessionId, model, permissionMode = 'default' } = {}) {
  const args = sessionId
    ? ['threads', 'continue', sessionId]
    : [];

  args.push('--execute', '--stream-json', '--no-ide', '--no-jetbrains');

  if (typeof model === 'string' && model.trim()) {
    args.push('--mode', model);
  }

  // Amp permission controls are coarse; map bypass mode to allow-all.
  if (permissionMode === 'bypassPermissions') {
    args.push('--dangerously-allow-all');
  }

  return args;
}

async function runAmpExec(args, prompt, cwd) {
  const proc = Bun.spawn([getAmpBinary(), ...args], {
    cwd: cwd || process.cwd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (proc.stdin) {
    proc.stdin.write(String(prompt ?? ''));
    proc.stdin.write('\n');
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Amp exec failed with code ${exitCode}: ${details}`);
  }

  return { stdout, stderr };
}

// Runs a one-shot Amp query and returns assistant text.
export async function runSingleQuery(prompt, options = {}) {
  const { cwd, projectPath, model, permissionMode = 'default' } = options;
  const args = buildAmpArgs({ model, permissionMode });
  args.push('--archive');

  const { stdout } = await runAmpExec(args, prompt, cwd || projectPath);

  let resultText = '';
  let fallbackText = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.type === 'result' && typeof msg.result === 'string') {
      resultText = msg.result;
      continue;
    }
    if (msg.type === 'assistant') {
      for (const part of extractContentParts(msg)) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          fallbackText = part.text;
        }
      }
    }
  }

  return (resultText || fallbackText || '').trim();
}

export class AmpProvider extends AbsProvider {
  #sessions = new Map();

  async startSession(command, options = {}) {
    return await new Promise((resolve, reject) => {
      let settled = false;

      const onSessionStarted = (providerSessionId) => {
        if (settled) return;
        settled = true;
        resolve(providerSessionId);
      };

      this.runTurn(command, { ...options, onSessionStarted }).then(() => {
        if (settled) return;
        settled = true;
        reject(new Error('amp: session did not return a session ID'));
      }).catch((error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  async runTurn(command, options = {}) {
    const {
      sessionId,
      chatId,
      onSessionStarted,
      cwd,
      projectPath,
      model,
      permissionMode = 'default',
    } = options;

    if (!chatId) throw new Error('chatId is required');

    const args = buildAmpArgs({ sessionId, model, permissionMode });
    const ampBinary = getAmpBinary();
    const workingDirectory = cwd || projectPath || process.cwd();
    const startedAt = new Date().toISOString();
    let providerSessionId = sessionId || null;
    let resultSeen = false;
    let resultExitCode = 0;
    let sessionStartedEmitted = false;

    const ensureSession = (id, proc) => {
      const existing = this.#sessions.get(id);
      const next = {
        status: 'running',
        chatId,
        startedAt: existing?.startedAt || startedAt,
        process: proc,
      };
      this.#sessions.set(id, next);
    };

    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: workingDirectory,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (providerSessionId) {
      ensureSession(providerSessionId, proc);
    }

    this.emitProcessing(chatId, true);

    const stdoutTask = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.type === 'system' && msg.subtype === 'init') {
            const sid = typeof msg.session_id === 'string' ? msg.session_id : null;
            if (sid && sid !== providerSessionId) {
              if (providerSessionId && this.#sessions.has(providerSessionId)) {
                const existing = this.#sessions.get(providerSessionId);
                this.#sessions.delete(providerSessionId);
                this.#sessions.set(sid, { ...existing, chatId, status: 'running', process: proc });
              } else {
                ensureSession(sid, proc);
              }
              providerSessionId = sid;
            } else if (providerSessionId) {
              ensureSession(providerSessionId, proc);
            }

            if (!sessionStartedEmitted && providerSessionId) {
              sessionStartedEmitted = true;
              this.emitSessionCreated(chatId);
              if (typeof onSessionStarted === 'function') {
                onSessionStarted(providerSessionId);
              }
            }
            continue;
          }

          const chatMessages = convertAmpEventToChatMessages(msg);
          if (chatMessages.length > 0) {
            this.emitMessages(chatId, chatMessages);
          }

          if (msg.type === 'result') {
            resultSeen = true;
            resultExitCode = msg.is_error ? 1 : 0;
            this.emitFinished(chatId, resultExitCode);
          }
        }
      }
    })();

    const stderrTask = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) {
            console.log(`amp(${String(providerSessionId || 'pending').slice(0, 8)}): stderr: ${line}`);
          }
        }
      }
    })();

    if (proc.stdin) {
      proc.stdin.write(command || '');
      proc.stdin.write('\n');
      proc.stdin.end();
    }

    try {
      await Promise.all([stdoutTask, stderrTask, proc.exited]);
      if (!resultSeen) {
        const status = providerSessionId ? this.#sessions.get(providerSessionId)?.status : null;
        if (status !== 'aborted') {
          this.emitFailed(chatId, 'Amp process exited before a result event was emitted');
        }
      }
      return providerSessionId;
    } catch (error) {
      this.emitFailed(chatId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (providerSessionId) {
        const session = this.#sessions.get(providerSessionId);
        if (session) {
          session.status = session.status === 'aborted' ? 'aborted' : 'completed';
          session.process = null;
          if (session.status !== 'aborted' && resultSeen) {
            session.exitCode = resultExitCode;
          }
        }
      }
      this.emitProcessing(chatId, false);
    }
  }

  abort(providerSessionId) {
    const session = this.#sessions.get(providerSessionId);
    if (!session) return false;

    session.status = 'aborted';
    try {
      session.process?.kill();
    } catch (err) {
      console.warn(`amp: failed to abort session ${providerSessionId}:`, err);
    }
    return true;
  }

  isRunning(providerSessionId) {
    const session = this.#sessions.get(providerSessionId);
    return session?.status === 'running';
  }

  getRunningSessions() {
    return Array.from(this.#sessions.entries())
      .filter(([, session]) => session.status === 'running')
      .map(([id, session]) => ({ id, status: session.status, startedAt: session.startedAt }));
  }

  startPurgeTimer() {
    return setInterval(() => {
      const now = Date.now();
      const maxAge = 30 * 60 * 1000;

      for (const [id, session] of this.#sessions.entries()) {
        if (session.status !== 'running') {
          const startedAt = new Date(session.startedAt).getTime();
          if (now - startedAt > maxAge) {
            this.#sessions.delete(id);
          }
        }
      }
    }, 5 * 60 * 1000);
  }
}


// Amp CLI transport. Uses a spawn-per-turn model: each user message
// spawns a fresh `amp` process (new chat or `amp threads continue`).
// Parses JSONL stdout and routes messages through AbsProvider events.

import crypto from 'crypto';
import { normalizeToolResultContent } from './normalize-util.js';
import { getAmpBinary } from '../config.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage } from '../../common/chat-types.js';
import { convertClaudeToolUse } from './converters/claude-tool-use.js';
import { AbsProvider } from './base.js';
import { createArtificialNativePath } from '../chats/artificial-native-path.js';

const AMP_DEFAULT_FLAGS = [
  '--no-ide',
  '--no-color',
  '--no-jetbrains',
  '--no-notifications',
];

function createStartedSessionTracker() {
  let resolveRef = null;
  let rejectRef = null;
  const promise = new Promise((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });
  return {
    resolved: false,
    promise,
    resolve: (session) => {
      if (resolveRef) resolveRef(session);
    },
    reject: (error) => {
      if (rejectRef) rejectRef(error);
    },
  };
}

// Converts an Amp CLI assistant message to ChatMessage objects.
function convertAmpMessageToChatMessages(msg) {
  if (msg.type !== 'assistant') return [];

  const chatMessages = [];
  const now = new Date().toISOString();
  const content =
    Array.isArray(msg.content) ? msg.content
      : Array.isArray(msg.message?.content) ? msg.message.content
        : [];

  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (part.type === 'tool_use') {
      chatMessages.push(convertClaudeToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      chatMessages.push(new ToolResultMessage(now, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
    }
  }

  return chatMessages;
}

async function readAmpStdout(proc) {
  const chunks = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

async function runAmpCommand(args, { cwd, input } = {}) {
  const ampBinary = getAmpBinary();
  const proc = Bun.spawn([ampBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (input != null) {
    proc.stdin.write(input);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    readAmpStdout(proc),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Amp command failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }

  return stdout;
}

async function exportThread(threadId, { cwd } = {}) {
  if (!threadId) throw new Error('threadId is required');

  const raw = await runAmpCommand([
    'threads',
    'export',
    threadId,
    ...AMP_DEFAULT_FLAGS,
  ], { cwd });

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse Amp thread export JSON: ${error.message}`);
  }
}

// Runs a one-shot Amp CLI query and returns the plain text output.
async function runSingleQuery(prompt, { cwd } = {}) {
  const args = [
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json',
    '-x',
  ];
  let raw = '';

  try {
    raw = await runAmpCommand(args, { cwd, input: prompt });
  } catch (err) {
    console.error('amp: one-shot stdout read error:', err.message);
    throw err;
  }

  // Parse JSONL and concatenate assistant text parts.
  const textParts = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'assistant') {
        const content =
          Array.isArray(msg.content) ? msg.content
            : Array.isArray(msg.message?.content) ? msg.message.content
              : [];
        for (const part of content) {
          if (part.type === 'text' && part.text?.trim()) {
            textParts.push(part.text);
          }
        }
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return textParts.join('\n');
}

class AmpProvider extends AbsProvider {
  #runningSessions = new Map();

  constructor() {
    super();
  }

  #resolveStartedSession(session) {
    if (session.startedSession?.resolved || !session.threadId) return;
    session.startedSession.resolved = true;
    session.startedSession.resolve({
      providerSessionId: session.threadId,
      nativePath: createArtificialNativePath('amp', session.threadId),
    });
  }

  #rekeySession(session, nextId) {
    if (!nextId || session.id === nextId) return;
    this.#runningSessions.delete(session.id);
    session.id = nextId;
    this.#runningSessions.set(nextId, session);
  }

  #routeMessage(session, msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          const threadId = msg.thread_id || msg.session_id;
          console.log(`amp(${session.id.slice(0, 8)}): init, thread_id=${threadId}`);
          if (threadId) {
            session.threadId = threadId;
            this.#rekeySession(session, threadId);
            this.#resolveStartedSession(session);
          }
        }
        break;

      case 'assistant': {
        const chatMessages = convertAmpMessageToChatMessages(msg);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages);
        }
        break;
      }

      case 'result':
        session.resultSeen = true;
        this.emitFinished(session.chatId, msg.is_error ? 1 : 0);
        this.#finalizeTurn(session);
        break;

      default:
        console.info(`amp(${session.id.slice(0, 8)}): unrecognized message type: ${msg.type}`);
        break;
    }
  }

  async #readStdout(session, proc) {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            console.warn(`amp(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
            continue;
          }
          this.#routeMessage(session, msg);
        }
      }
    } catch (err) {
      if (!proc.killed) {
        console.error(`amp(${session.id.slice(0, 8)}): stdout read error:`, err.message);
      }
    } finally {
      this.#finalizeTurn(session);
    }
  }

  // Idempotent turn finalizer. Safe to call from both the result message
  // handler and the stdout-closed / process-exit paths.
  #finalizeTurn(session, exitCode) {
    if (session.finalized) return;
    session.finalized = true;

    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (session.startedSession && !session.startedSession.resolved) {
      if (session.threadId) {
        this.#resolveStartedSession(session);
      } else {
        session.startedSession.resolved = true;
        session.startedSession.reject(new Error(`Amp session exited before thread ID was initialized${exitCode != null ? ` (code ${exitCode})` : ''}`));
      }
    }

    if (!session.resultSeen && !session.aborted) {
      this.emitFailed(session.chatId, `Amp process exited before result${exitCode != null ? ` (code ${exitCode})` : ''}`);
    }

    const resolve = session.turnResolve;
    session.turnResolve = null;
    resolve?.();
  }

  async #pipeStderr(sessionId, proc) {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) {
            console.log(`amp(${sessionId.slice(0, 8)}): stderr: ${line}`);
          }
        }
      }
    } catch { /* stream closed */ }
  }

  #spawnAmp(session, { cwd }, args, prompt) {
    const ampBinary = getAmpBinary();

    console.log(`amp: spawning: ${ampBinary} ${args.join(' ')}`);

    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (prompt) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    session.process = proc;
    this.#readStdout(session, proc);
    this.#pipeStderr(session.id, proc);

    proc.exited.then(exitCode => {
      console.log(`amp(${session.id.slice(0, 8)}): process exited (code=${exitCode})`);
      if (session.process === proc) {
        session.process = null;
      }
    });

    return proc;
  }

  #waitForTurnComplete(session) {
    if (!session.isRunning) return Promise.resolve();

    return new Promise(resolve => {
      session.turnResolve = resolve;
    });
  }

  async startSession(command, { chatId, cwd, model, ...opts }) {
    if (!chatId) throw new Error('chatId is required when starting an Amp session');

    const provisionalSessionId = crypto.randomUUID();
    const startedSession = createStartedSessionTracker();

    const session = {
      id: provisionalSessionId,
      chatId,
      threadId: null,
      isRunning: true,
      resultSeen: false,
      finalized: false,
      aborted: false,
      turnResolve: null,
      startTime: Date.now(),
      process: null,
      startedSession,
    };
    this.#runningSessions.set(provisionalSessionId, session);
    this.emitProcessing(chatId, true);
    this.emitSessionCreated(chatId);

    const args = [
      ...AMP_DEFAULT_FLAGS,
      '--dangerously-allow-all',
      '--stream-json',
      '-x',
    ];

    try {
      this.#spawnAmp(session, { cwd }, args, command);
    } catch (err) {
      this.#runningSessions.delete(provisionalSessionId);
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, `Amp spawn failed: ${err.message}`);
      throw err;
    }

    return startedSession.promise;
  }

  async runTurn(command, { sessionId: threadId, chatId, cwd, ...opts }) {
    if (!threadId) throw new Error('Cannot resume without thread ID');
    if (!chatId) throw new Error('Cannot resume without chat ID');

    let session = this.#runningSessions.get(threadId);
    if (!session) {
      session = {
        id: threadId,
        chatId,
        threadId,
        isRunning: true,
        resultSeen: false,
        finalized: false,
        aborted: false,
        turnResolve: null,
        startTime: Date.now(),
        process: null,
        startedSession: null,
      };
      this.#runningSessions.set(threadId, session);
    } else {
      if (session.isRunning) {
        throw new Error(`Session ${threadId} is already running`);
      }
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }
      session.isRunning = true;
      session.resultSeen = false;
      session.finalized = false;
      session.aborted = false;
    }

    this.emitProcessing(chatId, true);

    const args = [
      'threads', 'continue', threadId,
      ...AMP_DEFAULT_FLAGS,
      '--dangerously-allow-all',
      '--stream-json',
      '-x',
    ];

    try {
      this.#spawnAmp(session, { cwd }, args, command);
    } catch (err) {
      session.isRunning = false;
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, `Amp spawn failed: ${err.message}`);
      throw err;
    }

    await this.#waitForTurnComplete(session);
  }

  async exportThread(threadId, { cwd } = {}) {
    return exportThread(threadId, { cwd });
  }

  abort(providerSessionId) {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session?.process) return false;

    session.aborted = true;
    session.process.kill();
    return true;
  }

  isRunning(providerSessionId) {
    const session = this.#runningSessions.get(providerSessionId);
    return session?.isRunning === true;
  }

  getRunningSessions() {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
      }));
  }

  startPurgeTimer() {
    const maxAge = 30 * 60 * 1000;

    return setInterval(() => {
      const now = Date.now();

      for (const [id, session] of this.#runningSessions.entries()) {
        if (!session.isRunning) {
          if (now - session.startTime > maxAge) {
            this.#runningSessions.delete(id);
          }
        }
      }
    }, 5 * 60 * 1000);
  }
}

export { AMP_DEFAULT_FLAGS, AmpProvider, convertAmpMessageToChatMessages, exportThread, runSingleQuery };

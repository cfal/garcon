// Amp CLI transport. Uses a spawn-per-turn model: each user message
// spawns a fresh `amp` process (new chat or `amp threads continue`).
// Parses JSONL stdout and routes messages through AbsProvider events.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent } from './normalize-util.js';
import { getAmpBinary } from '../config.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, type ChatMessage } from '../../common/chat-types.js';
import { convertAmpToolUse } from './converters/amp-tool-use.js';
import { AbsProvider } from './base.js';
import { createArtificialNativePath } from '../chats/artificial-native-path.js';
import type { AmpThreadExport } from './loaders/amp-history-loader.js';
import type { StartSessionRequest, ResumeTurnRequest, StartedProviderSession } from './types.js';

interface AmpSession {
  id: string;
  chatId: string;
  threadId: string;
  isRunning: boolean;
  resultSeen: boolean;
  finalized: boolean;
  aborted: boolean;
  turnResolve: ((value?: unknown) => void) | null;
  startTime: number;
  process: ReturnType<typeof Bun.spawn> | null;
  turnGeneration: number;
}

// Represents a JSONL message emitted by the Amp CLI on stdout.
interface AmpCliMessage {
  type: string;
  subtype?: string;
  thread_id?: string;
  session_id?: string;
  is_error?: boolean;
  content?: AmpCliContentPart[];
  message?: { content?: AmpCliContentPart[] };
}

interface AmpCliContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const AMP_DEFAULT_FLAGS = [
  '--no-ide',
  '--no-color',
  '--no-jetbrains',
  '--no-notifications',
];

// Extracts the content array from an Amp CLI assistant message,
// handling both top-level and nested `.message.content` shapes.
function getAssistantContent(msg: AmpCliMessage): AmpCliContentPart[] {
  if (Array.isArray(msg.content)) return msg.content;
  if (Array.isArray(msg.message?.content)) return msg.message!.content!;
  return [];
}

function convertAmpMessageToChatMessages(msg: AmpCliMessage): ChatMessage[] {
  if (msg.type !== 'assistant') return [];

  const chatMessages: ChatMessage[] = [];
  const now = new Date().toISOString();
  const content = getAssistantContent(msg);

  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      chatMessages.push(new AssistantMessage(now, part.text));
    }
    if (part.type === 'thinking' && part.thinking) {
      chatMessages.push(new ThinkingMessage(now, part.thinking));
    }
    if (part.type === 'tool_use') {
      chatMessages.push(convertAmpToolUse(now, part));
    }
    if (part.type === 'tool_result') {
      chatMessages.push(new ToolResultMessage(now, part.tool_use_id || '', normalizeToolResultContent(part.content), Boolean(part.is_error)));
    }
  }

  return chatMessages;
}

async function readAmpStdout(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

async function runAmpCommand(args: string[], { cwd, input }: { cwd?: string; input?: string } = {}): Promise<string> {
  const ampBinary = getAmpBinary();
  const proc = Bun.spawn([ampBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (input != null) {
    const stdin = proc.stdin as unknown as { write(s: string): void; end(): void };
    stdin.write(input);
    stdin.end();
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

async function exportThread(threadId: string, { cwd }: { cwd?: string } = {}): Promise<AmpThreadExport> {
  if (!threadId) throw new Error('threadId is required');

  const raw = await runAmpCommandToTempFile([
    'threads',
    'export',
    ...AMP_DEFAULT_FLAGS,
    threadId,
  ], { cwd });

  try {
    return JSON.parse(raw) as AmpThreadExport;
  } catch (error) {
    throw new Error(`Failed to parse Amp thread export JSON: ${(error as Error).message}`);
  }
}

// Works around a Bun async stdout pipe truncation bug seen with
// `amp threads export`.
// TODO: Retry the normal pipe path after Bun fixes it.
async function runAmpCommandToTempFile(args: string[], { cwd }: { cwd?: string } = {}): Promise<string> {
  const ampBinary = getAmpBinary();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-amp-export-'));
  const outputPath = path.join(tmpDir, 'stdout.json');
  const handle = await fs.open(outputPath, 'w');
  let closed = false;

  try {
    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdin: 'ignore',
      stdout: handle.fd,
      stderr: 'pipe',
    });

    const [stderr, exitCode] = await Promise.all([
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
      proc.exited,
    ]);

    await handle.close();
    closed = true;
    const stdout = await fs.readFile(outputPath, 'utf8');

    if (exitCode !== 0) {
      const details = (stderr || stdout || '').trim();
      throw new Error(`Amp command failed with code ${exitCode}${details ? `: ${details}` : ''}`);
    }

    return stdout;
  } finally {
    if (!closed) {
      await handle.close().catch(() => { });
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function createThread({ cwd }: { cwd?: string } = {}): Promise<string> {
  const raw = await runAmpCommand([
    'threads',
    'new',
    ...AMP_DEFAULT_FLAGS,
  ], { cwd });

  const threadId = parseAmpThreadId(raw);
  if (!threadId) {
    throw new Error(`Failed to parse Amp thread ID from output: ${raw.trim() || '(empty output)'}`);
  }

  return threadId;
}

function parseAmpThreadId(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] || null;
}

async function runSingleQuery(prompt: string, { cwd }: { cwd?: string } = {}): Promise<string> {
  const args = [
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '-x',
  ];
  let raw = '';

  try {
    raw = await runAmpCommand(args, { cwd, input: prompt });
  } catch (err) {
    console.error('amp: one-shot stdout read error:', (err as Error).message);
    throw err;
  }

  const textParts: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as AmpCliMessage;
      if (msg.type === 'assistant') {
        for (const part of getAssistantContent(msg)) {
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

function createSession(threadId: string, chatId: string): AmpSession {
  return {
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
    turnGeneration: 0,
  };
}

function buildContinueArgs(threadId: string): string[] {
  return [
    'threads', 'continue', threadId,
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '-x',
  ];
}

class AmpProvider extends AbsProvider {
  #runningSessions = new Map<string, AmpSession>();

  constructor() {
    super();
  }

  #routeMessage(session: AmpSession, msg: AmpCliMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          const threadId = msg.thread_id || msg.session_id;
          console.log(`amp(${session.id.slice(0, 8)}): init, thread_id=${threadId}`);
          if (threadId) {
            session.threadId = threadId;
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

  async #readStdout(session: AmpSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stdout) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const generation = session.turnGeneration;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: AmpCliMessage;
          try {
            msg = JSON.parse(line) as AmpCliMessage;
          } catch {
            console.warn(`amp(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
            continue;
          }
          this.#routeMessage(session, msg);
        }
      }
    } catch (err) {
      if (!proc.killed) {
        console.error(`amp(${session.id.slice(0, 8)}): stdout read error:`, (err as Error).message);
      }
    } finally {
      const exitCode = await proc.exited;
      if (session.turnGeneration === generation) {
        this.#finalizeTurn(session, exitCode);
      }
    }
  }

  // Idempotent turn finalizer. Safe to call from both the result message
  // handler and the stdout-closed / process-exit paths.
  #finalizeTurn(session: AmpSession, exitCode?: number): void {
    if (session.finalized) return;
    session.finalized = true;

    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (!session.resultSeen && !session.aborted) {
      this.emitFailed(session.chatId, `Amp process exited before result${exitCode != null ? ` (code ${exitCode})` : ''}`);
    }

    const resolve = session.turnResolve;
    session.turnResolve = null;
    resolve?.();
  }

  async #pipeStderr(sessionId: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr) return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
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

  #spawnAmp(session: AmpSession, cwd: string, args: string[], prompt?: string): ReturnType<typeof Bun.spawn> {
    const ampBinary = getAmpBinary();

    console.log(`amp: spawning: ${ampBinary} ${args.join(' ')}`);

    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (prompt) {
      (proc as { stdin: { write(s: string): void; end(): void } }).stdin.write(prompt);
      (proc as { stdin: { write(s: string): void; end(): void } }).stdin.end();
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

  #waitForTurnComplete(session: AmpSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();

    return new Promise(resolve => {
      session.turnResolve = resolve;
    });
  }

  async startSession({ command, chatId, projectPath }: StartSessionRequest): Promise<StartedProviderSession> {
    if (!chatId) throw new Error('chatId is required when starting an Amp session');
    const threadId = await createThread({ cwd: projectPath });

    const session = createSession(threadId, chatId);
    this.#runningSessions.set(threadId, session);
    this.emitProcessing(chatId, true);
    this.emitSessionCreated(chatId);

    const args = buildContinueArgs(threadId);

    try {
      this.#spawnAmp(session, projectPath, args, command);
    } catch (err) {
      this.#runningSessions.delete(threadId);
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, `Amp spawn failed: ${(err as Error).message}`);
      throw err;
    }

    return {
      providerSessionId: threadId,
      nativePath: createArtificialNativePath('amp', threadId),
    };
  }

  async runTurn({ command, providerSessionId: threadId, chatId, projectPath }: ResumeTurnRequest): Promise<void> {
    if (!threadId) throw new Error('Cannot resume without thread ID');
    if (!chatId) throw new Error('Cannot resume without chat ID');

    let session = this.#runningSessions.get(threadId);
    if (!session) {
      session = createSession(threadId, chatId);
      this.#runningSessions.set(threadId, session);
    } else {
      if (session.isRunning) {
        throw new Error(`Session ${threadId} is already running`);
      }
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }
      session.turnGeneration++;
      session.isRunning = true;
      session.resultSeen = false;
      session.finalized = false;
      session.aborted = false;
    }

    this.emitProcessing(chatId, true);

    const args = buildContinueArgs(threadId);

    try {
      this.#spawnAmp(session, projectPath, args, command);
    } catch (err) {
      session.isRunning = false;
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, `Amp spawn failed: ${(err as Error).message}`);
      throw err;
    }

    await this.#waitForTurnComplete(session);
  }

  async exportThread(threadId: string, { cwd }: { cwd?: string } = {}): Promise<AmpThreadExport> {
    return exportThread(threadId, { cwd });
  }

  abort(providerSessionId: string): boolean {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session?.process) return false;

    session.aborted = true;
    session.process.kill();
    this.#finalizeTurn(session);
    return true;
  }

  isRunning(providerSessionId: string): boolean {
    const session = this.#runningSessions.get(providerSessionId);
    return session?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
      }));
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
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

export { AMP_DEFAULT_FLAGS, AmpProvider, convertAmpMessageToChatMessages, createThread, exportThread, runSingleQuery };

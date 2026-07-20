// Amp CLI transport. Uses a spawn-per-turn model: each user message
// spawns a fresh `amp` process (new chat or `amp threads continue`).
// Parses JSONL stdout and routes messages through AgentEventEmitterRuntime events.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent }  from '@garcon/server-agent-common/shared/normalize-util';
import type { AmpConfig } from '../../config.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, type ChatMessage } from '@garcon/common/chat-types';
import { convertAmpToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type { AmpThreadExport } from "./history-loader.js";
import {
  ampEventMetadata,
  assertAmpExecutionOpen,
  markAmpExecutionStarted,
  type AmpResumeRequest,
  type AmpStartRequest,
  type AmpStartedSession,
} from './runtime-types.js';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';

const DEFAULT_CONFIG: AmpConfig = { binary: () => 'amp' };
const SILENT_LOGGER: AgentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

interface AmpSession {
  id: string;
  chatId: string;
  threadId: string;
  isRunning: boolean;
  resultSeen: boolean;
  finalized: boolean;
  aborted: boolean;
  turnResolve: (() => void) | null;
  startTime: number;
  lastActivityAt: number;
  process: ReturnType<typeof Bun.spawn> | null;
  turnGeneration: number;
  eventMetadata: RuntimeEventMetadata;
}

interface AmpTurnContext {
  eventMetadata: RuntimeEventMetadata;
  generation: number;
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

async function runAmpCommand(
  args: string[],
  { cwd, input }: { cwd?: string; input?: string } = {},
  config: AmpConfig = DEFAULT_CONFIG,
): Promise<string> {
  const ampBinary = config.binary();
  const proc = Bun.spawn([ampBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (input != null) {
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === 'number') throw new Error('Amp process stdin is unavailable');
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

async function exportThread(
  threadId: string,
  { cwd, signal, tempDirectory }: {
    cwd?: string;
    signal?: AbortSignal;
    tempDirectory?: string;
  } = {},
  config: AmpConfig = DEFAULT_CONFIG,
): Promise<AmpThreadExport> {
  if (!threadId) throw new Error('threadId is required');

  const raw = await runAmpCommandToTempFile([
    'threads',
    'export',
    ...AMP_DEFAULT_FLAGS,
    threadId,
  ], { cwd, signal, tempDirectory }, config);

  try {
    return JSON.parse(raw) as AmpThreadExport;
  } catch (error) {
    throw new Error(`Failed to parse Amp thread export JSON: ${(error as Error).message}`);
  }
}

// Works around a Bun async stdout pipe truncation bug seen with
// `amp threads export`.
// TODO: Retry the normal pipe path after Bun fixes it.
async function runAmpCommandToTempFile(
  args: string[],
  { cwd, signal, tempDirectory }: {
    cwd?: string;
    signal?: AbortSignal;
    tempDirectory?: string;
  } = {},
  config: AmpConfig = DEFAULT_CONFIG,
): Promise<string> {
  const ampBinary = config.binary();
  signal?.throwIfAborted();
  const tempRoot = tempDirectory ?? os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tmpDir = await fs.mkdtemp(path.join(tempRoot, 'garcon-amp-export-'));
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
    const abort = () => proc.kill();
    signal?.addEventListener('abort', abort, { once: true });

    let stderr: string;
    let exitCode: number;
    try {
      [stderr, exitCode] = await Promise.all([
        proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
        proc.exited,
      ]);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    signal?.throwIfAborted();

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

async function createThread(
  { cwd }: { cwd?: string } = {},
  config: AmpConfig = DEFAULT_CONFIG,
): Promise<string> {
  const raw = await runAmpCommand([
    'threads',
    'new',
    ...AMP_DEFAULT_FLAGS,
  ], { cwd }, config);

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

async function runSingleQuery(
  prompt: string,
  options: Record<string, unknown> = {},
  config: AmpConfig = DEFAULT_CONFIG,
  logger: AgentLogger = SILENT_LOGGER,
): Promise<string> {
  const thinkingMode = normalizeThinkingMode(options.thinkingMode);
  if (thinkingMode !== 'none') {
    throw new AgentIntegrationError(
      'OPERATION_UNSUPPORTED',
      `amp does not support explicit one-shot effort ${thinkingMode}.`,
      false,
      AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
    );
  }
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  const args = [
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '-x',
  ];
  let raw = '';

  try {
    raw = await runAmpCommand(args, { cwd, input: prompt }, config);
  } catch (err) {
    logger.error('Amp one-shot stdout read failed.', {
      error: err instanceof Error ? err.message : String(err),
    });
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

function createSession(
  threadId: string,
  chatId: string,
  eventMetadata: RuntimeEventMetadata,
): AmpSession {
  const now = Date.now();
  return {
    id: threadId,
    chatId,
    threadId,
    isRunning: true,
    resultSeen: false,
    finalized: false,
    aborted: false,
    turnResolve: null,
    startTime: now,
    lastActivityAt: now,
    process: null,
    turnGeneration: 0,
    eventMetadata,
  };
}

function buildContinueArgs(threadId: string, model?: string): string[] {
  const args = [
    'threads', 'continue', threadId,
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
  ];
  // The Amp model value doubles as the agent mode (smart/deep).
  const agentMode = model === 'deep' ? 'deep' : 'smart';
  args.push('-m', agentMode);
  args.push('-x');
  return args;
}

class AmpCliRuntime extends AgentEventEmitterRuntime {
  readonly #config: AmpConfig;
  readonly #logger: AgentLogger;
  #runningSessions = new Map<string, AmpSession>();
  #idlePurger = new IdleSessionPurger<AmpSession>({
    sessions: () => this.#runningSessions.entries(),
    isRunning: (session) => session.isRunning,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (id, session) => {
      if (session.process && !session.process.killed) session.process.kill();
      this.#runningSessions.delete(id);
    },
  });

  constructor(options: { config?: AmpConfig; logger?: AgentLogger } = {}) {
    super();
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#logger = options.logger ?? SILENT_LOGGER;
  }

  #routeMessage(session: AmpSession, turn: AmpTurnContext, msg: AmpCliMessage): void {
    if (session.turnGeneration !== turn.generation || session.finalized) return;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          const threadId = msg.thread_id || msg.session_id;
          this.#logger.info('Amp session initialized.', { sessionId: session.id, threadId: threadId ?? null });
          if (threadId) {
            session.threadId = threadId;
          }
        }
        break;

      case 'assistant': {
        const chatMessages = convertAmpMessageToChatMessages(msg);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages, turn.eventMetadata);
        }
        break;
      }

      case 'result':
        session.resultSeen = true;
        if (session.isRunning) {
          session.isRunning = false;
          this.emitProcessing(session.chatId, false);
        }
        this.emitFinished(session.chatId, msg.is_error ? 1 : 0, turn.eventMetadata);
        this.#finalizeTurn(session, turn);
        break;

      case 'user':
        // skip user messages
        break;

      default:
        this.#logger.info('Amp emitted an unrecognized message type.', { sessionId: session.id, type: msg.type });
        break;
    }
  }

  async #readStdout(
    session: AmpSession,
    proc: ReturnType<typeof Bun.spawn>,
    turn: AmpTurnContext,
  ): Promise<void> {
    if (!proc.stdout) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
            this.#logger.warn('Amp emitted invalid JSON.', { sessionId: session.id, line: line.slice(0, 120) });
            continue;
          }
          this.#routeMessage(session, turn, msg);
        }
      }
    } catch (err) {
      if (!proc.killed) {
        this.#logger.error('Amp stdout read failed.', { sessionId: session.id, error: (err as Error).message });
      }
    } finally {
      const exitCode = await proc.exited;
      this.#finalizeTurn(session, turn, exitCode);
    }
  }

  // Idempotent turn finalizer. Safe to call from both the result message
  // handler and the stdout-closed / process-exit paths.
  #finalizeTurn(session: AmpSession, turn: AmpTurnContext, exitCode?: number): void {
    if (session.turnGeneration !== turn.generation) return;
    if (session.finalized) return;
    session.finalized = true;
    session.lastActivityAt = Date.now();

    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (!session.resultSeen && !session.aborted) {
      this.emitFailed(
        session.chatId,
        `Amp process exited before result${exitCode != null ? ` (code ${exitCode})` : ''}`,
        turn.eventMetadata,
      );
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
            this.#logger.info('Amp stderr output.', { sessionId, line });
          }
        }
      }
    } catch { /* stream closed */ }
  }

  #spawnAmp(session: AmpSession, cwd: string, args: string[], prompt?: string): ReturnType<typeof Bun.spawn> {
    const ampBinary = this.#config.binary();

    this.#logger.info('Spawning Amp.', { binary: ampBinary, arguments: args });

    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const turn = Object.freeze({
      eventMetadata: session.eventMetadata,
      generation: session.turnGeneration,
    });
    session.process = proc;

    if (prompt) {
      (proc as { stdin: { write(s: string): void; end(): void } }).stdin.write(prompt);
      (proc as { stdin: { write(s: string): void; end(): void } }).stdin.end();
    }

    this.#readStdout(session, proc, turn);
    this.#pipeStderr(session.id, proc);

    proc.exited.then(exitCode => {
      this.#logger.info('Amp process exited.', { sessionId: session.id, exitCode });
      if (session.process === proc) {
        session.process = null;
      }
    });

    return proc;
  }

  #rollbackTurnLaunch(session: AmpSession, removeSession: boolean): void {
    const wasRunning = session.isRunning;
    session.aborted = true;
    session.finalized = true;
    session.isRunning = false;
    session.lastActivityAt = Date.now();
    const proc = session.process;
    session.process = null;
    if (proc && !proc.killed) proc.kill();
    session.turnResolve = null;
    if (removeSession && this.#runningSessions.get(session.id) === session) {
      this.#runningSessions.delete(session.id);
    }
    if (wasRunning) this.emitProcessing(session.chatId, false);
  }

  #waitForTurnComplete(session: AmpSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();

    return new Promise(resolve => {
      session.turnResolve = resolve;
    });
  }

  async startSession(request: AmpStartRequest): Promise<AmpStartedSession> {
    assertAmpExecutionOpen(request);
    const { command, chatId, projectPath, model, onAbortable, clientRequestId, turnId } = request;
    if (!chatId) throw new Error('chatId is required when starting an Amp session');
    const threadId = await createThread({ cwd: projectPath }, this.#config);
    assertAmpExecutionOpen(request);

    const session = createSession(
      threadId,
      chatId,
      ampEventMetadata({ clientRequestId, turnId }, 'chat-start'),
    );
    this.#runningSessions.set(threadId, session);
    this.emitSessionCreated(chatId);

    const args = buildContinueArgs(threadId, model);

    try {
      markAmpExecutionStarted(request);
      this.emitProcessing(chatId, true);
      this.#spawnAmp(session, projectPath, args, command);
      onAbortable?.();
    } catch (err) {
      this.#rollbackTurnLaunch(session, true);
      if (!request.executionAdmission?.signal.aborted) {
        this.emitFailed(chatId, `Amp spawn failed: ${(err as Error).message}`, session.eventMetadata);
      }
      throw err;
    }

    return {
      agentSessionId: threadId,
      nativePath: createArtificialNativePath('amp', threadId),
    };
  }

  async runTurn(request: AmpResumeRequest): Promise<void> {
    assertAmpExecutionOpen(request);
    const { command, agentSessionId: threadId, chatId, projectPath, model, onAbortable, clientRequestId, turnId } = request;
    if (!threadId) throw new Error('Cannot resume without thread ID');
    if (!chatId) throw new Error('Cannot resume without chat ID');

    let session = this.#runningSessions.get(threadId);
    if (!session) {
      session = createSession(
        threadId,
        chatId,
        ampEventMetadata({ clientRequestId, turnId }),
      );
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
      session.lastActivityAt = Date.now();
      session.resultSeen = false;
      session.finalized = false;
      session.aborted = false;
      session.eventMetadata = ampEventMetadata({ clientRequestId, turnId });
    }

    const args = buildContinueArgs(threadId, model);

    try {
      markAmpExecutionStarted(request);
      this.emitProcessing(chatId, true);
      this.#spawnAmp(session, projectPath, args, command);
      onAbortable?.();
    } catch (err) {
      this.#rollbackTurnLaunch(session, false);
      if (!request.executionAdmission?.signal.aborted) {
        this.emitFailed(chatId, `Amp spawn failed: ${(err as Error).message}`, session.eventMetadata);
      }
      throw err;
    }

    await this.#waitForTurnComplete(session);
  }

  async exportThread(threadId: string, options: {
    cwd?: string;
    signal?: AbortSignal;
    tempDirectory?: string;
  } = {}): Promise<AmpThreadExport> {
    return exportThread(threadId, options, this.#config);
  }

  abort(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session?.process) return false;

    session.aborted = true;
    session.process.kill();
    this.#finalizeTurn(session, {
      eventMetadata: session.eventMetadata,
      generation: session.turnGeneration,
    });
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
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

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of this.#runningSessions.values()) {
      session.aborted = true;
      if (session.process && !session.process.killed) {
        session.process.kill();
      }
      this.#finalizeTurn(session, {
        eventMetadata: session.eventMetadata,
        generation: session.turnGeneration,
      }, 143);
    }
    this.#runningSessions.clear();
  }
}

export { AMP_DEFAULT_FLAGS, AmpCliRuntime, convertAmpMessageToChatMessages, createThread, exportThread, runSingleQuery };

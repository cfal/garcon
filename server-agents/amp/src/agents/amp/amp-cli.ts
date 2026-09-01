// Amp CLI transport. Each turn keeps stream-JSON stdin open until the agent
// settles so Garcon and Amp web steering share the same live operation.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import { normalizeToolResultContent }  from '@garcon/server-agent-common/shared/normalize-util';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import type { AmpConfig } from '../../config.js';
import {
  AssistantMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertAmpToolUse } from "./tool-use-converter.js";
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type { AmpThreadExport } from "./history-loader.js";
import {
  assertAmpExecutionOpen,
  markAmpExecutionStarted,
  type AmpResumeRequest,
  type AmpStartRequest,
  type AmpStartedSession,
} from './runtime-types.js';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import { buildAmpUserInput } from './amp-stream-input.js';
import {
  type AgentLogger,
  type AgentSteerRequest,
  type AgentSteerResult,
  type AgentSteerTarget,
} from '@garcon/server-agent-interface';

const DEFAULT_CONFIG: AmpConfig = { binary: () => 'amp' };
const SILENT_LOGGER: AgentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

interface AmpSession {
  id: string;
  chatId: string;
  threadId: string;
  activeTurn: AmpTurnContext | null;
  readonly sources: Set<AmpTurnContext>;
  lastActivityAt: number;
}

interface AmpTurnContext {
  readonly operation: AgentRuntimeOperation;
  readonly startedAt: number;
  isRunning: boolean;
  completed: boolean;
  aborted: boolean;
  sourceRetired: boolean;
  stdinClosed: boolean;
  deliveryReservations: number;
  pendingEnd: boolean;
  readonly pendingInputEchoes: AmpPendingInputEcho[];
  resolve: (() => void) | null;
  process: ReturnType<typeof Bun.spawn> | null;
}

interface AmpPendingInputEcho {
  readonly text: string;
  readonly settle?: (result: AgentSteerResult) => void;
}

// Represents a JSONL message emitted by the Amp CLI on stdout.
interface AmpCliMessage {
  type: string;
  subtype?: string;
  thread_id?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string;
  content?: AmpCliContentPart[];
  message?: {
    content?: AmpCliContentPart[];
    stop_reason?: string | null;
  };
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

function getUserText(msg: AmpCliMessage): string {
  return getAssistantContent(msg)
    .filter((part): part is AmpCliContentPart & { text: string } => (
      part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
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
  { cwd, input, signal }: { cwd?: string; input?: string; signal?: AbortSignal } = {},
  config: AmpConfig = DEFAULT_CONFIG,
): Promise<string> {
  const ampBinary = config.binary();
  const proc = Bun.spawn([ampBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
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
  signal?.throwIfAborted();

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
  const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
  const model = typeof options.model === 'string' && options.model ? options.model : 'medium';
  const args = [
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '--mode',
    model,
    ...(thinkingMode === 'none' ? [] : ['--effort', thinkingMode]),
    '-x',
  ];
  return withSingleQueryControl(options, async (signal) => {
    let raw = '';

    try {
      raw = await runAmpCommand(args, { cwd, input: prompt, signal }, config);
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
  });
}

function createSession(
  threadId: string,
  chatId: string,
): AmpSession {
  const now = Date.now();
  return {
    id: threadId,
    chatId,
    threadId,
    activeTurn: null,
    sources: new Set(),
    lastActivityAt: now,
  };
}

function createTurn(operation: AgentRuntimeOperation): AmpTurnContext {
  return {
    operation,
    startedAt: Date.now(),
    isRunning: true,
    completed: false,
    aborted: false,
    sourceRetired: false,
    stdinClosed: false,
    deliveryReservations: 0,
    pendingEnd: false,
    pendingInputEchoes: [],
    resolve: null,
    process: null,
  };
}

function buildContinueArgs(
  threadId: string,
  model: string,
  thinkingMode: string,
): string[] {
  const args = [
    'threads', 'continue', threadId,
    ...AMP_DEFAULT_FLAGS,
    '--dangerously-allow-all',
    '--stream-json-thinking',
    '--stream-json-input',
    '--mode', model || 'medium',
  ];
  if (thinkingMode !== 'none') args.push('--effort', thinkingMode);
  args.push('-x');
  return args;
}

class AmpCliRuntime {
  readonly #config: AmpConfig;
  readonly #logger: AgentLogger;
  #runningSessions = new Map<string, AmpSession>();
  #steerTargets = new WeakMap<AgentSteerTarget, {
    readonly session: AmpSession;
    readonly turn: AmpTurnContext;
  }>();
  #idlePurger = new IdleSessionPurger<AmpSession>({
    sessions: () => this.#runningSessions.entries(),
    isRunning: (session) => session.activeTurn?.isRunning === true,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (_id, session) => this.#retireSession(session),
  });

  constructor(options: { config?: AmpConfig; logger?: AgentLogger } = {}) {
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#logger = options.logger ?? SILENT_LOGGER;
  }

  #routeMessage(session: AmpSession, turn: AmpTurnContext, msg: AmpCliMessage): void {
    if (turn.sourceRetired) return;
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
          this.#publishMessages(session, turn, chatMessages);
        }
        if (msg.message?.stop_reason === 'end_turn') {
          this.#requestTurnEnd(session, turn);
        }
        break;
      }

      case 'result': {
        if (msg.is_error && !turn.completed) {
          this.#failTurn(session, turn, msg.error || 'Amp execution failed');
        } else if (!turn.completed) {
          this.#finishTurn(session, turn);
        }
        break;
      }

      case 'user': {
        const content = getAssistantContent(msg);
        const text = getUserText(msg);
        const expected = turn.pendingInputEchoes[0];
        if (text && expected?.text === text) {
          turn.pendingInputEchoes.shift();
          turn.pendingEnd = false;
          expected.settle?.({ kind: 'accepted' });
        } else if (text.trim()) {
          turn.pendingEnd = false;
          this.#publishMessages(session, turn, [new UserMessage(new Date().toISOString(), text)]);
        }
        const toolResults = content.flatMap((part) => part.type === 'tool_result'
          ? [new ToolResultMessage(
              new Date().toISOString(),
              part.tool_use_id || '',
              normalizeToolResultContent(part.content),
              Boolean(part.is_error),
            )]
          : []);
        if (toolResults.length > 0) this.#publishMessages(session, turn, toolResults);
        break;
      }

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
            this.#logger.warn('Amp emitted invalid JSON.', { sessionId: session.id });
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
      if (!turn.completed) {
        if (!turn.aborted) {
          this.#failTurn(session, turn, `Amp process exited before result (code ${exitCode})`);
        } else {
          this.#completeTurn(session, turn);
        }
      }
      this.#settlePendingEchoes(turn, {
        kind: 'failed',
        outcome: 'unknown',
        message: `Amp process exited before acknowledging steering (code ${exitCode})`,
      });
      turn.sourceRetired = true;
      turn.process = null;
      session.sources.delete(turn);
    }
  }

  #completeTurn(session: AmpSession, turn: AmpTurnContext): void {
    if (turn.completed) return;
    turn.completed = true;
    session.lastActivityAt = Date.now();
    turn.isRunning = false;
    if (session.activeTurn === turn) {
      session.activeTurn = null;
    }
    const resolve = turn.resolve;
    turn.resolve = null;
    resolve?.();
  }

  #requestTurnEnd(session: AmpSession, turn: AmpTurnContext): void {
    if (turn.completed) return;
    if (turn.deliveryReservations > 0) {
      turn.pendingEnd = true;
      return;
    }
    this.#finishTurn(session, turn);
  }

  #finishTurn(session: AmpSession, turn: AmpTurnContext): void {
    if (turn.completed) return;
    this.#completeTurn(session, turn);
    this.#publishTurnEvent(session, turn, {
      type: 'run-ended',
      runId: turn.operation.runId,
      outcome: 'finished',
    });
    this.#closeStdin(turn);
  }

  #failTurn(session: AmpSession, turn: AmpTurnContext, message: string): void {
    if (turn.completed) return;
    this.#completeTurn(session, turn);
    this.#publishTurnEvent(session, turn, {
      type: 'run-ended',
      runId: turn.operation.runId,
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message },
    });
    this.#settlePendingEchoes(turn, {
      kind: 'failed',
      outcome: 'unknown',
      message,
    });
    this.#closeStdin(turn);
  }

  #closeStdin(turn: AmpTurnContext): void {
    if (turn.stdinClosed) return;
    turn.stdinClosed = true;
    const stdin = turn.process?.stdin;
    if (stdin && typeof stdin !== 'number') stdin.end();
  }

  #settlePendingEchoes(turn: AmpTurnContext, result: AgentSteerResult): void {
    for (const echo of turn.pendingInputEchoes.splice(0)) echo.settle?.(result);
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
            this.#logger.info('Amp stderr output.', { sessionId });
          }
        }
      }
    } catch { /* stream closed */ }
  }

  #spawnAmp(
    session: AmpSession,
    turn: AmpTurnContext,
    cwd: string,
    args: string[],
    prompt: string,
    attachments: readonly AgentAttachment[] = [],
  ): ReturnType<typeof Bun.spawn> {
    const ampBinary = this.#config.binary();

    this.#logger.info('Spawning Amp.', { binary: ampBinary, arguments: args });

    const proc = Bun.spawn([ampBinary, ...args], {
      cwd: cwd || process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    turn.process = proc;
    session.sources.add(turn);

    turn.pendingInputEchoes.push({ text: prompt });
    this.#writeInput(
      turn,
      buildAmpUserInput(prompt, crypto.randomUUID(), attachments),
    );

    this.#readStdout(session, proc, turn);
    this.#pipeStderr(session.id, proc);

    proc.exited.then(exitCode => {
      this.#logger.info('Amp process exited.', { sessionId: session.id, exitCode });
    });

    return proc;
  }

  #writeInput(turn: AmpTurnContext, input: string): void {
    const stdin = turn.process?.stdin;
    if (!stdin || typeof stdin === 'number' || turn.stdinClosed) {
      throw new Error('Amp process stdin is unavailable');
    }
    stdin.write(input);
  }

  #rollbackTurnLaunch(
    session: AmpSession,
    turn: AmpTurnContext,
    removeSession: boolean,
  ): void {
    turn.aborted = true;
    turn.sourceRetired = true;
    session.lastActivityAt = Date.now();
    const proc = turn.process;
    turn.process = null;
    if (proc && !proc.killed) proc.kill();
    session.sources.delete(turn);
    this.#completeTurn(session, turn);
    if (removeSession && this.#runningSessions.get(session.id) === session) {
      this.#runningSessions.delete(session.id);
    }
  }

  #waitForTurnComplete(turn: AmpTurnContext): Promise<void> {
    if (!turn.isRunning) return Promise.resolve();

    return new Promise(resolve => {
      turn.resolve = resolve;
    });
  }

  #publishMessages(
    session: AmpSession,
    turn: AmpTurnContext,
    messages: ChatMessage[],
  ): void {
    this.#publishTurnEvent(session, turn, {
      type: 'rows',
      rows: runtimeRows(messages),
    });
  }

  #publishTurnEvent(
    session: AmpSession,
    turn: AmpTurnContext,
    event: AgentRuntimeEvent,
  ): void {
    try {
      turn.operation.publish(event);
    } catch (error) {
      this.#logger.warn('Amp publisher rejected an event.', {
        sessionId: session.id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #retireSupersededChatSessions(current: AmpSession): void {
    for (const session of this.#runningSessions.values()) {
      if (session === current || session.chatId !== current.chatId) continue;
      this.#retireSession(session);
    }
  }

  #retireSession(session: AmpSession): void {
    const turns = new Set(session.sources);
    if (session.activeTurn) turns.add(session.activeTurn);
    for (const turn of turns) {
      turn.aborted = true;
      turn.sourceRetired = true;
      this.#settlePendingEchoes(turn, {
        kind: 'failed',
        outcome: 'unknown',
        message: 'Amp session was retired before steering was acknowledged',
      });
      if (turn.process && !turn.process.killed) turn.process.kill();
      turn.process = null;
      if (!turn.completed) this.#completeTurn(session, turn);
    }
    session.sources.clear();
    if (this.#runningSessions.get(session.id) === session) {
      this.#runningSessions.delete(session.id);
    }
  }

  async startSession(request: AmpStartRequest): Promise<AmpStartedSession> {
    assertAmpExecutionOpen(request);
    const { command, chatId, projectPath, model, thinkingMode, operation } = request;
    if (!chatId) throw new Error('chatId is required when starting an Amp session');
    const threadId = await createThread({ cwd: projectPath }, this.#config);
    assertAmpExecutionOpen(request);
    const matchingSession = this.#runningSessions.get(threadId);
    if (matchingSession && matchingSession.chatId !== chatId) {
      throw new Error(`Amp thread ${threadId} is already bound to another chat`);
    }

    const session = createSession(threadId, chatId);
    const turn = createTurn(operation);
    session.activeTurn = turn;
    const started = {
      agentSessionId: threadId,
      nativePath: createArtificialNativePath('amp', threadId),
    };
    request.onSessionActivated?.(started);

    const args = buildContinueArgs(threadId, model, thinkingMode);

    try {
      if (request.executionAdmission) await markAmpExecutionStarted(request);
      this.#spawnAmp(session, turn, projectPath, args, command, request.attachments);
    } catch (err) {
      this.#rollbackTurnLaunch(session, turn, true);
      if (!request.executionAdmission?.signal.aborted) {
        const message = `Amp spawn failed: ${(err as Error).message}`;
        this.#publishTurnEvent(session, turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message },
        });
      }
      throw err;
    }
    this.#retireSupersededChatSessions(session);
    this.#runningSessions.set(threadId, session);

    return started;
  }

  async runTurn(request: AmpResumeRequest): Promise<void> {
    assertAmpExecutionOpen(request);
    const {
      command,
      agentSessionId: threadId,
      chatId,
      projectPath,
      model,
      thinkingMode,
      operation,
    } = request;
    if (!threadId) throw new Error('Cannot resume without thread ID');
    if (!chatId) throw new Error('Cannot resume without chat ID');

    let session = this.#runningSessions.get(threadId);
    if (!session) {
      session = createSession(threadId, chatId);
      this.#runningSessions.set(threadId, session);
    } else {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }
      if (session.activeTurn?.isRunning) {
        throw new Error(`Session ${threadId} is already running`);
      }
    }
    const turn = createTurn(operation);
    session.activeTurn = turn;
    session.lastActivityAt = Date.now();

    const args = buildContinueArgs(threadId, model, thinkingMode);

    try {
      if (request.executionAdmission) await markAmpExecutionStarted(request);
      this.#spawnAmp(session, turn, projectPath, args, command, request.attachments);
    } catch (err) {
      this.#rollbackTurnLaunch(session, turn, false);
      if (!request.executionAdmission?.signal.aborted) {
        const message = `Amp spawn failed: ${(err as Error).message}`;
        this.#publishTurnEvent(session, turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message },
        });
      }
      throw err;
    }

    await this.#waitForTurnComplete(turn);
  }

  async exportThread(threadId: string, options: {
    cwd?: string;
    signal?: AbortSignal;
    tempDirectory?: string;
  } = {}): Promise<AmpThreadExport> {
    return exportThread(threadId, options, this.#config);
  }

  captureSteerTarget(agentSessionId: string): AgentSteerTarget | null {
    const session = this.#runningSessions.get(agentSessionId);
    const turn = session?.activeTurn;
    if (!session || !turn || !this.#isSteerable(session, turn)) return null;
    const target = Object.freeze({});
    this.#steerTargets.set(target, { session, turn });
    return target;
  }

  async steer(request: AgentSteerRequest): Promise<AgentSteerResult> {
    if (!request.input.trim()) {
      return {
        kind: 'rejected',
        reason: 'invalid-input',
        message: 'Amp steering input is empty',
      };
    }
    const captured = request.target ? this.#steerTargets.get(request.target) : undefined;
    if (!captured) {
      return {
        kind: 'rejected',
        reason: 'no-active-turn',
        message: 'No active Amp turn',
      };
    }
    this.#steerTargets.delete(request.target!);
    let rejection = this.#validateSteerTarget(request, captured);
    if (rejection) return rejection;

    const { session, turn } = captured;
    turn.deliveryReservations += 1;
    try {
      await request.prepareDelivery();
      rejection = this.#validateSteerTarget(request, captured);
      if (rejection) return rejection;

      let pendingEcho: AmpPendingInputEcho;
      const acknowledged = new Promise<AgentSteerResult>((settle) => {
        pendingEcho = { text: request.input, settle };
        turn.pendingInputEchoes.push(pendingEcho);
      });
      try {
        this.#writeInput(
          turn,
          buildAmpUserInput(request.input, request.clientMessageId, [], true),
        );
      } catch (error) {
        const pending = turn.pendingInputEchoes.indexOf(pendingEcho!);
        if (pending >= 0) turn.pendingInputEchoes.splice(pending, 1);
        return {
          kind: 'failed',
          outcome: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return await acknowledged;
    } finally {
      turn.deliveryReservations -= 1;
      if (turn.pendingEnd) this.#requestTurnEnd(session, turn);
    }
  }

  #isSteerable(session: AmpSession, turn: AmpTurnContext): boolean {
    return session.activeTurn === turn
      && turn.isRunning
      && !turn.completed
      && !turn.aborted
      && !turn.sourceRetired
      && !turn.stdinClosed
      && Boolean(turn.process)
      && !turn.process!.killed;
  }

  #validateSteerTarget(
    request: AgentSteerRequest,
    captured: { readonly session: AmpSession; readonly turn: AmpTurnContext },
  ): AgentSteerResult | null {
    const current = this.#runningSessions.get(request.agentSessionId);
    if (
      current !== captured.session
      || current.chatId !== request.chatId
      || !this.#isSteerable(captured.session, captured.turn)
    ) {
      return {
        kind: 'rejected',
        reason: current === captured.session ? 'turn-changed' : 'no-active-turn',
        message: current === captured.session ? 'The active Amp turn changed' : 'No active Amp turn',
      };
    }
    return null;
  }

  abort(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    const turn = session?.activeTurn;
    if (!session || !turn?.process) return false;

    turn.aborted = true;
    this.#settlePendingEchoes(turn, {
      kind: 'failed',
      outcome: 'unknown',
      message: 'Amp turn was interrupted before steering was acknowledged',
    });
    turn.process.kill();
    this.#completeTurn(session, turn);
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    return session?.activeTurn?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, session]) => session.activeTurn?.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.activeTurn!.startedAt).toISOString(),
      }));
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of this.#runningSessions.values()) {
      this.#retireSession(session);
    }
    this.#runningSessions.clear();
  }
}

export { AMP_DEFAULT_FLAGS, AmpCliRuntime, convertAmpMessageToChatMessages, createThread, exportThread, runSingleQuery };

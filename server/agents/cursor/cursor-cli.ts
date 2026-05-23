import crypto from 'crypto';
import {
  AssistantMessage,
  ErrorMessage,
  ThinkingMessage,
  ToolResultMessage,
  isToolUseMessage,
  type ChatMessage,
} from "../../../common/chat-types.js";
import { getCursorBinary } from "../../config.js";
import { createArtificialNativePath, getArtificialProviderSessionId } from "../../chats/artificial-native-path.js";
import { AbsProvider } from "../shared/event-emitter-runtime.js";
import { normalizeCursorToolResultContent } from "../converters/cursor-tool-result.js";
import { convertCursorToolUse } from "../converters/cursor-tool-use.js";
import { getCursorModels } from './cursor-models.js';
import { CursorRequestIdentityStore } from './cursor-request-identities.js';
import { loadCursorChatMessagesBySessionId } from "../loaders/cursor-history-loader.js";
import type {
  PermissionMode,
  ProviderChatEntry,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedProviderSession,
} from "../session-types.js";

interface CursorSession {
  aborted: boolean;
  assistantSeen: boolean;
  chatId: string;
  clientRequestId?: string;
  emittedToolIds: Set<string>;
  finalized: boolean;
  id: string;
  isRunning: boolean;
  process: ReturnType<typeof Bun.spawn> | null;
  providerRequestId?: string;
  resultSeen: boolean;
  sessionCreatedEmitted: boolean;
  startTime: number;
  startedSession: {
    promise: Promise<StartedProviderSession>;
    reject: (error: unknown) => void;
    resolve: (value: StartedProviderSession) => void;
    resolved: boolean;
  } | null;
  turnResolve: (() => void) | null;
  turnId?: string;
  userEchoSeen: boolean;
}

type CursorCliEvent = Record<string, unknown> & {
  subtype?: string;
  type?: string;
};

const CURSOR_PROMPT_PLAN_MODE = 'plan';

function createStartTracker(): CursorSession['startedSession'] & { promise: Promise<StartedProviderSession> } {
  let resolveRef: ((value: StartedProviderSession) => void) | null = null;
  let rejectRef: ((error: unknown) => void) | null = null;
  const promise = new Promise<StartedProviderSession>((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });

  return {
    promise,
    reject(error) {
      rejectRef?.(error);
    },
    resolve(value) {
      resolveRef?.(value);
    },
    resolved: false,
  };
}

function createSession(chatId: string, startedSession: CursorSession['startedSession'] = null): CursorSession {
  return {
    aborted: false,
    assistantSeen: false,
    chatId,
    clientRequestId: undefined,
    emittedToolIds: new Set(),
    finalized: false,
    id: `pending-${crypto.randomUUID()}`,
    isRunning: true,
    process: null,
    providerRequestId: undefined,
    resultSeen: false,
    sessionCreatedEmitted: false,
    startTime: Date.now(),
    startedSession,
    turnResolve: null,
    turnId: undefined,
    userEchoSeen: false,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getSessionId(event: Record<string, unknown>): string | undefined {
  return asString(event.session_id ?? event.sessionId ?? event.chat_id ?? event.chatId);
}

function getRequestId(event: Record<string, unknown>): string | undefined {
  return asString(event.request_id ?? event.requestId);
}

function getToolCallId(event: Record<string, unknown>): string {
  const callId = asString(event.call_id ?? event.callId ?? event.toolCallId ?? event.tool_call_id ?? event.id);
  if (callId) return callId;

  const toolCall = asObject(event.tool_call ?? event.toolCall);
  const nested = Object.values(toolCall)
    .map((entry) => asObject(entry))
    .find((entry) => Object.keys(entry).length > 0);
  return asString(nested?.call_id ?? nested?.callId ?? nested?.toolCallId ?? nested?.tool_call_id ?? nested?.id) ?? '';
}

function getToolName(event: Record<string, unknown>): string | undefined {
  const direct = asString(event.toolName ?? event.tool_name ?? event.name ?? event.tool);
  if (direct) return direct;

  const toolCall = asObject(event.tool_call ?? event.toolCall);
  const nested = Object.values(toolCall)
    .map((entry) => asObject(entry))
    .find((entry) => Object.keys(entry).length > 0);
  return asString(nested?.toolName ?? nested?.tool_name ?? nested?.name ?? nested?.tool);
}

function getHighLevelToolCallResult(event: Record<string, unknown>): unknown {
  const direct = event.highLevelToolCallResult ?? event.high_level_tool_call_result;
  if (direct !== undefined) return direct;
  return asObject(asObject(event.providerOptions).cursor).highLevelToolCallResult;
}

function extractToolResultPayload(event: Record<string, unknown>): unknown {
  const direct = event.result ?? event.output ?? event.tool_result ?? event.toolResult;
  if (direct !== undefined) return direct;

  const toolCall = asObject(event.tool_call ?? event.toolCall);
  for (const entry of Object.values(toolCall)) {
    const nested = asObject(entry);
    if ('result' in nested) return nested.result;
    if ('output' in nested) return nested.output;
  }

  return undefined;
}

function isToolResultError(event: Record<string, unknown>, payload: unknown): boolean {
  if (event.is_error === true || event.isError === true || event.error === true) return true;
  if (payload && typeof payload === 'object') {
    const raw = payload as Record<string, unknown>;
    return raw.is_error === true || raw.isError === true || raw.error === true || raw.ok === false;
  }
  return false;
}

function getTextFromPart(part: unknown): { kind: 'text' | 'thinking'; value: string } | null {
  if (typeof part === 'string') return part.trim() ? { kind: 'text', value: part } : null;
  const raw = asObject(part);
  const type = asString(raw.type);
  const text = asString(raw.text ?? raw.content ?? raw.delta);
  if (!text) return null;
  if (type === 'reasoning' || type === 'thinking') return { kind: 'thinking', value: text };
  return { kind: 'text', value: text };
}

function assistantMessagesFromEvent(event: Record<string, unknown>): ChatMessage[] {
  const timestamp = new Date().toISOString();
  const messages: ChatMessage[] = [];
  const message = asObject(event.message);
  const content = Array.isArray(message.content)
    ? message.content
    : Array.isArray(event.content)
      ? event.content
      : [];

  for (const part of content) {
    const text = getTextFromPart(part);
    if (text?.kind === 'text') messages.push(new AssistantMessage(timestamp, text.value));
    if (text?.kind === 'thinking') messages.push(new ThinkingMessage(timestamp, text.value));

    const rawPart = asObject(part);
    if (rawPart.type === 'tool_use' || rawPart.type === 'tool-call') {
      messages.push(convertCursorToolUse(timestamp, rawPart));
    }
  }

  const directText = asString(event.delta ?? event.text ?? event.result);
  if (directText) {
    messages.push(new AssistantMessage(timestamp, directText));
  }

  return messages;
}

function cursorExitCodeForResult(event: CursorCliEvent): number {
  if (event.subtype === 'success') return 0;
  if (event.subtype === 'error' || event.is_error === true || event.isError === true) return 1;
  return 0;
}

function buildCursorPrompt(request: StartSessionRequest | ResumeTurnRequest): string {
  if (request.images?.length) {
    throw new Error('Cursor Agent does not support image attachments through Garcon.');
  }
  return request.command.trim();
}

function shouldForcePermissions(permissionMode: PermissionMode): boolean {
  return permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';
}

function buildCursorArgs(
  request: StartSessionRequest | ResumeTurnRequest,
  prompt: string,
  providerSessionId?: string,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--workspace',
    request.projectPath,
    '--trust',
  ];

  if (providerSessionId) {
    args.push('--resume', providerSessionId);
  } else if (request.model && request.model !== 'default') {
    args.push('--model', request.model);
  }

  if (request.permissionMode === CURSOR_PROMPT_PLAN_MODE) {
    args.push('--mode', 'plan');
  }

  if (shouldForcePermissions(request.permissionMode)) {
    args.push('--force');
  }

  args.push(prompt);
  return args;
}

function buildCursorEnv(envOverrides?: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...envOverrides };
}

async function runCursorCommand(args: string[], options: {
  cwd?: string;
  envOverrides?: Record<string, string>;
} = {}): Promise<string> {
  const proc = Bun.spawn([getCursorBinary(), ...args], {
    cwd: options.cwd || process.cwd(),
    env: buildCursorEnv(options.envOverrides),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Cursor Agent exited with code ${exitCode}${details ? `: ${details}` : ''}`);
  }
  return stdout;
}

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  const cwd = typeof options.cwd === 'string'
    ? options.cwd
    : typeof options.projectPath === 'string'
      ? options.projectPath
      : process.cwd();
  const args = [
    '--print',
    '--output-format',
    'json',
    '--mode',
    'ask',
    '--workspace',
    cwd,
    '--trust',
  ];
  const model = typeof options.model === 'string' ? options.model : '';
  if (model && model !== 'default') args.push('--model', model);
  args.push(prompt);

  const raw = (await runCursorCommand(args, {
    cwd,
    envOverrides: options.envOverrides && typeof options.envOverrides === 'object'
      ? options.envOverrides as Record<string, string>
      : undefined,
  })).trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const directText = asString(parsed.result ?? parsed.text ?? parsed.content);
    if (directText !== undefined) return directText;

    const assistantText = assistantMessagesFromEvent(parsed)
      .map((message) => message.type === 'assistant-message' ? message.content : '')
      .filter(Boolean)
      .join('\n');
    return assistantText || raw;
  } catch {
    return raw;
  }
}

export class CursorProvider extends AbsProvider {
  #runningSessions = new Map<string, CursorSession>();
  #requestIdentities: CursorRequestIdentityStore;

  constructor(requestIdentities = new CursorRequestIdentityStore()) {
    super();
    this.#requestIdentities = requestIdentities;
  }

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    return getCursorModels();
  }

  #activateSession(session: CursorSession, sessionId: string): void {
    const previousId = session.id;
    session.id = sessionId;
    if (previousId !== sessionId) {
      this.#runningSessions.delete(previousId);
      this.#runningSessions.set(sessionId, session);
    }

    if (!session.sessionCreatedEmitted) {
      session.sessionCreatedEmitted = true;
      this.emitSessionCreated(session.chatId);
    }

    this.#requestIdentities.rememberProviderSession(this.#identityInput(session, {
      providerSessionId: sessionId,
    }));

    const tracker = session.startedSession;
    if (tracker && !tracker.resolved) {
      tracker.resolved = true;
      tracker.resolve({
        providerSessionId: sessionId,
        nativePath: createArtificialNativePath('cursor', sessionId),
      });
    }
  }

  #identityInput(
    session: CursorSession,
    patch: {
      providerSessionId?: string;
      providerRequestId?: string;
      userEchoSeen?: boolean;
    } = {},
  ) {
    const providerSessionId = patch.providerSessionId
      ?? (session.id.startsWith('pending-') ? undefined : session.id);
    return {
      chatId: session.chatId,
      providerSessionId,
      clientRequestId: session.clientRequestId,
      turnId: session.turnId,
      providerRequestId: patch.providerRequestId ?? session.providerRequestId,
      userEchoSeen: patch.userEchoSeen,
    };
  }

  #rememberTurnIdentity(session: CursorSession, request: StartSessionRequest | ResumeTurnRequest): void {
    session.clientRequestId = request.clientRequestId;
    session.turnId = request.turnId;
    session.providerRequestId = undefined;
    session.userEchoSeen = false;
    this.#requestIdentities.rememberTurn(this.#identityInput(session));
  }

  #routeEvent(session: CursorSession, event: CursorCliEvent): void {
    const timestamp = new Date().toISOString();

    if (event.type === 'system' && event.subtype === 'init') {
      const sessionId = getSessionId(event);
      if (sessionId) this.#activateSession(session, sessionId);
      return;
    }

    if (event.type === 'user') {
      session.userEchoSeen = true;
      const sessionId = getSessionId(event);
      if (sessionId && session.id !== sessionId) this.#activateSession(session, sessionId);
      this.#requestIdentities.markUserEcho(this.#identityInput(session, {
        providerSessionId: sessionId,
        userEchoSeen: true,
      }));
      return;
    }

    if (event.type === 'assistant') {
      const messages = assistantMessagesFromEvent(event);
      if (messages.some((message) => message.type === 'assistant-message')) {
        session.assistantSeen = true;
      }
      for (const message of messages) {
        if (isToolUseMessage(message) && message.toolId) {
          session.emittedToolIds.add(message.toolId);
        }
      }
      this.emitMessages(session.chatId, messages);
      return;
    }

    if (event.type === 'tool_call') {
      const toolId = getToolCallId(event);
      if (toolId && !session.emittedToolIds.has(toolId)) {
        session.emittedToolIds.add(toolId);
        this.emitMessages(session.chatId, [convertCursorToolUse(timestamp, event)]);
      }

      if (event.subtype === 'completed' || 'result' in event || 'output' in event) {
        const payload = extractToolResultPayload(event);
        this.emitMessages(session.chatId, [
          new ToolResultMessage(
            timestamp,
            toolId,
            normalizeCursorToolResultContent(getToolName(event), payload, getHighLevelToolCallResult(event)),
            isToolResultError(event, payload),
          ),
        ]);
      }
      return;
    }

    if (event.type === 'result') {
      const resultText = asString(event.result);
      if (resultText && !session.assistantSeen) {
        this.emitMessages(session.chatId, [new AssistantMessage(timestamp, resultText)]);
      }
      const sessionId = getSessionId(event);
      if (sessionId && session.id !== sessionId) this.#activateSession(session, sessionId);
      const providerRequestId = getRequestId(event);
      if (providerRequestId) {
        session.providerRequestId = providerRequestId;
        this.#requestIdentities.markProviderRequestId(this.#identityInput(session, {
          providerRequestId,
        }));
      }
      session.resultSeen = true;
      const exitCode = cursorExitCodeForResult(event);
      this.emitFinished(
        session.chatId,
        exitCode,
        providerRequestId ? { providerRequestId } : undefined,
      );
      this.#finalizeTurn(session, exitCode);
      return;
    }

    if (event.type === 'error') {
      const message = asString(event.message ?? event.error) ?? 'Cursor Agent reported an error.';
      this.emitMessages(session.chatId, [new ErrorMessage(timestamp, message)]);
      this.emitFailed(session.chatId, message);
      this.#finalizeTurn(session, 1);
    }
  }

  #parseStdoutLine(session: CursorSession, line: string): void {
    if (!line.trim()) return;
    try {
      this.#routeEvent(session, JSON.parse(line) as CursorCliEvent);
    } catch {
      this.emitMessages(session.chatId, [new AssistantMessage(new Date().toISOString(), line)]);
    }
  }

  async #readStdout(session: CursorSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
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
        buffer = lines.pop() ?? '';
        for (const line of lines) this.#parseStdoutLine(session, line);
      }
      buffer += decoder.decode();
      this.#parseStdoutLine(session, buffer);
    } catch (error) {
      if (!proc.killed) {
        console.error(`cursor(${session.id.slice(0, 8)}): stdout read error:`, (error as Error).message);
      }
    } finally {
      const exitCode = await proc.exited;
      if (session.process === proc) session.process = null;
      this.#finalizeTurn(session, exitCode);
    }
  }

  async #pipeStderr(session: CursorSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr) return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), line.trim())]);
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), buffer.trim())]);
      }
    } catch {
      // The stream can close while the child process exits.
    }
  }

  #spawnCursor(
    session: CursorSession,
    request: StartSessionRequest | ResumeTurnRequest,
    args: string[],
  ): ReturnType<typeof Bun.spawn> {
    const proc = Bun.spawn([getCursorBinary(), ...args], {
      cwd: request.projectPath,
      env: buildCursorEnv(request.envOverrides),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    session.process = proc;
    void this.#readStdout(session, proc);
    void this.#pipeStderr(session, proc);
    return proc;
  }

  #finalizeTurn(session: CursorSession, exitCode?: number): void {
    if (session.finalized) return;
    session.finalized = true;

    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (session.startedSession && !session.startedSession.resolved) {
      session.startedSession.resolved = true;
      session.startedSession.reject(
        new Error(`Cursor Agent exited before session init${exitCode != null ? ` (code ${exitCode})` : ''}`),
      );
    } else if (!session.resultSeen && !session.aborted) {
      this.emitFailed(
        session.chatId,
        `Cursor Agent exited before completion${exitCode != null ? ` (code ${exitCode})` : ''}`,
      );
    }

    if (session.id && !session.isRunning) {
      this.#runningSessions.delete(session.id);
    }

    const resolve = session.turnResolve;
    session.turnResolve = null;
    resolve?.();
  }

  #waitForTurnComplete(session: CursorSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();
    return new Promise((resolve) => {
      session.turnResolve = resolve;
    });
  }

  #resetSessionForTurn(session: CursorSession, chatId: string): void {
    session.aborted = false;
    session.assistantSeen = false;
    session.chatId = chatId;
    session.clientRequestId = undefined;
    session.emittedToolIds = new Set();
    session.finalized = false;
    session.isRunning = true;
    session.process = null;
    session.providerRequestId = undefined;
    session.resultSeen = false;
    session.startTime = Date.now();
    session.startedSession = null;
    session.turnResolve = null;
    session.turnId = undefined;
    session.userEchoSeen = false;
  }

  async startSession(request: StartSessionRequest): Promise<StartedProviderSession> {
    const prompt = buildCursorPrompt(request);
    const startedSession = createStartTracker();
    const session = createSession(request.chatId, startedSession);
    this.#runningSessions.set(session.id, session);
    this.#rememberTurnIdentity(session, request);
    this.emitProcessing(request.chatId, true);

    try {
      this.#spawnCursor(session, request, buildCursorArgs(request, prompt));
      return await startedSession.promise;
    } catch (error) {
      this.#runningSessions.delete(session.id);
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(request.chatId, false);
      }
      throw error;
    }
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const existingSession = this.#runningSessions.get(request.providerSessionId);
    if (existingSession?.isRunning) {
      throw new Error(`Session ${request.providerSessionId} is already running`);
    }

    const prompt = buildCursorPrompt(request);
    const session = existingSession ?? {
      ...createSession(request.chatId),
      id: request.providerSessionId,
      sessionCreatedEmitted: true,
    };
    this.#resetSessionForTurn(session, request.chatId);
    session.id = request.providerSessionId;
    session.sessionCreatedEmitted = true;
    this.#runningSessions.set(session.id, session);
    this.#rememberTurnIdentity(session, request);

    this.emitProcessing(request.chatId, true);

    try {
      this.#spawnCursor(session, request, buildCursorArgs(request, prompt, request.providerSessionId));
      await this.#waitForTurnComplete(session);
    } catch (error) {
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(request.chatId, false);
      }
      this.#runningSessions.delete(session.id);
      throw error;
    }
  }

  abort(providerSessionId: string): boolean {
    const session = this.#runningSessions.get(providerSessionId);
    if (!session?.process) return false;
    session.aborted = true;
    session.process.kill();
    this.#finalizeTurn(session, 143);
    return true;
  }

  isRunning(providerSessionId: string): boolean {
    return this.#runningSessions.get(providerSessionId)?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; startedAt: string; status: string }> {
    return Array.from(this.#runningSessions.values())
      .filter((session) => session.isRunning && Boolean(session.id))
      .map((session) => ({
        id: session.id,
        startedAt: new Date(session.startTime).toISOString(),
        status: 'running',
      }));
  }

  async loadMessages(session: ProviderChatEntry, context: { chatId?: string } = {}): Promise<ChatMessage[]> {
    const providerSessionId = session.providerSessionId
      || getArtificialProviderSessionId(session.nativePath, 'cursor')
      || '';
    const messages = await loadCursorChatMessagesBySessionId(providerSessionId, session.projectPath);
    return this.#requestIdentities.applyToMessages(messages, {
      chatId: context.chatId,
      providerSessionId,
    });
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
    const maxAge = 30 * 60 * 1000;
    return setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.#runningSessions.entries()) {
        if (!session.isRunning && now - session.startTime > maxAge) {
          this.#runningSessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }
}

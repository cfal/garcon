import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { FactoryConfig } from '../../config.js';
import {
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { normalizeToolResultContent }  from '@garcon/server-agent-common/shared/normalize-util';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import { convertFactoryToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import {
  assertFactoryExecutionOpen,
  factoryEventMetadata,
  markFactoryExecutionStarted,
  type FactoryCommandImage,
  type FactoryResumeRequest,
  type FactoryStartRequest,
  type FactoryStartedSession,
} from './runtime-types.js';
import { FactoryModelCatalogService } from './factory-models.js';
import { inferFactoryModelSupportsImages, isFactoryCustomModel } from './factory-model-id.js';
import { buildFactoryCliEnv } from './factory-env.js';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { RuntimeEventMetadata } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { findFactorySessionFileBySessionId } from './history-loader.js';
import { convertFactoryAssistantText, visibleFactoryAssistantText } from './factory-text.js';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';

const DEFAULT_CONFIG: FactoryConfig = {
  binary: () => 'droid',
  apiKey: () => null,
  homeOverride: () => null,
};
const SILENT_LOGGER: AgentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

interface FactorySession {
  chatId: string;
  id: string;
  activeTurn: FactoryTurnContext | null;
  readonly sources: Set<FactoryTurnContext>;
  sessionCreatedEmitted: boolean;
  lastActivityAt: number;
}

interface FactoryTurnContext {
  readonly eventMetadata: RuntimeEventMetadata;
  readonly operation: AgentRuntimeOperation;
  readonly startedAt: number;
  cleanup?: (() => Promise<void>) | undefined;
  isRunning: boolean;
  processingStarted: boolean;
  completed: boolean;
  aborted: boolean;
  sourceRetired: boolean;
  process: ReturnType<typeof Bun.spawn> | null;
  resolve: (() => void) | null;
  startedSession: FactoryStartedSessionTracker | null;
}

interface FactoryStartedSessionTracker {
  readonly promise: Promise<FactoryStartedSession>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: FactoryStartedSession) => void;
  identityObserved: boolean;
  settled: boolean;
}

interface FactorySystemInitEvent {
  cwd?: string;
  model?: string;
  reasoning_effort?: string;
  session_id?: string;
  subtype?: string;
  type: 'system';
}

interface FactoryMessageEvent {
  id?: string;
  role?: string;
  session_id?: string;
  text?: string;
  timestamp?: number | string;
  type: 'message';
}

interface FactoryToolCallEvent {
  id?: string;
  parameters?: Record<string, unknown>;
  session_id?: string;
  toolId?: string;
  toolName?: string;
  type: 'tool_call';
}

interface FactoryToolResultEvent {
  id?: string;
  isError?: boolean;
  session_id?: string;
  toolId?: string;
  type: 'tool_result';
  value?: unknown;
}

interface FactoryCompletionEvent {
  finalText?: string;
  session_id?: string;
  subtype?: string;
  type: 'completion' | 'result';
}

type FactoryCliEvent =
  | FactoryCompletionEvent
  | FactoryMessageEvent
  | FactorySystemInitEvent
  | FactoryToolCallEvent
  | FactoryToolResultEvent
  | Record<string, unknown>;

const FACTORY_ALLOWED_TOOLS = [
  'Read',
  'LS',
  'Execute',
  'Edit',
  'ApplyPatch',
  'Grep',
  'Glob',
  'Create',
  'WebSearch',
  'FetchUrl',
  'TodoWrite',
  'Task',
];

const FACTORY_PLAN_PREFIX = [
  'You are operating in Garcon plan mode.',
  'Do not modify files, run mutating commands, or carry out implementation.',
  'Analyze the task, inspect the codebase, and respond with a concrete implementation plan only.',
].join('\n');

function toIsoString(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

// Effort ladder ordered strongest-first; the requested level clamps down to
// the strongest effort the model actually supports.
const FACTORY_EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'] as const;

function mapFactoryReasoningEffort(thinkingMode: ThinkingMode, supportedReasoningEfforts: string[] | undefined): string | undefined {
  if (thinkingMode === 'none') return undefined;
  if (!supportedReasoningEfforts || supportedReasoningEfforts.length === 0) return undefined;

  const normalized = new Set(supportedReasoningEfforts.map((entry) => entry.toLowerCase()));
  const start = FACTORY_EFFORT_LADDER.indexOf(thinkingMode as typeof FACTORY_EFFORT_LADDER[number]);
  if (start >= 0) {
    for (const level of FACTORY_EFFORT_LADDER.slice(start)) {
      if (normalized.has(level)) return level;
    }
  }
  if (normalized.has('off')) return 'off';
  if (normalized.has('none')) return 'none';
  return undefined;
}

async function writeImagesToTempFiles(images: FactoryCommandImage[]): Promise<{ cleanup: () => Promise<void>; paths: string[] }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-images-'));
  const filePaths: string[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const match = image.data?.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;
    const mimeType = match[1];
    const extension = mimeType === 'image/jpeg'
      ? '.jpg'
      : mimeType === 'image/gif'
        ? '.gif'
        : mimeType === 'image/webp'
          ? '.webp'
          : '.png';
    const filePath = path.join(tempDir, `image-${index}${extension}`);
    await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
    filePaths.push(filePath);
  }

  return {
    cleanup: async () => {
      await fs.rm(tempDir, { force: true, recursive: true }).catch(() => { });
    },
    paths: filePaths,
  };
}

async function buildFactoryPrompt(
  command: string,
  images: FactoryCommandImage[] | undefined,
  modelSupportsImages: boolean,
  permissionMode: PermissionMode,
): Promise<{ cleanup?: () => Promise<void>; prompt: string }> {
  let prompt = command;

  if (permissionMode === 'plan') {
    prompt = `${FACTORY_PLAN_PREFIX}\n\n${command}`;
  }

  if (!images?.length || !modelSupportsImages) {
    return { prompt };
  }

  const { cleanup, paths } = await writeImagesToTempFiles(images);
  if (paths.length === 0) {
    return { prompt, cleanup };
  }

  const imagePreamble = [
    'The user attached image files.',
    'Inspect them if relevant before answering.',
    ...paths.map((filePath) => `- ${filePath}`),
  ].join('\n');

  return {
    cleanup,
    prompt: `${imagePreamble}\n\n${prompt}`,
  };
}

function buildFactoryArgs(
  request: Pick<FactoryResumeRequest, 'model' | 'permissionMode' | 'projectPath' | 'thinkingMode'> & { agentSessionId?: string | null },
  reasoningEffort: string | undefined,
): string[] {
  const args = [
    'exec',
    '--output-format',
    'debug',
    '--cwd',
    request.projectPath,
    '--enabled-tools',
    FACTORY_ALLOWED_TOOLS.join(','),
  ];

  if (request.model) {
    args.push('--model', request.model);
  }
  if (request.agentSessionId) {
    args.push('--session-id', request.agentSessionId);
  }
  if (reasoningEffort) {
    args.push('--reasoning-effort', reasoningEffort);
  }
  if (request.permissionMode === 'acceptEdits') {
    args.push('--auto', 'medium');
  } else if (request.permissionMode === 'bypassPermissions') {
    args.push('--skip-permissions-unsafe');
  }

  return args;
}

function shouldAirgapFactoryInvocation(model: string, options: { resume: boolean }): boolean {
  // Droid airgap disables Factory-hosted traffic for BYOK starts, but current
  // releases fail resumed custom sessions under airgap. Resumes keep the
  // custom model flag and intentionally stay online.
  if (options.resume) return false;
  return isFactoryCustomModel(model);
}

function buildFactoryEnvironment(config: FactoryConfig, airgap: boolean) {
  const apiKey = config.apiKey();
  return buildFactoryCliEnv({
    airgap,
    baseEnv: {
      ...process.env,
      ...(apiKey ? { FACTORY_API_KEY: apiKey } : {}),
    },
  });
}

async function runFactoryExec(
  args: string[],
  prompt: string,
  options: { airgap: boolean; config?: FactoryConfig; signal?: AbortSignal },
): Promise<{ stderr: string; stdout: string }> {
  const factoryBinary = (options.config ?? DEFAULT_CONFIG).binary();
  const proc = Bun.spawn([factoryBinary, ...args], {
    env: buildFactoryEnvironment(options.config ?? DEFAULT_CONFIG, options.airgap),
    stdin: new Blob([prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  options.signal?.throwIfAborted();

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Factory exec failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }

  return { stdout, stderr };
}

async function resolveFactoryStartedNativePath(sessionId: string): Promise<string> {
  const found = await findFactorySessionFileBySessionId(sessionId);
  if (!found) {
    throw new Error(`Factory did not create a JSONL transcript path for session ${sessionId}`);
  }
  return found;
}

export async function runSingleQuery(
  prompt: string,
  options: Record<string, unknown> = {},
  config: FactoryConfig = DEFAULT_CONFIG,
  models: FactoryModelCatalogService = new FactoryModelCatalogService(config),
): Promise<string> {
  const request = {
    model: typeof options.model === 'string' ? options.model : '',
    permissionMode: typeof options.permissionMode === 'string' ? options.permissionMode as PermissionMode : 'default',
    projectPath: typeof options.cwd === 'string'
      ? options.cwd
      : typeof options.projectPath === 'string'
        ? options.projectPath
        : process.cwd(),
    thinkingMode: normalizeThinkingMode(options.thinkingMode),
  };
  return withSingleQueryControl(options, async (signal) => {
    const metadata = request.model ? await models.getModelMetadata(request.model) : null;
    const reasoningEffort = request.thinkingMode === 'none' ? undefined : request.thinkingMode;
    const supportsImages = metadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
    const args = buildFactoryArgs(request, reasoningEffort).map((entry) => entry);
    args[1] = '--output-format';
    args[2] = 'json';

    const { cleanup, prompt: nextPrompt } = await buildFactoryPrompt(prompt, undefined, supportsImages, request.permissionMode);
    try {
      const { stdout } = await runFactoryExec(args, nextPrompt, {
        airgap: shouldAirgapFactoryInvocation(request.model, { resume: false }),
        config,
        signal,
      });
      const parsed = JSON.parse(stdout) as { result?: string };
      return typeof parsed.result === 'string' ? visibleFactoryAssistantText(parsed.result) : '';
    } finally {
      if (cleanup) await cleanup();
    }
  });
}

function convertFactoryMessageEvent(event: FactoryMessageEvent): ChatMessage[] {
  const timestamp = toIsoString(event.timestamp);
  if (event.role === 'assistant' && typeof event.text === 'string') {
    return convertFactoryAssistantText(timestamp, event.text);
  }
  if (event.role === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
    return [new ThinkingMessage(timestamp, event.text)];
  }
  return [];
}

function createFactorySession(chatId: string, sessionId: string): FactorySession {
  return {
    chatId,
    id: sessionId,
    activeTurn: null,
    sources: new Set(),
    sessionCreatedEmitted: Boolean(sessionId),
    lastActivityAt: Date.now(),
  };
}

function createFactoryTurn(options: {
  readonly cleanup?: (() => Promise<void>) | undefined;
  readonly eventMetadata: RuntimeEventMetadata;
  readonly operation: AgentRuntimeOperation;
  readonly startedSession: FactoryStartedSessionTracker | null;
}): FactoryTurnContext {
  return {
    cleanup: options.cleanup,
    eventMetadata: options.eventMetadata,
    operation: options.operation,
    startedSession: options.startedSession,
    startedAt: Date.now(),
    isRunning: true,
    processingStarted: false,
    completed: false,
    aborted: false,
    sourceRetired: false,
    process: null,
    resolve: null,
  };
}

export class FactoryCliRuntime extends AgentEventEmitterRuntime {
  readonly #config: FactoryConfig;
  readonly #logger: AgentLogger;
  readonly #models: FactoryModelCatalogService;
  #runningSessions = new Map<string, FactorySession>();
  #idlePurger = new IdleSessionPurger<FactorySession>({
    sessions: () => this.#runningSessions.entries(),
    isRunning: (session) => session.activeTurn?.isRunning === true,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (_id, session) => this.#retireSession(session),
  });

  constructor(options: {
    readonly config?: FactoryConfig;
    readonly logger?: AgentLogger;
    readonly models?: FactoryModelCatalogService;
  } = {}) {
    super();
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#models = options.models ?? new FactoryModelCatalogService(this.#config);
  }

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    return this.#models.getModels();
  }

  #completeTurn(session: FactorySession, turn: FactoryTurnContext): void {
    if (turn.completed) return;
    turn.completed = true;
    session.lastActivityAt = Date.now();
    turn.isRunning = false;
    if (session.activeTurn === turn) {
      session.activeTurn = null;
      if (turn.processingStarted) this.emitProcessing(session.chatId, false);
    }
    const resolve = turn.resolve;
    turn.resolve = null;
    if (turn.cleanup) {
      void turn.cleanup().catch(() => { });
      turn.cleanup = undefined;
    }
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
            this.#logger.info('Factory stderr output.', { sessionId });
          }
        }
      }
    } catch {
      // Stream closed.
    }
  }

  #routeEvent(
    session: FactorySession,
    turn: FactoryTurnContext,
    event: FactoryCliEvent,
  ): void {
    if (turn.sourceRetired) return;
    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'system': {
        const initEvent = event as FactorySystemInitEvent;
        if (initEvent.subtype !== 'init' || !initEvent.session_id) return;

        if (session.id && session.id !== initEvent.session_id) {
          this.#logger.warn('Factory process changed session identity.', {
            expectedSessionId: session.id,
            sessionId: initEvent.session_id,
          });
          return;
        }
        session.id = initEvent.session_id;

        if (!session.sessionCreatedEmitted) {
          this.emitSessionCreated(session.chatId);
          session.sessionCreatedEmitted = true;
        }

        if (turn.startedSession && !turn.startedSession.identityObserved) {
          const startedSession = turn.startedSession;
          const agentSessionId = session.id;
          startedSession.identityObserved = true;

          // Factory chats are persisted only with Droid's real JSONL path.
          // A missing path is treated as startup failure instead of inventing
          // a placeholder that cannot support reliable resume/reload.
          void resolveFactoryStartedNativePath(agentSessionId)
            .then((nativePath) => {
              startedSession.resolve({ agentSessionId, nativePath });
            })
            .catch((error) => {
              this.#logger.warn('Factory native path resolution failed.', {
                sessionId: agentSessionId,
                error: error instanceof Error ? error.message : String(error),
              });
              turn.aborted = true;
              if (turn.process && !turn.process.killed) {
                turn.process.kill();
              }
              startedSession.reject(error);
            });
        }
        break;
      }

      case 'message': {
        const chatMessages = convertFactoryMessageEvent(event as FactoryMessageEvent);
        if (chatMessages.length > 0) {
          this.#publishMessages(session, turn, chatMessages);
        }
        break;
      }

      case 'tool_call':
        this.#publishMessages(session, turn, [
          convertFactoryToolUse(new Date().toISOString(), {
            id: (event as FactoryToolCallEvent).id,
            parameters: (event as FactoryToolCallEvent).parameters,
            toolId: (event as FactoryToolCallEvent).toolId,
            toolName: (event as FactoryToolCallEvent).toolName,
          }),
        ]);
        break;

      case 'tool_result': {
        const resultEvent = event as FactoryToolResultEvent;
        this.#publishMessages(session, turn, [
          new ToolResultMessage(
            new Date().toISOString(),
            resultEvent.id || '',
            normalizeToolResultContent(resultEvent.value),
            Boolean(resultEvent.isError),
          ),
        ]);
        break;
      }

      case 'completion':
      case 'result':
        if (!turn.completed) {
          this.#publishTurnEvent(session, turn, {
            type: 'run-ended',
            runId: turn.operation.runId,
            outcome: 'finished',
            exitCode: 0,
          });
          this.#completeTurn(session, turn);
          this.emitFinished(session.chatId, 0, turn.eventMetadata);
        }
        break;

      default:
        break;
    }
  }

  async #readStdout(
    session: FactorySession,
    proc: ReturnType<typeof Bun.spawn>,
    turn: FactoryTurnContext,
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
          try {
            this.#routeEvent(session, turn, JSON.parse(line) as FactoryCliEvent);
          } catch {
            this.#logger.warn('Factory emitted invalid JSON.', {
              sessionId: session.id,
            });
          }
        }
      }
    } finally {
      const exitCode = await proc.exited;
      if (!turn.completed) {
        if (turn.startedSession && !turn.startedSession.settled) {
          turn.startedSession.reject(
            new Error(`Factory process exited before session init (code ${exitCode})`),
          );
          this.#completeTurn(session, turn);
        } else if (!turn.aborted) {
          const message = `Factory process exited before completion (code ${exitCode})`;
          this.#publishTurnEvent(session, turn, {
            type: 'run-ended',
            runId: turn.operation.runId,
            outcome: 'failed',
            error: { code: 'PROVIDER_FAILURE', message },
          });
          this.#completeTurn(session, turn);
          this.emitFailed(session.chatId, message, turn.eventMetadata);
        } else {
          this.#completeTurn(session, turn);
        }
      }
      turn.sourceRetired = true;
      turn.process = null;
      session.sources.delete(turn);
    }
  }

  #spawnFactory(
    session: FactorySession,
    turn: FactoryTurnContext,
    args: string[],
    prompt: string,
    cwd: string,
    airgap: boolean,
  ): ReturnType<typeof Bun.spawn> {
    const factoryBinary = this.#config.binary();
    const proc = Bun.spawn([factoryBinary, ...args], {
      cwd,
      env: buildFactoryEnvironment(this.#config, airgap),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    turn.process = proc;
    session.sources.add(turn);

    const stdin = proc.stdin;
    if (!stdin || typeof stdin === 'number') throw new Error('Factory process stdin is unavailable');
    stdin.write(prompt);
    stdin.end();

    void this.#readStdout(session, proc, turn);
    void this.#pipeStderr(session.id || 'pending', proc);

    return proc;
  }

  #waitForTurnComplete(turn: FactoryTurnContext): Promise<void> {
    if (!turn.isRunning) return Promise.resolve();
    return new Promise((resolve) => {
      turn.resolve = resolve;
    });
  }

  #createSessionTracker(): FactoryStartedSessionTracker {
    let resolveRef: ((value: FactoryStartedSession) => void) | null = null;
    let rejectRef: ((error: unknown) => void) | null = null;
    const promise = new Promise<FactoryStartedSession>((resolve, reject) => {
      resolveRef = resolve;
      rejectRef = reject;
    });
    void promise.catch(() => undefined);
    const tracker: FactoryStartedSessionTracker = {
      promise,
      reject: (error) => {
        if (tracker.settled) return;
        tracker.settled = true;
        rejectRef?.(error);
      },
      resolve: (value) => {
        if (tracker.settled) return;
        tracker.settled = true;
        resolveRef?.(value);
      },
      identityObserved: false,
      settled: false,
    };
    return tracker;
  }

  #publishMessages(
    session: FactorySession,
    turn: FactoryTurnContext,
    messages: ChatMessage[],
  ): void {
    this.#publishTurnEvent(session, turn, {
      type: 'messages',
      rows: runtimeRows(messages),
      runId: turn.operation.runId,
    });
    this.emitMessages(session.chatId, messages, turn.eventMetadata);
  }

  #publishTurnEvent(
    session: FactorySession,
    turn: FactoryTurnContext,
    event: AgentRuntimeEvent,
  ): void {
    try {
      turn.operation.publish(event);
    } catch (error) {
      this.#logger.warn('Factory publisher rejected an event.', {
        sessionId: session.id || 'pending',
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #retireSupersededChatSessions(current: FactorySession): void {
    for (const session of this.#runningSessions.values()) {
      if (session === current || session.chatId !== current.chatId) continue;
      this.#retireSession(session);
    }
  }

  #retireSession(session: FactorySession): void {
    const turns = new Set(session.sources);
    if (session.activeTurn) turns.add(session.activeTurn);
    for (const turn of turns) {
      turn.aborted = true;
      turn.sourceRetired = true;
      turn.startedSession?.reject(new Error('Factory session source retired'));
      if (turn.process && !turn.process.killed) turn.process.kill();
      turn.process = null;
      if (!turn.completed) this.#completeTurn(session, turn);
    }
    session.sources.clear();
    if (session.id && this.#runningSessions.get(session.id) === session) {
      this.#runningSessions.delete(session.id);
    }
  }

  async startSession(request: FactoryStartRequest): Promise<FactoryStartedSession> {
    assertFactoryExecutionOpen(request);
    const modelMetadata = request.model ? await this.#models.getModelMetadata(request.model) : null;
    const reasoningEffort = mapFactoryReasoningEffort(request.thinkingMode, modelMetadata?.reasoningEfforts);
    const supportsImages = modelMetadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
    const args = buildFactoryArgs(request, reasoningEffort);
    const { cleanup, prompt } = await buildFactoryPrompt(request.command, request.images, supportsImages, request.permissionMode);
    const startedSession = this.#createSessionTracker();
    const session = createFactorySession(request.chatId, '');
    const turn = createFactoryTurn({
      cleanup,
      eventMetadata: factoryEventMetadata(request, 'chat-start'),
      operation: request.operation,
      startedSession,
    });
    session.activeTurn = turn;

    try {
      if (request.executionAdmission) await markFactoryExecutionStarted(request);
      turn.processingStarted = true;
      this.emitProcessing(request.chatId, true);
      this.#spawnFactory(
        session,
        turn,
        args,
        prompt,
        request.projectPath,
        shouldAirgapFactoryInvocation(request.model, { resume: false }),
      );
      const result = await startedSession.promise;
      assertFactoryExecutionOpen(request);
      const matchingSession = this.#runningSessions.get(result.agentSessionId);
      if (matchingSession && matchingSession.chatId !== request.chatId) {
        throw new Error(`Factory session ${result.agentSessionId} is already bound to another chat`);
      }
      this.#retireSupersededChatSessions(session);
      this.#runningSessions.set(result.agentSessionId, session);
      return result;
    } catch (error) {
      const turnCleanup = turn.cleanup;
      turn.cleanup = undefined;
      this.#rollbackTurnLaunch(session, turn, true, error);
      if (turnCleanup) await turnCleanup();
      throw error;
    }
  }

  async runTurn(request: FactoryResumeRequest): Promise<void> {
    assertFactoryExecutionOpen(request);
    const existingSession = this.#runningSessions.get(request.agentSessionId);
    if (existingSession) {
      if (existingSession.chatId !== request.chatId) {
        throw new Error('Chat ID mismatch');
      }
      if (existingSession.activeTurn?.isRunning) {
        throw new Error(`Session ${request.agentSessionId} is already running`);
      }
    }

    const modelMetadata = request.model ? await this.#models.getModelMetadata(request.model) : null;
    const reasoningEffort = mapFactoryReasoningEffort(request.thinkingMode, modelMetadata?.reasoningEfforts);
    const supportsImages = modelMetadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
    const args = buildFactoryArgs(request, reasoningEffort);
    const { cleanup, prompt } = await buildFactoryPrompt(request.command, request.images, supportsImages, request.permissionMode);
    const session = existingSession
      ?? createFactorySession(request.chatId, request.agentSessionId);
    const turn = createFactoryTurn({
      cleanup,
      eventMetadata: factoryEventMetadata(request),
      operation: request.operation,
      startedSession: null,
    });
    session.activeTurn = turn;
    session.lastActivityAt = Date.now();
    this.#runningSessions.set(session.id, session);

    try {
      if (request.executionAdmission) await markFactoryExecutionStarted(request);
      turn.processingStarted = true;
      this.emitProcessing(request.chatId, true);
      this.#spawnFactory(
        session,
        turn,
        args,
        prompt,
        request.projectPath,
        shouldAirgapFactoryInvocation(request.model, { resume: true }),
      );
      await this.#waitForTurnComplete(turn);
    } catch (error) {
      const turnCleanup = turn.cleanup;
      turn.cleanup = undefined;
      this.#rollbackTurnLaunch(session, turn, false, error);
      if (turnCleanup) await turnCleanup();
      throw error;
    }
  }

  #rollbackTurnLaunch(
    session: FactorySession,
    turn: FactoryTurnContext,
    removeSession: boolean,
    error: unknown,
  ): void {
    turn.aborted = true;
    turn.sourceRetired = true;
    turn.startedSession?.reject(error);
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

  abort(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    const turn = session?.activeTurn;
    if (!session || !turn?.process) return false;
    turn.aborted = true;
    turn.process.kill();
    this.#completeTurn(session, turn);
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#runningSessions.get(agentSessionId)?.activeTurn?.isRunning === true;
  }

  getRunningSessions(): Array<{ id: string; startedAt: string; status: string }> {
    return Array.from(this.#runningSessions.values())
      .filter((session) => session.activeTurn?.isRunning && Boolean(session.id))
      .map((session) => ({
        id: session.id,
        startedAt: new Date(session.activeTurn!.startedAt).toISOString(),
        status: 'running',
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

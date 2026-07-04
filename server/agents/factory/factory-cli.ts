import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getFactoryBinary } from "../../config.js";
import {
  ThinkingMessage,
  ToolResultMessage,
  type ChatMessage,
} from "../../../common/chat-types.js";
import { normalizeToolResultContent }  from "../shared/normalize-util.js";
import { convertFactoryToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import { IdleSessionPurger } from "../shared/idle-session-purger.js";
import type { AgentCommandImage, PermissionMode, ResumeTurnRequest, StartSessionRequest, StartedAgentSession, ThinkingMode } from "../session-types.js";
import { getFactoryModelMetadata, getFactoryModels } from './factory-models.js';
import { inferFactoryModelSupportsImages, isFactoryCustomModel } from './factory-model-id.js';
import { buildFactoryCliEnv } from './factory-env.js';
import { createLogger } from '../../lib/log.js';
import { findFactorySessionFileBySessionId } from './history-loader.js';
import { convertFactoryAssistantText, visibleFactoryAssistantText } from './factory-text.js';

const logger = createLogger('agents:factory:factory-cli');

interface FactorySession {
  aborted: boolean;
  chatId: string;
  cleanup?: (() => Promise<void>) | undefined;
  finalized: boolean;
  id: string;
  isRunning: boolean;
  process: ReturnType<typeof Bun.spawn> | null;
  resultSeen: boolean;
  sessionCreatedEmitted: boolean;
  startTime: number;
  lastActivityAt: number;
  startedSession: {
    promise: Promise<StartedAgentSession>;
    reject: (error: unknown) => void;
    resolve: (value: StartedAgentSession) => void;
    resolved: boolean;
  } | null;
  turnResolve: (() => void) | null;
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

async function writeImagesToTempFiles(images: AgentCommandImage[]): Promise<{ cleanup: () => Promise<void>; paths: string[] }> {
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
  images: AgentCommandImage[] | undefined,
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
  request: Pick<ResumeTurnRequest, 'model' | 'permissionMode' | 'projectPath' | 'thinkingMode'> & { agentSessionId?: string | null },
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

async function runFactoryExec(
  args: string[],
  prompt: string,
  options: { airgap: boolean },
): Promise<{ stderr: string; stdout: string }> {
  const factoryBinary = getFactoryBinary();
  const proc = Bun.spawn([factoryBinary, ...args], {
    env: buildFactoryCliEnv({ airgap: options.airgap }),
    stdin: new Blob([prompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

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

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  const request = {
    model: typeof options.model === 'string' ? options.model : '',
    permissionMode: typeof options.permissionMode === 'string' ? options.permissionMode as PermissionMode : 'default',
    projectPath: typeof options.cwd === 'string'
      ? options.cwd
      : typeof options.projectPath === 'string'
        ? options.projectPath
        : process.cwd(),
    thinkingMode: typeof options.thinkingMode === 'string' ? options.thinkingMode as ThinkingMode : 'none',
  };
  const metadata = request.model ? await getFactoryModelMetadata(request.model) : null;
  const reasoningEffort = mapFactoryReasoningEffort(request.thinkingMode, metadata?.reasoningEfforts);
  const supportsImages = metadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
  const args = buildFactoryArgs(request, reasoningEffort).map((entry) => entry);
  args[1] = '--output-format';
  args[2] = 'json';

  const { cleanup, prompt: nextPrompt } = await buildFactoryPrompt(prompt, undefined, supportsImages, request.permissionMode);
  try {
    const { stdout } = await runFactoryExec(args, nextPrompt, {
      airgap: shouldAirgapFactoryInvocation(request.model, { resume: false }),
    });
    const parsed = JSON.parse(stdout) as { result?: string };
    return typeof parsed.result === 'string' ? visibleFactoryAssistantText(parsed.result) : '';
  } finally {
    if (cleanup) await cleanup();
  }
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

export class FactoryCliRuntime extends AgentEventEmitterRuntime {
  #runningSessions = new Map<string, FactorySession>();
  #idlePurger = new IdleSessionPurger<FactorySession>({
    sessions: () => this.#runningSessions.entries(),
    isRunning: (session) => session.isRunning,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (id, session) => {
      if (session.process && !session.process.killed) session.process.kill();
      this.#runningSessions.delete(id);
    },
  });

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    return getFactoryModels();
  }

  #finalizeTurn(session: FactorySession, exitCode?: number): void {
    if (session.finalized) return;
    session.finalized = true;
    session.lastActivityAt = Date.now();
    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (session.startedSession && !session.startedSession.resolved) {
      session.startedSession.resolved = true;
      session.startedSession.reject(new Error(`Factory process exited before session init${exitCode != null ? ` (code ${exitCode})` : ''}`));
    } else if (!session.resultSeen && !session.aborted) {
      this.emitFailed(session.chatId, `Factory process exited before completion${exitCode != null ? ` (code ${exitCode})` : ''}`);
    }

    const resolve = session.turnResolve;
    session.turnResolve = null;
    if (session.cleanup) {
      void session.cleanup().catch(() => { });
      session.cleanup = undefined;
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
            logger.info(`factory(${sessionId.slice(0, 8)}): stderr: ${line}`);
          }
        }
      }
    } catch {
      // Stream closed.
    }
  }

  #routeEvent(session: FactorySession, event: FactoryCliEvent): void {
    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'system': {
        const initEvent = event as FactorySystemInitEvent;
        if (initEvent.subtype !== 'init' || !initEvent.session_id) return;

        if (!session.id) {
          session.id = initEvent.session_id;
          this.#runningSessions.set(session.id, session);
        }

        if (!session.sessionCreatedEmitted) {
          this.emitSessionCreated(session.chatId);
          session.sessionCreatedEmitted = true;
        }

        if (session.startedSession && !session.startedSession.resolved) {
          const startedSession = session.startedSession;
          const agentSessionId = session.id;
          startedSession.resolved = true;

          // Factory chats are persisted only with Droid's real JSONL path.
          // A missing path is treated as startup failure instead of inventing
          // a placeholder that cannot support reliable resume/reload.
          void resolveFactoryStartedNativePath(agentSessionId)
            .then((nativePath) => {
              startedSession.resolve({ agentSessionId, nativePath });
            })
            .catch((error) => {
              logger.warn(`factory(${agentSessionId.slice(0, 8)}): could not resolve native path:`, error);
              session.aborted = true;
              if (session.process && !session.process.killed) {
                session.process.kill();
              }
              startedSession.reject(error);
            });
        }
        break;
      }

      case 'message': {
        const chatMessages = convertFactoryMessageEvent(event as FactoryMessageEvent);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages);
        }
        break;
      }

      case 'tool_call':
        this.emitMessages(session.chatId, [
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
        this.emitMessages(session.chatId, [
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
        session.resultSeen = true;
        if (session.isRunning) {
          session.isRunning = false;
          this.emitProcessing(session.chatId, false);
        }
        this.emitFinished(session.chatId, 0);
        this.#finalizeTurn(session, 0);
        break;

      default:
        break;
    }
  }

  async #readStdout(session: FactorySession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
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
            this.#routeEvent(session, JSON.parse(line) as FactoryCliEvent);
          } catch {
            logger.warn(`factory(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
          }
        }
      }
    } finally {
      const exitCode = await proc.exited;
      if (session.process === proc) {
        session.process = null;
      }
      this.#finalizeTurn(session, exitCode);
    }
  }

  #spawnFactory(
    session: FactorySession,
    args: string[],
    prompt: string,
    cwd: string,
    airgap: boolean,
  ): ReturnType<typeof Bun.spawn> {
    const factoryBinary = getFactoryBinary();
    const proc = Bun.spawn([factoryBinary, ...args], {
      cwd,
      env: buildFactoryCliEnv({ airgap }),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdin = proc.stdin as unknown as { end(): void; write(chunk: string): void };
    stdin.write(prompt);
    stdin.end();

    session.process = proc;
    void this.#readStdout(session, proc);
    void this.#pipeStderr(session.id || 'pending', proc);

    return proc;
  }

  #waitForTurnComplete(session: FactorySession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();
    return new Promise((resolve) => {
      session.turnResolve = resolve;
    });
  }

  async #createSessionTracker(): Promise<FactorySession['startedSession']> {
    let resolveRef: ((value: StartedAgentSession) => void) | null = null;
    let rejectRef: ((error: unknown) => void) | null = null;
    const promise = new Promise<StartedAgentSession>((resolve, reject) => {
      resolveRef = resolve;
      rejectRef = reject;
    });
    return {
      promise,
      reject: (error) => {
        rejectRef?.(error);
      },
      resolve: (value) => {
        resolveRef?.(value);
      },
      resolved: false,
      // @ts-expect-error internal convenience for startSession
      promise,
    };
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const modelMetadata = request.model ? await getFactoryModelMetadata(request.model) : null;
    const reasoningEffort = mapFactoryReasoningEffort(request.thinkingMode, modelMetadata?.reasoningEfforts);
    const supportsImages = modelMetadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
    const args = buildFactoryArgs(request, reasoningEffort);
    const { cleanup, prompt } = await buildFactoryPrompt(request.command, request.images, supportsImages, request.permissionMode);
    const startedSession = await this.#createSessionTracker() as FactorySession['startedSession'] & { promise: Promise<StartedAgentSession> };
    const session: FactorySession = {
      aborted: false,
      chatId: request.chatId,
      cleanup,
      finalized: false,
      id: '',
      isRunning: true,
      process: null,
      resultSeen: false,
      sessionCreatedEmitted: false,
      startTime: Date.now(),
      lastActivityAt: Date.now(),
      startedSession,
      turnResolve: null,
    };

    this.emitProcessing(request.chatId, true);
    try {
      this.#spawnFactory(session, args, prompt, request.projectPath, shouldAirgapFactoryInvocation(request.model, { resume: false }));
      return await startedSession.promise;
    } catch (error) {
      this.emitProcessing(request.chatId, false);
      if (cleanup) await cleanup();
      throw error;
    }
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const existingSession = this.#runningSessions.get(request.agentSessionId);
    if (existingSession?.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }

    const modelMetadata = request.model ? await getFactoryModelMetadata(request.model) : null;
    const reasoningEffort = mapFactoryReasoningEffort(request.thinkingMode, modelMetadata?.reasoningEfforts);
    const supportsImages = modelMetadata?.supportsImages ?? inferFactoryModelSupportsImages(request.model);
    const args = buildFactoryArgs(request, reasoningEffort);
    const { cleanup, prompt } = await buildFactoryPrompt(request.command, request.images, supportsImages, request.permissionMode);
    const session: FactorySession = existingSession ?? {
      aborted: false,
      chatId: request.chatId,
      finalized: false,
      id: request.agentSessionId,
      isRunning: true,
      process: null,
      resultSeen: false,
      sessionCreatedEmitted: true,
      startTime: Date.now(),
      lastActivityAt: Date.now(),
      startedSession: null,
      turnResolve: null,
    };
    session.aborted = false;
    session.chatId = request.chatId;
    session.cleanup = cleanup;
    session.finalized = false;
    session.id = request.agentSessionId;
    session.isRunning = true;
    session.process = null;
    session.resultSeen = false;
    session.startTime = Date.now();
    session.lastActivityAt = Date.now();
    this.#runningSessions.set(session.id, session);

    this.emitProcessing(request.chatId, true);
    try {
      this.#spawnFactory(session, args, prompt, request.projectPath, shouldAirgapFactoryInvocation(request.model, { resume: true }));
      await this.#waitForTurnComplete(session);
    } catch (error) {
      if (cleanup) await cleanup();
      throw error;
    }
  }

  abort(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session?.process) return false;
    session.aborted = true;
    session.process.kill();
    this.#finalizeTurn(session, 143);
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#runningSessions.get(agentSessionId)?.isRunning === true;
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
      this.#finalizeTurn(session, 143);
    }
    this.#runningSessions.clear();
  }
}

import { promises as fs } from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { getPiBinary } from "../../config.js";
import {
  ErrorMessage,
  ToolResultMessage,
} from "../../../common/chat-types.js";
import { normalizeToolResultContent }  from "../shared/normalize-util.js";
import { convertPiMessage } from "./message-converter.js";
import { convertPiToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import { createArtificialNativePath, isArtificialNativePath } from "../../chats/artificial-native-path.js";
import {
  findPiSessionFileBySessionId,
  piSessionPathFromHeader,
  resolvePiConfiguredSessionDir,
} from './pi-session-paths.js';
import { getPiModels } from './pi-models.js';
import { createLogger } from '../../lib/log.js';

const logger = createLogger('agents:pi:pi-cli');
import type {
  AgentCommandImage,
  PermissionMode,
  ResumeTurnRequest,
  StartSessionRequest,
  StartedAgentSession,
  ThinkingMode,
} from "../session-types.js";

interface PiSessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface PiSession {
  aborted: boolean;
  chatId: string;
  cleanup?: (() => Promise<void>) | undefined;
  configuredSessionDir?: string | undefined;
  finalized: boolean;
  id: string;
  isRunning: boolean;
  nativePath: string | null;
  process: ReturnType<typeof Bun.spawn> | null;
  resultSeen: boolean;
  sessionCreatedEmitted: boolean;
  startTime: number;
  startedSession: {
    promise: Promise<StartedAgentSession>;
    reject: (error: unknown) => void;
    resolve: (value: StartedAgentSession) => void;
    resolved: boolean;
  } | null;
  turnResolve: (() => void) | null;
}

interface BuildPiPromptResult {
  args: string[];
  cleanup?: () => Promise<void>;
  configuredSessionDir?: string;
  prompt: string;
}

type PiCliEvent = Record<string, unknown> & { type?: string };

const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
const GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV = 'GARCON_EMBEDDED_PI_PACKAGE_DIR';
const PI_PLAN_PREFIX = [
  'You are operating in Garcon plan mode.',
  'Do not modify files, run mutating commands, or carry out implementation.',
  'Analyze the task, inspect the codebase, and respond with a concrete implementation plan only.',
].join('\n');

function mapThinkingMode(mode: ThinkingMode): string | undefined {
  switch (mode) {
    case 'none':
      return 'off';
    case 'think':
      return 'low';
    case 'think-hard':
      return 'medium';
    case 'think-harder':
      return 'high';
    case 'ultrathink':
      return 'xhigh';
    default:
      return undefined;
  }
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  return '.png';
}

function parseImageData(data: string): { buffer: Buffer; extension: string } | null {
  const match = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    buffer: Buffer.from(match[2], 'base64'),
    extension: extensionForMimeType(match[1]),
  };
}

async function writeImagesToTempFiles(images: AgentCommandImage[] | undefined): Promise<{
  cleanup?: () => Promise<void>;
  fileArgs: string[];
}> {
  if (!images?.length) return { fileArgs: [] };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-pi-images-'));
  const fileArgs: string[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const parsed = parseImageData(images[index].data);
    if (!parsed) continue;
    const safeStem = images[index].name
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 80) || `image-${index + 1}`;
    const filePath = path.join(tempDir, `${safeStem}${parsed.extension}`);
    await fs.writeFile(filePath, parsed.buffer);
    fileArgs.push(`@${filePath}`);
  }

  return {
    cleanup: async () => {
      await fs.rm(tempDir, { force: true, recursive: true }).catch(() => { });
    },
    fileArgs,
  };
}

function buildPrompt(command: string, permissionMode: PermissionMode, hasImages: boolean): string {
  const basePrompt = command.trim() || (hasImages ? 'Please inspect the attached image.' : '');
  if (permissionMode !== 'plan') return basePrompt;
  return `${PI_PLAN_PREFIX}\n\n${basePrompt}`;
}

function requireExplicitPiModel(model: unknown): string {
  const normalized = typeof model === 'string' ? model.trim() : '';
  if (!normalized || normalized === 'default') {
    throw new Error('Pi requires an explicit model selection.');
  }
  return normalized;
}

function buildPiCliEnv(envOverrides?: Record<string, string>): Record<string, string | undefined> {
  const env = { ...process.env, ...envOverrides };
  const embeddedPackageDir = env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV];
  if (embeddedPackageDir && env.PI_PACKAGE_DIR === embeddedPackageDir) {
    // Keeps Garcon's executable-only SDK metadata override out of the external Pi CLI.
    delete env.PI_PACKAGE_DIR;
  }
  delete env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV];
  return env;
}

async function resolveSessionArgument(request: ResumeTurnRequest): Promise<string> {
  if (request.nativePath && !isArtificialNativePath(request.nativePath)) {
    try {
      await fs.access(request.nativePath);
      return request.nativePath;
    } catch {
      // Falls through to session id lookup.
    }
  }

  const sessionPath = await findPiSessionFileBySessionId(request.agentSessionId, request.projectPath);
  return sessionPath || request.agentSessionId;
}

async function buildPiRun(
  request: StartSessionRequest | ResumeTurnRequest,
): Promise<BuildPiPromptResult> {
  const args = ['--mode', 'json'];
  const configuredSessionDir = resolvePiConfiguredSessionDir(request.projectPath);
  const thinking = mapThinkingMode(request.thinkingMode);
  const model = requireExplicitPiModel(request.model);
  const { cleanup, fileArgs } = await writeImagesToTempFiles(request.images);
  const prompt = buildPrompt(request.command, request.permissionMode, fileArgs.length > 0);

  args.push('--model', model);
  if (thinking) {
    args.push('--thinking', thinking);
  }
  if (request.permissionMode === 'plan') {
    args.push('--tools', PI_READ_ONLY_TOOLS.join(','));
  }
  if (configuredSessionDir) {
    args.push('--session-dir', configuredSessionDir);
  }
  if ('agentSessionId' in request) {
    args.push('--session', await resolveSessionArgument(request));
  }
  args.push(...fileArgs);

  return { args, cleanup, configuredSessionDir, prompt };
}

async function runPiCommand(
  args: string[],
  { cwd, input }: { cwd?: string; input?: string } = {},
): Promise<string> {
  const proc = Bun.spawn([getPiBinary(), ...args], {
    cwd: cwd || process.cwd(),
    env: buildPiCliEnv(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (input != null) {
    const stdin = proc.stdin as unknown as { end(): void; write(chunk: string): void };
    stdin.write(input);
    stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Pi command failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }
  return stdout;
}

export async function runSingleQuery(prompt: string, options: Record<string, unknown> = {}): Promise<string> {
  const model = requireExplicitPiModel(options.model);
  const cwd = typeof options.cwd === 'string'
    ? options.cwd
    : typeof options.projectPath === 'string'
      ? options.projectPath
      : process.cwd();
  const args = ['--mode', 'text', '--no-session', '--no-tools'];
  args.push('--model', model);
  return (await runPiCommand(args, { cwd, input: prompt })).trim();
}

function createSession(chatId: string, startedSession: PiSession['startedSession'] = null): PiSession {
  return {
    aborted: false,
    chatId,
    finalized: false,
    id: `pending-${crypto.randomUUID()}`,
    isRunning: true,
    nativePath: null,
    process: null,
    resultSeen: false,
    sessionCreatedEmitted: false,
    startTime: Date.now(),
    startedSession,
    turnResolve: null,
  };
}

function createStartTracker(): PiSession['startedSession'] & { promise: Promise<StartedAgentSession> } {
  let resolveRef: ((value: StartedAgentSession) => void) | null = null;
  let rejectRef: ((error: unknown) => void) | null = null;
  const promise = new Promise<StartedAgentSession>((resolve, reject) => {
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

export class PiCliRuntime extends AgentEventEmitterRuntime {
  #runningSessions = new Map<string, PiSession>();
  #purgeTimer: ReturnType<typeof setInterval> | null = null;

  async getModels(): Promise<Array<{ value: string; label: string; supportsImages?: boolean }>> {
    return getPiModels();
  }

  #emitSessionCreated(session: PiSession): void {
    if (session.sessionCreatedEmitted) return;
    session.sessionCreatedEmitted = true;
    this.emitSessionCreated(session.chatId);
  }

  #activateSession(session: PiSession, header: PiSessionHeader): void {
    const previousId = session.id;
    session.id = header.id;
    session.nativePath = header.timestamp && header.cwd
      ? piSessionPathFromHeader(header, session.configuredSessionDir)
      : createArtificialNativePath('pi', header.id);

    if (previousId !== header.id) {
      this.#runningSessions.delete(previousId);
      this.#runningSessions.set(header.id, session);
    }

    this.#emitSessionCreated(session);

    const tracker = session.startedSession;
    if (tracker && !tracker.resolved) {
      tracker.resolved = true;
      tracker.resolve({
        agentSessionId: header.id,
        nativePath: session.nativePath,
      });
    }
  }

  #routeEvent(session: PiSession, event: PiCliEvent): void {
    const timestamp = new Date().toISOString();

    if (event.type === 'session' && typeof event.id === 'string') {
      this.#activateSession(session, event as unknown as PiSessionHeader);
      return;
    }

    if (event.type === 'message_end') {
      const message = event.message as unknown;
      const messages = convertPiMessage(message, {
        includeToolCalls: false,
        includeToolResults: false,
        includeUser: false,
      });
      if (messages.length > 0) this.emitMessages(session.chatId, messages);

      const stopReason = message && typeof message === 'object'
        ? (message as Record<string, unknown>).stopReason
        : null;
      if (stopReason === 'error') {
        const errorMessage = message && typeof message === 'object'
          ? (message as Record<string, unknown>).errorMessage
          : null;
        this.emitMessages(session.chatId, [
          new ErrorMessage(timestamp, typeof errorMessage === 'string' ? errorMessage : 'Pi turn failed.'),
        ]);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      this.emitMessages(session.chatId, [
        convertPiToolUse(
          timestamp,
          typeof event.toolCallId === 'string' ? event.toolCallId : '',
          typeof event.toolName === 'string' ? event.toolName : 'Unknown',
          event.args,
        ),
      ]);
      return;
    }

    if (event.type === 'tool_execution_end') {
      const result = event.result && typeof event.result === 'object'
        ? event.result as Record<string, unknown>
        : event.result;
      this.emitMessages(session.chatId, [
        new ToolResultMessage(
          timestamp,
          typeof event.toolCallId === 'string' ? event.toolCallId : '',
          normalizeToolResultContent(
            result && typeof result === 'object' && 'content' in result
              ? (result as Record<string, unknown>).content
              : result,
          ),
          Boolean(event.isError),
        ),
      ]);
      return;
    }

    if (event.type === 'agent_end') {
      session.resultSeen = true;
      this.emitFinished(session.chatId, 0);
      this.#finalizeTurn(session, 0);
    }
  }

  #parseStdoutLine(session: PiSession, line: string): void {
    if (!line.trim()) return;
    try {
      this.#routeEvent(session, JSON.parse(line) as PiCliEvent);
    } catch {
      logger.warn(`pi(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
    }
  }

  async #readStdout(session: PiSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
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
        for (const line of lines) {
          this.#parseStdoutLine(session, line);
        }
      }
      buffer += decoder.decode();
      this.#parseStdoutLine(session, buffer);
    } catch (error) {
      if (!proc.killed) {
        logger.error(`pi(${session.id.slice(0, 8)}): stdout read error:`, (error as Error).message);
      }
    } finally {
      const exitCode = await proc.exited;
      if (session.process === proc) session.process = null;
      this.#finalizeTurn(session, exitCode);
    }
  }

  async #pipeStderr(session: PiSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr) return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) logger.info(`pi(${session.id.slice(0, 8)}): stderr: ${line}`);
        }
      }
    } catch {
      // Stream closed.
    }
  }

  #finalizeTurn(session: PiSession, exitCode?: number): void {
    if (session.finalized) return;
    session.finalized = true;

    const wasRunning = session.isRunning;
    session.isRunning = false;
    if (wasRunning) this.emitProcessing(session.chatId, false);

    if (session.startedSession && !session.startedSession.resolved) {
      session.startedSession.resolved = true;
      session.startedSession.reject(
        new Error(`Pi process exited before session header${exitCode != null ? ` (code ${exitCode})` : ''}`),
      );
    } else if (!session.resultSeen && !session.aborted) {
      this.emitFailed(
        session.chatId,
        `Pi process exited before completion${exitCode != null ? ` (code ${exitCode})` : ''}`,
      );
    }

    if (session.cleanup) {
      void session.cleanup().catch(() => { });
      session.cleanup = undefined;
    }

    if (session.id && !session.isRunning) {
      this.#runningSessions.delete(session.id);
    }

    const resolve = session.turnResolve;
    session.turnResolve = null;
    resolve?.();
  }

  #spawnPi(
    session: PiSession,
    request: StartSessionRequest | ResumeTurnRequest,
    run: BuildPiPromptResult,
  ): ReturnType<typeof Bun.spawn> {
    const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
      cwd: request.projectPath,
      env: buildPiCliEnv(request.envOverrides),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    };

    const proc = Bun.spawn([getPiBinary(), ...run.args], spawnOptions);
    const stdin = proc.stdin as unknown as { end(): void; write(chunk: string): void };
    stdin.write(run.prompt);
    stdin.end();

    session.process = proc;
    session.cleanup = run.cleanup;
    session.configuredSessionDir = run.configuredSessionDir;
    void this.#readStdout(session, proc);
    void this.#pipeStderr(session, proc);

    return proc;
  }

  #waitForTurnComplete(session: PiSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();
    return new Promise((resolve) => {
      session.turnResolve = resolve;
    });
  }

  #resetSessionForTurn(session: PiSession, chatId: string): void {
    session.aborted = false;
    session.chatId = chatId;
    session.cleanup = undefined;
    session.configuredSessionDir = undefined;
    session.finalized = false;
    session.isRunning = true;
    session.process = null;
    session.resultSeen = false;
    session.startTime = Date.now();
    session.startedSession = null;
    session.turnResolve = null;
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const startedSession = createStartTracker();
    const session = createSession(request.chatId, startedSession);
    this.#runningSessions.set(session.id, session);
    this.emitProcessing(request.chatId, true);

    try {
      const run = await buildPiRun(request);
      this.#spawnPi(session, request, run);
      return await startedSession.promise;
    } catch (error) {
      this.#runningSessions.delete(session.id);
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(request.chatId, false);
      }
      if (session.cleanup) {
        await session.cleanup().catch(() => { });
        session.cleanup = undefined;
      }
      throw error;
    }
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    const existingSession = this.#runningSessions.get(request.agentSessionId);
    if (existingSession?.isRunning) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }

    const session = existingSession ?? {
      ...createSession(request.chatId),
      id: request.agentSessionId,
      nativePath: request.nativePath ?? null,
      sessionCreatedEmitted: true,
    };
    this.#resetSessionForTurn(session, request.chatId);
    session.id = request.agentSessionId;
    session.nativePath = request.nativePath ?? session.nativePath;
    session.sessionCreatedEmitted = true;
    this.#runningSessions.set(session.id, session);

    this.emitProcessing(request.chatId, true);

    try {
      const run = await buildPiRun(request);
      this.#spawnPi(session, request, run);
      await this.#waitForTurnComplete(session);
    } catch (error) {
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(request.chatId, false);
      }
      if (session.cleanup) {
        await session.cleanup().catch(() => { });
        session.cleanup = undefined;
      }
      this.#runningSessions.delete(session.id);
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
    if (this.#purgeTimer) return;
    const maxAge = 30 * 60 * 1000;
    this.#purgeTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.#runningSessions.entries()) {
        if (!session.isRunning && now - session.startTime > maxAge) {
          this.#runningSessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  shutdown(): void {
    if (this.#purgeTimer) {
      clearInterval(this.#purgeTimer);
      this.#purgeTimer = null;
    }
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

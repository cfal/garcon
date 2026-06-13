// Claude CLI transport. Spawns the `claude` binary with stdin/stdout
// pipes, exchanging JSONL messages. Extends AgentEventEmitterRuntime so all output
// flows through typed events wired in the composition root.

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { normalizeToolResultContent }  from "../shared/normalize-util.js";
import { getClaudeBinary } from "../../config.js";
import { AssistantMessage, ThinkingMessage, ToolResultMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from "../../../common/chat-types.js";
import { convertClaudePermissionTool } from "./permission-tool-converter.js";
import { convertClaudeToolUse } from "./tool-use-converter.js";
import { AgentEventEmitterRuntime } from "../shared/event-emitter-runtime.js";
import type { ClaudeThinkingMode, PermissionMode, ThinkingMode } from "../../../common/chat-modes.js";
import type { ClaudeStartSessionRequest, ResumeTurnRequest } from "../session-types.js";
import type { AgentCommandImage } from "../../../common/ws-requests.js";
import { createLogger } from '../../lib/log.js';
import { errorMessage } from '../../lib/errors.js';

const logger = createLogger('agents:claude:claude-cli');

interface CLIMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  content?: unknown[];
  message?: { role?: string; content?: unknown[] };
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
  };
  response?: {
    subtype?: string;
    request_id?: string;
    error?: string;
    response?: unknown;
  };
}

interface ClaudeContentPart {
  type?: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

interface ClaudeSessionOptions {
  agentSessionId: string;
  sessionId: string;
  chatId: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  images?: AgentCommandImage[];
  envOverrides?: Record<string, string>;
}

interface ClaudeRunningSession {
  id: string;
  chatId: string;
  isRunning: boolean;
  turnResolve: ((value: void | PromiseLike<void>) => void) | null;
  startTime: number;
  process: ReturnType<typeof Bun.spawn> | null;
  options: ClaudeSessionOptions;
  currentPermissionMode: PermissionMode;
  currentThinkingMode: ThinkingMode;
  currentClaudeThinkingMode: ClaudeThinkingMode;
  currentModel: string;
  currentEnvOverrides?: Record<string, string>;
}

interface PendingPermission {
  cliRequestId: string;
  agentSessionId: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface PendingControlRequest {
  resolve: (value: unknown) => void;
}

interface ClaudeCLIArgOptions {
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  prompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  streamJson?: boolean;
}

interface ClaudeSingleQueryOptions {
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  envOverrides?: Record<string, string>;
}

// Builds the permission approval/deny response sent back to the CLI.
function buildClaudePermissionApprovalResponse(
  pending: Pick<PendingPermission, 'toolName' | 'toolInput'> & { providerToolName?: string; providerToolInput?: Record<string, unknown> },
  decision: { allow: boolean; alwaysAllow?: boolean },
): Record<string, unknown> {
  if (!decision.allow) {
    return { behavior: 'deny', message: 'Denied by user' };
  }
  const toolInput = pending.providerToolInput ?? pending.toolInput ?? {};
  const toolName = pending.providerToolName ?? pending.toolName;
  const response: Record<string, unknown> = {
    behavior: 'allow',
    updatedInput: toolInput,
  };
  if (decision.alwaysAllow) {
    response.updatedPermissions = [{
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    }];
  }
  return response;
}

// Builds the Claude session file path from the canonicalized project path.
async function createClaudeNativePath(projectPath: string, agentSessionId: string): Promise<string | null> {
  if (!projectPath || !agentSessionId) return null;
  const canonicalProjectPath = await fs.realpath(projectPath);
  const projectName = canonicalProjectPath.replace(/[\\/:\s~_]/g, '-');
  if (!projectName) return null;
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    projectName,
    `${agentSessionId}.jsonl`,
  );
}

// Converts a finalized CLI assistant message to ChatMessage objects.
function convertCLIMessageToChatMessages(msg: CLIMessage): unknown[] {
  if (msg.type !== 'assistant') return [];

  const chatMessages: unknown[] = [];
  const now = new Date().toISOString();
  const content: ClaudeContentPart[] =
    Array.isArray(msg.content) ? msg.content
      : Array.isArray(msg.message?.content) ? msg.message!.content!
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

// Runs a one-shot CLI query and returns the plain text output.
async function runSingleQuery(
  prompt: string,
  { model, cwd, permissionMode, thinkingMode, claudeThinkingMode, envOverrides }: ClaudeSingleQueryOptions = {},
): Promise<string> {
  const claudeBinary = getClaudeBinary();
  const args = buildClaudeCLIArgs({ model, permissionMode, thinkingMode, claudeThinkingMode, prompt });

  const proc = Bun.spawn([claudeBinary, ...args], {
    cwd: cwd || process.cwd(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: (() => { const { CLAUDECODE, ...env } = process.env; return { ...env, ...envOverrides }; })(),
  });

  const chunks: Uint8Array[] = [];
  const reader = proc.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch (err: unknown) {
    logger.error('cli: one-shot stdout read error:', errorMessage(err));
  }

  await proc.exited;

  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

function mapThinkingModeToClaudeEffort(thinkingMode: ThinkingMode | undefined): string | undefined {
  switch (thinkingMode) {
    case 'think':
      return 'low';
    case 'think-hard':
      return 'medium';
    case 'think-harder':
    case 'ultrathink':
      return 'high';
    default:
      return undefined;
  }
}

function mapClaudeThinkingModeToCliValue(claudeThinkingMode: ClaudeThinkingMode | undefined): string | undefined {
  switch (claudeThinkingMode) {
    case 'auto':
      return 'adaptive';
    case 'on':
      return 'enabled';
    case 'off':
      return 'disabled';
    default:
      return undefined;
  }
}

function buildClaudeCLIArgs({
  model,
  permissionMode,
  thinkingMode,
  claudeThinkingMode,
  prompt = '',
  sessionId,
  resumeSessionId,
  streamJson = false,
}: ClaudeCLIArgOptions): string[] {
  const args = streamJson
    ? ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
    : ['--print', '--no-session-persistence'];

  if (model) args.push('--model', model);

  const effectiveMode = permissionMode || 'default';
  if (effectiveMode !== 'default') {
    if (effectiveMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', effectiveMode);
    }
  }

  if (effectiveMode !== 'bypassPermissions' && streamJson) {
    args.push('--permission-prompt-tool', 'stdio');
  }

  const effort = mapThinkingModeToClaudeEffort(thinkingMode);
  if (effort) {
    args.push('--effort', effort);
  }

  const mappedClaudeThinkingMode = mapClaudeThinkingModeToCliValue(claudeThinkingMode);
  if (mappedClaudeThinkingMode) {
    args.push('--thinking', mappedClaudeThinkingMode);
  }

  if (streamJson) {
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }
  }

  args.push('-p', prompt);
  return args;
}

class ClaudeCliRuntime extends AgentEventEmitterRuntime {
  #runningSessions = new Map<string, ClaudeRunningSession>();
  #pendingPermissions = new Map<string, PendingPermission>();
  #pendingControlRequests = new Map<string, PendingControlRequest>();
  #purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
  }

  /** Shallow comparison of env override maps; treats undefined and {} as equal. */
  #envOverridesChanged(a?: Record<string, string>, b?: Record<string, string>): boolean {
    const keysA = Object.keys(a ?? {});
    const keysB = Object.keys(b ?? {});
    if (keysA.length !== keysB.length) return true;
    for (const k of keysA) {
      if (a![k] !== b?.[k]) return true;
    }
    return false;
  }

  #sendToCLI(sessionId: string, jsonl: string): void {
    const session = this.#runningSessions.get(sessionId);
    if (!session?.process) return;
    const stdin = session.process.stdin as import('bun').FileSink;
    if (!stdin?.write) return;
    try {
      stdin.write(jsonl + '\n');
      stdin.flush();
    } catch (err: unknown) {
      logger.warn(`cli(${sessionId.slice(0, 8)}): stdin write failed:`, errorMessage(err));
    }
  }

  #routeCLIMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    switch (msg.type) {
      case 'system':
        this.#handleSystemMessage(session, msg);
        break;

      case 'assistant': {
        const chatMessages = convertCLIMessageToChatMessages(msg);
        if (chatMessages.length > 0) {
          this.emitMessages(session.chatId, chatMessages);
        }
        break;
      }

      case 'stream_event':
        break;

      case 'result':
        this.#handleResultMessage(session, msg);
        break;

      case 'control_request':
        this.#handleControlRequest(session, msg);
        break;

      case 'control_response':
        this.#handleControlResponse(session, msg);
        break;

      case 'tool_progress':
      case 'tool_use_summary':
      case 'auth_status':
      case 'keep_alive':
      case 'user':
        break;

      default:
        logger.info('claude: unrecognized message type:', msg.type);
        break;
    }
  }

  #handleSystemMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    if (msg.subtype === 'init') {
      logger.info(`cli(${session.id.slice(0, 8)}): session initialized (msg.session_id=${msg.session_id}, msg.model=${msg.model})`);
      if (session.id !== msg.session_id) {
        throw new Error('Unexpected session ID');
      }
    }
  }

  #handleResultMessage(session: ClaudeRunningSession, msg: CLIMessage): void {
    session.isRunning = false;
    this.emitProcessing(session.chatId, false);
    this.emitFinished(session.chatId, msg.is_error ? 1 : 0);
    if (session.turnResolve) {
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve();
    }
  }

  #emitPermissionMessages(chatId: string, messages: unknown[]): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages);
  }

  #handleControlRequest(session: ClaudeRunningSession, msg: CLIMessage): void {
    if (msg.request?.subtype !== 'can_use_tool') return;

    const permissionRequestId = `claude-${crypto.randomBytes(8).toString('hex')}`;
    const toolName = msg.request.tool_name || 'Unknown';

    this.#pendingPermissions.set(permissionRequestId, {
      cliRequestId: msg.request_id!,
      agentSessionId: session.id,
      chatId: session.chatId,
      toolName,
      toolInput: msg.request.input || {},
    });

    const now = new Date().toISOString();
    this.#emitPermissionMessages(session.chatId, [
      new PermissionRequestMessage(
        now,
        permissionRequestId,
        convertClaudePermissionTool(now, permissionRequestId, toolName, msg.request.input),
      ),
    ]);
  }

  #handleControlResponse(session: ClaudeRunningSession, msg: CLIMessage): void {
    const reqId = msg.response?.request_id;
    if (!reqId) return;
    const pending = this.#pendingControlRequests.get(reqId);
    if (!pending) return;
    this.#pendingControlRequests.delete(reqId);

    if (msg.response!.subtype === 'error') {
      logger.warn(`cli: control request failed: ${msg.response!.error}`);
      return;
    }
    pending.resolve(msg.response!.response ?? {});
  }

  #killSessionProcess(session: ClaudeRunningSession): void {
    const proc = session.process;
    if (!proc) return;
    session.process = null;
    if (!proc.killed) {
      proc.kill();
    }
  }

  setInternalPermissionMode(agentSessionId: string, mode: PermissionMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.currentPermissionMode = mode;
    session.options = { ...session.options, permissionMode: mode };

    if (session.process) {
      const requestId = crypto.randomUUID();
      this.#sendToCLI(agentSessionId, JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode },
      }));
    }
  }

  setInternalThinkingMode(agentSessionId: string, mode: ThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, thinkingMode: mode };

    if (session.process && !session.isRunning) {
      this.#killSessionProcess(session);
    }
  }

  setInternalClaudeThinkingMode(agentSessionId: string, mode: ClaudeThinkingMode): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session) return;

    session.options = { ...session.options, claudeThinkingMode: mode };

    if (session.process && !session.isRunning) {
      this.#killSessionProcess(session);
    }
  }

  resolveInternalToolApproval(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
    const pending = this.#pendingPermissions.get(permissionRequestId);
    if (!pending) {
      logger.warn('cli: resolveInternalToolApproval, no pending entry for', permissionRequestId, '(already resolved or cancelled)');
      return;
    }
    this.#pendingPermissions.delete(permissionRequestId);

    const response = buildClaudePermissionApprovalResponse(pending, decision);

    this.#sendToCLI(pending.agentSessionId, JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.cliRequestId,
        response,
      },
    }));

    this.#emitPermissionMessages(pending.chatId, [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow))]);
  }

  #sendUserMessage(session: ClaudeRunningSession, command: string, images?: AgentCommandImage[]): void {
    let content: unknown;
    if (images?.length) {
      const blocks: unknown[] = [];
      for (const img of images) {
        const matches = img.data?.match?.(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: matches[1], data: matches[2] },
          });
        }
      }
      blocks.push({ type: 'text', text: command });
      content = blocks;
    } else {
      content = command;
    }

    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.id || '',
    });

    this.#sendToCLI(session.id, jsonl);
  }

  #waitForTurnComplete(session: ClaudeRunningSession): Promise<void> {
    if (!session.isRunning) return Promise.resolve();

    return new Promise<void>(resolve => {
      session.turnResolve = resolve;
    });
  }

  #buildCLIArgs(session: ClaudeRunningSession, options: ClaudeSessionOptions, resume: boolean = false): string[] {
    return buildClaudeCLIArgs({
      model: options.model,
      permissionMode: options.permissionMode,
      thinkingMode: options.thinkingMode,
      claudeThinkingMode: options.claudeThinkingMode,
      prompt: '',
      streamJson: true,
      sessionId: resume ? undefined : session.id,
      resumeSessionId: resume ? session.id : undefined,
    });
  }

  async #readStdout(session: ClaudeRunningSession, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stdout || typeof proc.stdout === 'number') return;
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
          let msg: CLIMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            logger.warn(`cli(${session.id.slice(0, 8)}): bad JSON: ${line.slice(0, 120)}`);
            continue;
          }
          this.#routeCLIMessage(session, msg);
        }
      }
    } catch (err: unknown) {
      if (!proc.killed) {
        logger.error(`cli(${session.id.slice(0, 8)}): stdout read error:`, errorMessage(err));
      }
    }
  }

  #handleProcessExit(session: ClaudeRunningSession, proc: ReturnType<typeof Bun.spawn>, exitCode: number): void {
    if (session.process !== proc) {
      return;
    }

    session.process = null;

    for (const [permissionRequestId, pending] of this.#pendingPermissions) {
      if (pending.agentSessionId === session.id) {
        this.#emitPermissionMessages(pending.chatId, [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, 'cancelled')]);
        this.#pendingPermissions.delete(permissionRequestId);
      }
    }

    if (session.turnResolve || session.isRunning) {
      const wasRunning = session.isRunning;
      session.isRunning = false;
      this.emitProcessing(session.chatId, false);
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve?.();
      if (wasRunning) {
        this.emitFailed(session.chatId, `CLI process exited with code ${exitCode}`);
      }
    }
  }

  async #pipeStderr(sessionId: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === 'number') return;
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split('\n')) {
          if (line.trim()) {
            logger.info(`cli(${sessionId.slice(0, 8)}): stderr: ${line}`);
          }
        }
      }
    } catch { /* stream closed */ }
  }

  #spawnCLI(session: ClaudeRunningSession, options: ClaudeSessionOptions, resume: boolean): ReturnType<typeof Bun.spawn> {
    const claudeBinary = getClaudeBinary();
    const args = this.#buildCLIArgs(session, options, resume);

    logger.info(`cli: spawning: ${claudeBinary} ${args.join(' ')}`);

    const proc = Bun.spawn([claudeBinary, ...args], {
      cwd: options.projectPath,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: (() => { const { CLAUDECODE, ...env } = process.env; return { ...env, ...options.envOverrides }; })(),
    });

    session.options = options;
    session.process = proc;
    session.currentThinkingMode = options.thinkingMode || 'none';
    session.currentClaudeThinkingMode = options.claudeThinkingMode || 'auto';
    session.currentModel = options.model || '';
    session.currentEnvOverrides = options.envOverrides;
    this.#readStdout(session, proc);
    this.#pipeStderr(session.id, proc);

    proc.exited.then((exitCode: number) => {
      logger.info(`cli(${session.id.slice(0, 8)}): process exited (code=${exitCode})`);
      this.#handleProcessExit(session, proc, exitCode);
    });

    return proc;
  }

  async startClaudeCliSession({
    command,
    agentSessionId,
    chatId,
    images,
    model,
    permissionMode,
    projectPath,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
  }: ClaudeStartSessionRequest): Promise<string> {
    if (!chatId) throw new Error('chatId is required when starting a Claude session');
    if (!agentSessionId) throw new Error('agentSessionId is required when starting a Claude session');

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
    };

    const session: ClaudeRunningSession = {
      id: agentSessionId,
      chatId,
      isRunning: true,
      turnResolve: null,
      startTime: Date.now(),
      process: null,
      options: allOpts,
      currentPermissionMode: permissionMode || 'default',
      currentThinkingMode: thinkingMode || 'none',
      currentClaudeThinkingMode: claudeThinkingMode || 'auto',
      currentModel: model || '',
      currentEnvOverrides: envOverrides,
    };
    this.#runningSessions.set(agentSessionId, session);
    this.emitProcessing(chatId, true);

    this.emitSessionCreated(chatId);

    this.#spawnCLI(session, allOpts, false);

    this.#sendUserMessage(session, command, images);

    await this.#waitForTurnComplete(session);
    return agentSessionId;
  }

  async runClaudeTurn({
    command,
    agentSessionId,
    chatId,
    images,
    model,
    permissionMode,
    projectPath,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
  }: ResumeTurnRequest): Promise<void> {
    if (!agentSessionId) {
      throw new Error('Cannot resume without session ID');
    }
    if (!chatId) {
      throw new Error('Cannot resume without chat ID');
    }

    const allOpts: ClaudeSessionOptions = {
      agentSessionId,
      sessionId: agentSessionId,
      chatId,
      images,
      model,
      permissionMode,
      projectPath,
      thinkingMode,
      claudeThinkingMode,
      envOverrides,
    };

    let session = this.#runningSessions.get(agentSessionId);
    if (!session) {
      session = {
        id: agentSessionId,
        chatId: chatId,
        isRunning: false,
        turnResolve: null,
        startTime: Date.now(),
        process: null,
        options: allOpts,
        currentPermissionMode: permissionMode || 'default',
        currentThinkingMode: thinkingMode || 'none',
        currentClaudeThinkingMode: claudeThinkingMode || 'auto',
        currentModel: model || '',
        currentEnvOverrides: envOverrides,
      };
      this.#runningSessions.set(agentSessionId, session);
    } else {
      if (chatId !== session.chatId) {
        throw new Error('Chat ID mismatch');
      }
    }

    session.options = { ...session.options, ...allOpts };

    const effectiveChatId = chatId || session.chatId;
    session.chatId = effectiveChatId;
    session.isRunning = true;
    this.emitProcessing(effectiveChatId, true);

    const desiredThinkingMode = session.options.thinkingMode || 'none';
    const desiredClaudeThinkingMode = session.options.claudeThinkingMode || 'auto';
    const desiredModel = session.options.model || '';
    const previousModel = session.process ? (session.currentModel || '') : '';
    const envChanged = this.#envOverridesChanged(session.currentEnvOverrides, session.options.envOverrides);
    if (session.process && (
      desiredThinkingMode !== session.currentThinkingMode
      || desiredClaudeThinkingMode !== session.currentClaudeThinkingMode
      || desiredModel !== previousModel
      || envChanged
    )) {
      this.#killSessionProcess(session);
    }

    if (!session.process) {
      const spawnOpts: ClaudeSessionOptions = {
        agentSessionId,
        sessionId: agentSessionId,
        chatId: effectiveChatId,
        images: allOpts.images ?? session.options?.images,
        model: allOpts.model ?? session.options?.model,
        permissionMode: allOpts.permissionMode ?? session.options?.permissionMode,
        projectPath: allOpts.projectPath ?? session.options?.projectPath,
        thinkingMode: allOpts.thinkingMode ?? session.options?.thinkingMode,
        claudeThinkingMode: allOpts.claudeThinkingMode ?? session.options?.claudeThinkingMode,
        envOverrides: allOpts.envOverrides ?? session.options?.envOverrides,
      };
      // Always resume: the session file preserves conversation context.
      // Cross-boundary local/cloud switches are blocked by
      // AgentRegistry.runAgentTurn before reaching here.
      this.#spawnCLI(session, spawnOpts, true);
    }

    const newMode = permissionMode || 'default';
    if (session.currentPermissionMode && newMode !== session.currentPermissionMode) {
      this.setInternalPermissionMode(agentSessionId, newMode);
    }
    session.currentPermissionMode = newMode;

    this.#sendUserMessage(session, command, images);
    await this.#waitForTurnComplete(session);
  }

  async abortClaudeInternalSession(agentSessionId: string): Promise<boolean> {
    const session = this.#runningSessions.get(agentSessionId);
    if (!session?.process) return false;

    this.#sendToCLI(agentSessionId, JSON.stringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    }));

    const proc = session.process;
    setTimeout(() => {
      if (session.process === proc && !proc.killed) {
        logger.warn(`cli(${agentSessionId.slice(0, 8)}): interrupt not acknowledged, force-killing process`);
        proc.kill();
      }
    }, 5000);

    return true;
  }

  failClaudeInternalSession(agentSessionId: string, chatId: string, errorMessage: string): void {
    const session = this.#runningSessions.get(agentSessionId);
    if (session) {
      session.isRunning = false;
      session.process = null;
      if (session.turnResolve) {
        const resolve = session.turnResolve;
        session.turnResolve = null;
        resolve();
      }
    }
    this.emitProcessing(chatId, false);
    this.emitFailed(chatId, errorMessage);
  }

  isClaudeInternalSessionRunning(agentSessionId: string): boolean {
    const session = this.#runningSessions.get(agentSessionId);
    return session?.isRunning === true;
  }

  getRunningClaudeInternalSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#runningSessions.entries())
      .filter(([, s]) => s.isRunning)
      .map(([id, s]) => ({
        id,
        status: 'running',
        startedAt: new Date(s.startTime).toISOString(),
      }));
  }

  startPurgeTimer(): void {
    if (this.#purgeTimer) return;
    const maxAge = 30 * 60 * 1000;

    this.#purgeTimer = setInterval(() => {
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

  shutdown(): void {
    if (this.#purgeTimer) {
      clearInterval(this.#purgeTimer);
      this.#purgeTimer = null;
    }
    for (const session of this.#runningSessions.values()) {
      if (session.process && !session.process.killed) {
        session.process.kill();
      }
      if (session.isRunning) {
        session.isRunning = false;
        this.emitProcessing(session.chatId, false);
      }
      const resolve = session.turnResolve;
      session.turnResolve = null;
      resolve?.();
    }
    this.#runningSessions.clear();
    this.#pendingPermissions.clear();
    this.#pendingControlRequests.clear();
  }
}

export { ClaudeCliRuntime, buildClaudeCLIArgs, buildClaudePermissionApprovalResponse, convertCLIMessageToChatMessages, createClaudeNativePath, runSingleQuery };

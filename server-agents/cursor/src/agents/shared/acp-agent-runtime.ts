import crypto from 'node:crypto';
import {
  ErrorMessage,
  UnknownToolUseMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeOperation,
} from '@garcon/server-agent-common/execution/runtime-events';
import { normalizeToolInput } from '@garcon/server-agent-common/shared/normalize-util';
import {
  assertAcpExecutionOpen,
  markAcpExecutionStarted,
  type AcpProjectPathUpdateRequest,
  type AcpResumeRequest,
  type AcpSessionSettingsPatch,
  type AcpStartedSession,
  type AcpStartRequest,
} from './runtime-types.js';
import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { AcpCapabilityCache } from '../../acp/capability-cache.js';
import { AcpClient } from '../../acp/client.js';
import { isRecoverableLoadFailure } from '../../acp/errors.js';
import type {
  AcpInitializeParams,
  AcpJsonRpcId,
  AcpSessionConfigOption,
  AcpSessionRequestPermission,
  AcpSessionUpdateNotification,
} from '../../acp/protocol.js';
import type { AcpAdvertisedCapabilities, ReconnectStrategy } from '../../acp/reconnect-policy.js';
import { reconnectOrder } from '../../acp/reconnect-policy.js';
import { AcpTransport } from '../../acp/transport.js';
import type { AcpEventConverter, AcpSessionUpdateContext } from './acp-event-converter.js';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';
import {
  abortStrategy,
  asObject,
  asString,
  autoApproveOptionId,
  buildEnvFallback,
  buildPromptFallback,
  humanizeError,
  isAutoApproveMode,
  isJsonRpcId,
  permissionCancelledOutcome,
  permissionOptionId,
  permissionOutcome,
} from './acp-runtime-helpers.js';

type RuntimeSessionState = 'idle' | 'running' | 'failed' | 'aborted';

interface PendingPermissionRequest {
  readonly permissionRequestId: string;
  readonly incarnation: string;
  readonly session: AcpAgentRuntimeSession;
  readonly turn: AcpTurnContext;
  readonly requestId: AcpJsonRpcId;
  readonly responseForDecision: (decision: PermissionDecisionPayload) => Record<string, unknown>;
  readonly responseForCancellation: (
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ) => Record<string, unknown>;
}

interface AcpAgentRuntimeSession {
  id: string;
  remoteSessionId: string;
  chatId: string;
  projectPath: string;
  client: AcpClient;
  capabilities: AcpAdvertisedCapabilities;
  state: RuntimeSessionState;
  retired: boolean;
  activeTurn: AcpTurnContext | null;
  sourceTurn: AcpTurnContext | null;
  permissionMode: PermissionMode;
  configOptions?: AcpSessionConfigOption[];
  startedAt: string;
  lastActivityAt: number;
}

interface AcpTurnContext {
  readonly session: AcpAgentRuntimeSession;
  readonly operation: AgentRuntimeOperation;
  readonly pendingPermissions: Set<PendingPermissionRequest>;
  readonly detachSourceListeners: Array<() => void>;
  permissionMode: PermissionMode;
  running: boolean;
  completed: boolean;
  aborted: boolean;
  sourceActive: boolean;
  sourceRetired: boolean;
}

export type AcpAbortStrategy = 'cancel' | 'process-restart';

export interface AcpSessionConfigurationContext {
  client: AcpClient;
  sessionId: string;
  request: AcpStartRequest | AcpResumeRequest;
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpAgentPolicy {
  agentId: string;
  command: string | (() => string);
  args?: string[];
  abortStrategy?: AcpAbortStrategy;
  authenticateMethodId?: string;
  mcpServers?: unknown[];
  binaryVersion?: string;
  reconnectAllowNewSession?: boolean;
  clientCapabilities?: AcpInitializeParams['clientCapabilities'];
  configureSession?: (context: AcpSessionConfigurationContext) => Promise<AcpSessionConfigOption[] | void>;
  newSessionModelConfig?: boolean;
  promptModelConfig?: boolean;
  promptModeConfig?: boolean;
  buildEnv?: (request: AcpStartRequest | AcpResumeRequest) => Record<string, string | undefined>;
  buildPrompt?: (request: AcpStartRequest | AcpResumeRequest) => Array<{ type: string; text?: string; [key: string]: unknown }>;
  mapPermissionMode?: (mode: PermissionMode) => string | undefined;
  mapModel?: (model: string) => string | undefined;
  resolveNativePath?: (sessionId: string) => string | null;
}

export interface AcpAgentRuntimeOptions {
  converter: AcpEventConverter;
  capabilityCache?: AcpCapabilityCache;
  createTransport?: () => AcpTransport;
  logger?: AgentLogger;
}

const SILENT_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class AcpAgentRuntime {
  #policy: AcpAgentPolicy;
  #converter: AcpEventConverter;
  #capabilityCache: AcpCapabilityCache;
  #createTransport: () => AcpTransport;
  #logger: AgentLogger;
  #sessions = new Map<string, AcpAgentRuntimeSession>();
  #pendingPermissions = new Set<PendingPermissionRequest>();
  #idlePurger = new IdleSessionPurger<AcpAgentRuntimeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.activeTurn?.running === true,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (_sessionId, session) => this.#retireSession(session, 'session-complete'),
  });

  constructor(policy: AcpAgentPolicy, options: AcpAgentRuntimeOptions) {
    this.#policy = policy;
    this.#converter = options.converter;
    this.#capabilityCache = options.capabilityCache ?? new AcpCapabilityCache();
    this.#createTransport = options.createTransport ?? (() => new AcpTransport());
    this.#logger = options.logger ?? SILENT_LOGGER;
  }

  async startSession(request: AcpStartRequest): Promise<AcpStartedSession> {
    assertAcpExecutionOpen(request);
    const client = await this.#connectClient(request);
    let created: Awaited<ReturnType<AcpClient['newSession']>>;
    try {
      assertAcpExecutionOpen(request);
      const model = this.#newSessionModelForRequest(request);
      created = await client.newSession({
        cwd: request.projectPath,
        mcpServers: this.#policy.mcpServers,
        ...(model ? { model } : {}),
      });
    } catch (error) {
      client.close();
      throw error;
    }

    const sessionId = created.sessionId;
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      client.close();
      if (existing.chatId !== request.chatId) {
        throw new Error(`ACP session ${sessionId} is already bound to another chat`);
      }
      throw new Error(`ACP session ${sessionId} is already active`);
    }
    const now = new Date().toISOString();
    const capabilities = client.getAdvertisedCapabilities();
    const session: AcpAgentRuntimeSession = {
      id: sessionId,
      remoteSessionId: sessionId,
      chatId: request.chatId,
      projectPath: request.projectPath,
      client,
      capabilities,
      state: 'idle',
      retired: false,
      activeTurn: null,
      sourceTurn: null,
      permissionMode: request.permissionMode,
      configOptions: created.configOptions,
      startedAt: now,
      lastActivityAt: Date.now(),
    };
    this.#sessions.set(sessionId, session);
    const result = {
      agentSessionId: sessionId,
      nativePath: this.#nativePathFor(sessionId),
    };
    request.onSessionActivated?.(result);
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    let executionStarted = false;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const promptTask = this.#runPrompt(session, request, () => {
      this.#retireSupersededChatSessions(session);
      if (executionStarted) return;
      executionStarted = true;
      resolveStarted();
    });
    void promptTask.then(() => {
      if (!executionStarted) rejectStarted(new Error('ACP session ended before execution started'));
    }, (error) => {
      if (!executionStarted) rejectStarted(error);
    });
    try {
      await started;
    } catch (error) {
      this.#retireSession(session, 'cancelled');
      throw error;
    }

    return result;
  }

  async runTurn(request: AcpResumeRequest): Promise<void> {
    assertAcpExecutionOpen(request);
    const session = await this.#sessionForTurn(request);
    if (session.activeTurn?.running) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    await this.#runPrompt(session, request);
  }

  async prepareProjectPathUpdate(request: AcpProjectPathUpdateRequest): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (session.chatId !== request.chatId) {
      throw new Error('Chat ID mismatch');
    }
    if (session.activeTurn?.running) {
      throw new Error(`Session ${agentSessionId} is already running`);
    }
    if ((session.sourceTurn?.pendingPermissions.size ?? 0) > 0) {
      throw new Error(`Session ${agentSessionId} is waiting for permission`);
    }

    this.#retireSession(session, 'session-complete');
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    const turn = session?.activeTurn;
    if (!session || !turn?.running) return false;

    if (abortStrategy(this.#policy) === 'process-restart') {
      turn.aborted = true;
      session.state = 'aborted';
      this.#completeTurn(turn);
      this.#retireSession(session, 'aborted');
      return true;
    }

    turn.aborted = true;
    session.state = 'aborted';
    this.#cancelPermissionsForTurn(turn, 'aborted');
    void session.client.cancelSession({ sessionId: session.remoteSessionId }).catch(() => {});
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#sessions.get(agentSessionId)?.activeTurn?.running === true;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.activeTurn?.running)
      .map((session) => ({
        id: session.id,
        status: session.state,
        startedAt: session.startedAt,
      }));
  }

  async #resolvePermission(
    pending: PendingPermissionRequest,
    decision: PermissionDecisionPayload,
  ): Promise<void> {
    if (!this.#pendingPermissions.has(pending) || pending.turn.sourceRetired) {
      throw new Error('ACP permission occurrence is no longer pending');
    }
    pending.session.client.respond(
      pending.requestId,
      decision.response ?? pending.responseForDecision(decision),
    );
    this.#pendingPermissions.delete(pending);
    pending.turn.pendingPermissions.delete(pending);
  }

  updateSessionSettings(agentSessionId: string, patch: AcpSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) {
      session.permissionMode = patch.permissionMode;
      if (session.sourceTurn) session.sourceTurn.permissionMode = patch.permissionMode;
    }
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of [...this.#sessions.values()]) {
      this.#retireSession(session, 'session-complete');
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  async #connectClient(request: AcpStartRequest | AcpResumeRequest): Promise<AcpClient> {
    const command = typeof this.#policy.command === 'function'
      ? this.#policy.command()
      : this.#policy.command;
    const transport = this.#createTransport();
    const client = new AcpClient(transport, {
      initialize: {
        protocolVersion: 1,
        clientInfo: { name: 'garcon', version: '1.0.0' },
        clientCapabilities: this.#policy.clientCapabilities ?? {},
        mcpServers: this.#policy.mcpServers ?? [],
      },
      authenticateMethodId: this.#policy.authenticateMethodId,
    });
    await client.connect({
      command,
      args: this.#policy.args ?? ['acp'],
      cwd: request.projectPath,
      env: this.#buildEnv(request),
    });
    this.#capabilityCache.set({
      command,
      binaryVersion: this.#policy.binaryVersion ?? 'unknown',
    }, client.getAdvertisedCapabilities());
    return client;
  }

  async #sessionForTurn(request: AcpResumeRequest): Promise<AcpAgentRuntimeSession> {
    const existing = this.#sessions.get(request.agentSessionId);
    if (existing) {
      if (existing.chatId !== request.chatId) {
        throw new Error(`ACP session ${request.agentSessionId} is already bound to another chat`);
      }
      return existing;
    }

    const client = await this.#connectClient(request);
    const capabilities = client.getAdvertisedCapabilities();
    const order = reconnectOrder(capabilities);
    const baseSession: AcpAgentRuntimeSession = {
      id: request.agentSessionId,
      remoteSessionId: request.agentSessionId,
      chatId: request.chatId,
      projectPath: request.projectPath,
      client,
      capabilities,
      state: 'idle',
      retired: false,
      activeTurn: null,
      sourceTurn: null,
      permissionMode: request.permissionMode,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
    };
    this.#sessions.set(request.agentSessionId, baseSession);

    const connected = await this.#reconnectSession(baseSession, request, order);
    if (!connected) {
      this.#retireSession(baseSession, 'cancelled');
      throw new Error(`Unable to restore ${this.#policy.agentId} session ${request.agentSessionId}. Start a new chat session.`);
    }
    return baseSession;
  }

  async #reconnectSession(
    session: AcpAgentRuntimeSession,
    request: AcpResumeRequest,
    order: ReconnectStrategy[],
  ): Promise<boolean> {
    for (const strategy of order) {
      if (strategy === 'resume') {
        try {
          const loaded = await session.client.resumeSession({
            sessionId: session.remoteSessionId,
            cwd: request.projectPath,
            mcpServers: this.#policy.mcpServers,
          });
          session.configOptions = loaded.configOptions;
          return true;
        } catch (error) {
          if (isRecoverableLoadFailure(error)) continue;
          throw error;
        }
      }

      if (strategy === 'load') {
        try {
          const loaded = await session.client.loadSession({
            sessionId: session.remoteSessionId,
            cwd: request.projectPath,
            mcpServers: this.#policy.mcpServers,
          });
          session.configOptions = loaded.configOptions;
          return true;
        } catch (error) {
          if (isRecoverableLoadFailure(error)) continue;
          throw error;
        }
      }

      if (strategy === 'new' && this.#policy.reconnectAllowNewSession) {
        const model = this.#newSessionModelForRequest(request);
        const created = await session.client.newSession({
          cwd: request.projectPath,
          mcpServers: this.#policy.mcpServers,
          ...(model ? { model } : {}),
        });
        session.remoteSessionId = created.sessionId;
        session.configOptions = created.configOptions;
        return true;
      }
    }
    return false;
  }

  async #runPrompt(
    session: AcpAgentRuntimeSession,
    request: AcpStartRequest | AcpResumeRequest,
    onExecutionStarted?: () => void,
  ): Promise<void> {
    assertAcpExecutionOpen(request);
    const turn = this.#createTurn(session, request);
    this.#bindTurnSource(turn);
    this.#converter.beginTurn?.(session.id);

    let success = false;
    let shouldThrow = false;
    let failureMessage = '';
    let executionStarted = false;
    let admissionClosed = false;

    try {
      await this.#configureSession(session, request);
      const prompt = this.#buildPrompt(request);
      const promptConfig = this.#promptConfigForRequest(request);
      if (request.executionAdmission) await markAcpExecutionStarted(request);
      const promptRequest = session.client.promptSession({
        sessionId: session.remoteSessionId,
        prompt,
        ...(promptConfig ? { config: promptConfig } : {}),
      }, () => {
        if (!this.#activateTurnSource(turn, request.projectPath)) return;
        executionStarted = true;
        onExecutionStarted?.();
      });
      await promptRequest;
      success = !turn.aborted;
    } catch (error) {
      admissionClosed = request.executionAdmission?.signal.aborted === true;
      if (turn.aborted) {
        success = false;
      } else {
        shouldThrow = true;
        failureMessage = humanizeError(error);
      }
    } finally {
      if (executionStarted) {
        this.#emitFlushedMessages(turn);
      }
      if (turn.aborted) {
        session.state = 'aborted';
      } else if (admissionClosed) {
        session.state = 'idle';
      } else {
        session.state = failureMessage ? 'failed' : 'idle';
      }
      session.lastActivityAt = Date.now();
      this.#completeTurn(turn);

      if (success && !turn.sourceRetired) {
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'finished',
        });
      } else if (!turn.aborted && !admissionClosed && failureMessage && !turn.sourceRetired) {
        this.#publishMessages(turn, [
          new ErrorMessage(new Date().toISOString(), failureMessage),
        ]);
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message: failureMessage },
        });
      }

      this.#cancelPermissionsForTurn(turn, turn.aborted ? 'aborted' : 'session-complete');
      if (!executionStarted) this.#retireTurnSource(turn, 'cancelled');
    }

    if (shouldThrow) {
      throw new Error(failureMessage);
    }
  }

  #createTurn(
    session: AcpAgentRuntimeSession,
    request: AcpStartRequest | AcpResumeRequest,
  ): AcpTurnContext {
    return {
      session,
      operation: request.operation,
      pendingPermissions: new Set(),
      detachSourceListeners: [],
      permissionMode: request.permissionMode,
      running: false,
      completed: false,
      aborted: false,
      sourceActive: false,
      sourceRetired: false,
    };
  }

  #activateTurnSource(turn: AcpTurnContext, projectPath: string): boolean {
    const session = turn.session;
    if (session.retired) return false;
    const previous = session.sourceTurn;
    if (previous && previous !== turn) {
      this.#retireTurnSource(previous, 'session-complete');
    }
    turn.sourceActive = true;
    turn.running = true;
    session.sourceTurn = turn;
    session.activeTurn = turn;
    session.permissionMode = turn.permissionMode;
    session.projectPath = projectPath;
    session.state = 'running';
    session.lastActivityAt = Date.now();
    return true;
  }

  #bindTurnSource(turn: AcpTurnContext): void {
    const session = turn.session;
    turn.detachSourceListeners.push(session.client.onRpcMessage((message) => {
      if (!this.#canRouteSource(turn)) return;
      if (message.method === 'session/update') {
        this.#onSessionUpdate(turn, message.params);
        return;
      }
      if (message.method === 'session/request_permission' && isJsonRpcId(message.id)) {
        this.#onPermissionRequest(turn, message.id, message.params);
        return;
      }
      if (typeof message.method === 'string' && isJsonRpcId(message.id)) {
        if (!this.#onCustomBlockingRequest(turn, message.id, message.method, message.params)) {
          session.client.respondError(message.id, -32601, `Unsupported ACP request method: ${message.method}`);
        }
      }
    }));

    turn.detachSourceListeners.push(session.client.onExit((exitCode) => {
      if (!this.#canRouteSource(turn)) return;
      if (turn.running && !turn.aborted) {
        const message = `${this.#policy.agentId} ACP process exited with code ${exitCode}`;
        this.#publishMessages(turn, [new ErrorMessage(new Date().toISOString(), message)]);
        session.state = 'failed';
        session.lastActivityAt = Date.now();
        this.#completeTurn(turn);
        this.#publishTurnEvent(turn, {
          type: 'run-ended',
          runId: turn.operation.runId,
          outcome: 'failed',
          error: { code: 'PROVIDER_FAILURE', message },
        });
      }
      this.#retireSession(session, 'cancelled');
    }));

    turn.detachSourceListeners.push(session.client.onStderr((line) => {
      if (!this.#canRouteSource(turn)) return;
      if (!line.trim()) return;
      this.#publishMessages(turn, [new ErrorMessage(new Date().toISOString(), line)]);
    }));
  }

  #onSessionUpdate(turn: AcpTurnContext, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionUpdateNotification;
    const remoteSessionId = asString(params.sessionId);
    const session = turn.session;
    if (!remoteSessionId || remoteSessionId !== session.remoteSessionId) {
      this.#logger.warn('Dropped an ACP session update without its owning native session.', {
        agentId: this.#policy.agentId,
        sessionId: session.id,
      });
      return;
    }

    session.lastActivityAt = Date.now();
    const context = this.#sessionUpdateContext(turn);
    const converted = this.#converter.fromSessionUpdate(params, context);
    if (turn.completed) {
      converted.push(...(this.#converter.endTurn?.(session.id, context) ?? []));
    }
    this.#publishMessages(turn, converted);
  }

  #onPermissionRequest(turn: AcpTurnContext, requestId: AcpJsonRpcId, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionRequestPermission;
    const remoteSessionId = asString(params.sessionId);
    const session = turn.session;
    if (!remoteSessionId || remoteSessionId !== session.remoteSessionId) {
      this.#logger.warn('Dropped an ACP permission request without its owning native session.', {
        agentId: this.#policy.agentId,
        sessionId: session.id,
      });
      return;
    }

    const options = (Array.isArray(params.options) ? params.options : [])
      .map((option) => asObject(option));

    if (isAutoApproveMode(turn.permissionMode)) {
      session.client.respond(
        requestId,
        permissionOutcome(permissionOptionId(options, autoApproveOptionId(turn.permissionMode))),
      );
      return;
    }

    const permissionRequestId = `${this.#policy.agentId}-${session.id}-${String(requestId)}`;
    const toolCall = asObject(params.toolCall);
    const toolId = asString(toolCall.toolCallId ?? toolCall.callId ?? toolCall.id) ?? permissionRequestId;
    const context = this.#sessionUpdateContext(turn);
    const convertedRequestedTool = this.#converter.permissionToolUse?.(toolCall, context) ?? null;
    const rawName = asString(toolCall.toolName ?? toolCall.tool_name ?? toolCall.kind ?? toolCall.title ?? toolCall.name) ?? 'Permission';
    const rawInput = toolCall.rawInput ?? toolCall.raw_input ?? toolCall.input ?? toolCall.args;
    const fallbackInput = normalizeToolInput(rawInput);
    if (Object.keys(fallbackInput).length === 0) {
      if (Array.isArray(toolCall.locations) && toolCall.locations.length > 0) {
        fallbackInput.locations = toolCall.locations;
      }
      if (Array.isArray(toolCall.content) && toolCall.content.length > 0) {
        fallbackInput.content = toolCall.content;
      }
      const title = asString(toolCall.title);
      if (title) fallbackInput.title = title;
    }
    const requestedTool = convertedRequestedTool
      ?? new UnknownToolUseMessage(
        context.timestamp,
        toolId,
        rawName,
        fallbackInput,
      );

    const pending = this.#registerPendingPermission(
      turn,
      permissionRequestId,
      requestId,
      (decision) => {
        const fallback = decision.allow
          ? (decision.alwaysAllow ? 'allow-always' : 'allow-once')
          : 'reject-once';
        return permissionOutcome(permissionOptionId(options, fallback));
      },
      permissionCancelledOutcome,
    );
    this.#publishTurnEvent(turn, {
      type: 'permission',
      runId: turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        requestId: permissionRequestId,
        incarnation: pending.incarnation,
        requestedTool,
        options: [],
      },
      decision: this.#decisionCapability(pending),
    });
  }

  #onCustomBlockingRequest(
    turn: AcpTurnContext,
    requestId: AcpJsonRpcId,
    method: string,
    params: unknown,
  ): boolean {
    const session = turn.session;
    const context = this.#sessionUpdateContext(turn);
    const converted = this.#converter.customRequestToolUse?.({
      method,
      requestId,
      params,
    }, context) ?? null;
    if (!converted) return false;

    const permissionRequestId = `${this.#policy.agentId}-${session.id}-${String(requestId)}`;
    const pending = this.#registerPendingPermission(
      turn,
      permissionRequestId,
      requestId,
      converted.responseForDecision,
      converted.responseForCancellation,
    );
    this.#publishTurnEvent(turn, {
      type: 'permission',
      runId: turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        requestId: permissionRequestId,
        incarnation: pending.incarnation,
        requestedTool: converted.tool,
        options: [],
      },
      decision: this.#decisionCapability(pending),
    });
    return true;
  }

  #registerPendingPermission(
    turn: AcpTurnContext,
    permissionRequestId: string,
    requestId: AcpJsonRpcId,
    responseForDecision: PendingPermissionRequest['responseForDecision'],
    responseForCancellation: PendingPermissionRequest['responseForCancellation'],
  ): PendingPermissionRequest {
    const pending: PendingPermissionRequest = {
      permissionRequestId,
      incarnation: crypto.randomUUID(),
      session: turn.session,
      turn,
      requestId,
      responseForDecision,
      responseForCancellation,
    };
    turn.pendingPermissions.add(pending);
    this.#pendingPermissions.add(pending);
    return pending;
  }

  #decisionCapability(pending: PendingPermissionRequest) {
    return Object.freeze({
      requestId: pending.permissionRequestId,
      incarnation: pending.incarnation,
      respond: (decision: PermissionDecisionPayload) => this.#resolvePermission(pending, decision),
    });
  }

  #cancelPermissionsForTurn(
    turn: AcpTurnContext,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    for (const pending of [...turn.pendingPermissions]) {
      if (!this.#pendingPermissions.delete(pending)) continue;
      try {
        pending.session.client.respond(pending.requestId, pending.responseForCancellation(reason));
      } catch {}
      this.#publishTurnEvent(turn, {
        type: 'permission',
        runId: turn.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          requestId: pending.permissionRequestId,
          incarnation: pending.incarnation,
          reason,
        },
      });
    }
    turn.pendingPermissions.clear();
  }

  #completeTurn(turn: AcpTurnContext): void {
    if (turn.completed) return;
    turn.completed = true;
    turn.running = false;
    const session = turn.session;
    if (session.activeTurn === turn) session.activeTurn = null;
  }

  #emitFlushedMessages(turn: AcpTurnContext): void {
    const messages = this.#converter.endTurn?.(
      turn.session.id,
      this.#sessionUpdateContext(turn),
    ) ?? [];
    this.#publishMessages(turn, messages);
  }

  #publishMessages(
    turn: AcpTurnContext,
    messages: ChatMessage[],
  ): void {
    if (messages.length === 0 || turn.sourceRetired) return;
    this.#publishTurnEvent(turn, {
      type: 'rows',
      rows: runtimeRows(messages),
    });
  }

  #publishTurnEvent(turn: AcpTurnContext, event: AgentRuntimeEvent): void {
    if (turn.sourceRetired) return;
    try {
      turn.operation.publish(event);
    } catch (error) {
      this.#logger.warn('ACP publisher rejected an event.', {
        agentId: this.#policy.agentId,
        sessionId: turn.session.id,
        eventType: event.type,
        error: humanizeError(error),
      });
    }
  }

  #canRouteSource(turn: AcpTurnContext): boolean {
    return turn.sourceActive && !turn.sourceRetired;
  }

  #retireSupersededChatSessions(current: AcpAgentRuntimeSession): void {
    for (const session of [...this.#sessions.values()]) {
      if (session === current || session.chatId !== current.chatId) continue;
      this.#retireSession(session, 'session-complete');
    }
  }

  #retireTurnSource(
    turn: AcpTurnContext,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    if (turn.sourceRetired) return;
    this.#cancelPermissionsForTurn(turn, reason);
    turn.sourceActive = false;
    turn.sourceRetired = true;
    for (const detach of turn.detachSourceListeners.splice(0)) detach();
    if (turn.session.sourceTurn === turn) turn.session.sourceTurn = null;
  }

  #retireSession(
    session: AcpAgentRuntimeSession,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    if (session.retired) return;
    session.retired = true;
    session.lastActivityAt = Date.now();
    const turns = new Set([session.activeTurn, session.sourceTurn].filter(
      (turn): turn is AcpTurnContext => turn !== null,
    ));
    for (const turn of turns) {
      if (reason === 'aborted') turn.aborted = true;
      this.#completeTurn(turn);
      this.#retireTurnSource(turn, reason);
    }
    if (this.#sessions.get(session.id) === session) this.#sessions.delete(session.id);
    session.client.close();
  }

  #mappedModel(model: string): string | undefined {
    if (!model || model === 'default') return undefined;
    return this.#policy.mapModel ? this.#policy.mapModel(model) : model;
  }

  #newSessionModelForRequest(request: AcpStartRequest | AcpResumeRequest): string | undefined {
    if (this.#policy.newSessionModelConfig === false) return undefined;
    return this.#mappedModel(request.model);
  }

  async #configureSession(
    session: AcpAgentRuntimeSession,
    request: AcpStartRequest | AcpResumeRequest,
  ): Promise<void> {
    const configured = await this.#policy.configureSession?.({
      client: session.client,
      sessionId: session.remoteSessionId,
      request,
      configOptions: session.configOptions,
    });
    if (configured) {
      session.configOptions = configured;
    }
  }

  #buildPrompt(request: AcpStartRequest | AcpResumeRequest): Array<{ type: string; text?: string; [key: string]: unknown }> {
    const prompt = this.#policy.buildPrompt
      ? this.#policy.buildPrompt(request)
      : buildPromptFallback(request);
    return prompt.length > 0 ? prompt : buildPromptFallback(request);
  }

  #buildEnv(request: AcpStartRequest | AcpResumeRequest): Record<string, string | undefined> {
    return this.#policy.buildEnv
      ? this.#policy.buildEnv(request)
      : buildEnvFallback(request);
  }

  #promptConfigForRequest(request: AcpStartRequest | AcpResumeRequest): Record<string, unknown> | null {
    const config: Record<string, unknown> = {};
    const mode = this.#policy.promptModeConfig === false
      ? undefined
      : this.#policy.mapPermissionMode?.(request.permissionMode);
    if (mode) config.mode = mode;
    const model = this.#policy.promptModelConfig === false
      ? undefined
      : this.#mappedModel(request.model);
    if (model) config.model = model;
    return Object.keys(config).length > 0 ? config : null;
  }

  #nativePathFor(sessionId: string): string | null {
    if (this.#policy.resolveNativePath) {
      return this.#policy.resolveNativePath(sessionId);
    }
    return createArtificialNativePath(this.#policy.agentId, sessionId);
  }

  #sessionUpdateContext(turn: AcpTurnContext): AcpSessionUpdateContext {
    return {
      chatId: turn.session.chatId,
      sessionId: turn.session.id,
      timestamp: new Date().toISOString(),
    };
  }
}

import {
  ErrorMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  UnknownToolUseMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { AgentEventEmitterRuntime } from '@garcon/server-agent-common/shared/event-emitter-runtime';
import { normalizeToolInput } from '@garcon/server-agent-common/shared/normalize-util';
import {
  assertExecutionAdmissionOpen,
  executionEventMetadata,
  markExecutionStarted,
  type PermissionMode,
  type AgentEventMetadata,
  type AgentSessionSettingsPatch,
  type PrepareProjectPathUpdateRequest,
  type ResumeTurnRequest,
  type StartSessionRequest,
  type StartedAgentSession,
} from '@garcon/server-agent-common/legacy/session-types';
import type { AgentRuntime } from '@garcon/server-agent-common/legacy/types';
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
import type { AcpBlockingRequestToolUse, AcpEventConverter, AcpSessionUpdateContext } from './acp-event-converter.js';
import { IdleSessionPurger } from '@garcon/server-agent-common/shared/idle-session-purger';

type RuntimeSessionState = 'idle' | 'running' | 'failed' | 'aborted';

interface PendingPermissionRequest {
  chatId: string;
  requestId: AcpJsonRpcId;
  sessionId: string;
  responseForDecision(decision: PermissionDecisionPayload): Record<string, unknown>;
  responseForCancellation(reason: 'cancelled' | 'session-complete' | 'aborted'): Record<string, unknown>;
}

interface AcpAgentRuntimeSession {
  id: string;
  remoteSessionId: string;
  chatId: string;
  projectPath: string;
  client: AcpClient;
  capabilities: AcpAdvertisedCapabilities;
  state: RuntimeSessionState;
  running: boolean;
  aborted: boolean;
  retired: boolean;
  turnGeneration: number;
  permissionMode: PermissionMode;
  pendingPermissionIds: Set<string>;
  configOptions?: AcpSessionConfigOption[];
  startedAt: string;
  lastActivityAt: number;
  lastUpdateAt: number;
  upstreamRequestId?: string;
  eventMetadata: AgentEventMetadata;
}

export type AcpAbortStrategy = 'cancel' | 'process-restart';

export interface AcpSessionConfigurationContext {
  client: AcpClient;
  sessionId: string;
  request: StartSessionRequest | ResumeTurnRequest;
  configOptions?: AcpSessionConfigOption[];
}

export interface AcpAgentPolicy {
  agentId: string;
  command: string;
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
  buildEnv?: (request: StartSessionRequest | ResumeTurnRequest) => Record<string, string | undefined>;
  buildPrompt?: (request: StartSessionRequest | ResumeTurnRequest) => Array<{ type: string; text?: string; [key: string]: unknown }>;
  mapPermissionMode?: (mode: PermissionMode) => string | undefined;
  mapModel?: (model: string) => string | undefined;
  resolveNativePath?: (sessionId: string) => string | null;
}

export interface AcpAgentRuntimeOptions {
  converter: AcpEventConverter;
  capabilityCache?: AcpCapabilityCache;
  createTransport?: () => AcpTransport;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildPromptFallback(request: StartSessionRequest | ResumeTurnRequest): Array<{ type: string; text: string }> {
  return [{ type: 'text', text: request.command }];
}

function buildEnvFallback(request: StartSessionRequest | ResumeTurnRequest): Record<string, string | undefined> {
  return { ...process.env, ...request.envOverrides };
}

function isAutoApproveMode(mode: PermissionMode): boolean {
  return mode === 'acceptEdits' || mode === 'manualBypass' || mode === 'bypassPermissions';
}

function autoApproveOptionId(mode: PermissionMode): 'allow-once' | 'allow-always' {
  return mode === 'bypassPermissions' ? 'allow-always' : 'allow-once';
}

function isJsonRpcId(value: unknown): value is AcpJsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function optionIdFrom(option: Record<string, unknown>): string | undefined {
  return asString(option.optionId ?? option.option_id ?? option.id);
}

function permissionOptionId(options: Array<Record<string, unknown>>, fallback: string): string {
  const optionIds = options.map(optionIdFrom).filter((id): id is string => Boolean(id));
  if (optionIds.includes(fallback)) return fallback;
  return optionIds[0] ?? fallback;
}

function permissionOutcome(optionId: string): Record<string, unknown> {
  return { outcome: { outcome: 'selected', optionId } };
}

function permissionCancelledOutcome(): Record<string, unknown> {
  return { outcome: { outcome: 'cancelled' } };
}

function humanizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function upstreamRequestIdFromUpdate(notification: AcpSessionUpdateNotification): string | undefined {
  const update = asObject(notification.update);
  return asString(update.requestId ?? update.request_id);
}

function abortStrategy(policy: AcpAgentPolicy): AcpAbortStrategy {
  return policy.abortStrategy ?? 'cancel';
}

export class AcpAgentRuntime extends AgentEventEmitterRuntime implements AgentRuntime {
  #policy: AcpAgentPolicy;
  #converter: AcpEventConverter;
  #capabilityCache: AcpCapabilityCache;
  #createTransport: () => AcpTransport;
  #sessions = new Map<string, AcpAgentRuntimeSession>();
  #pendingPermissions = new Map<string, PendingPermissionRequest>();
  #idlePurger = new IdleSessionPurger<AcpAgentRuntimeSession>({
    sessions: () => this.#sessions.entries(),
    isRunning: (session) => session.running,
    lastActivityAt: (session) => session.lastActivityAt,
    purge: (sessionId, session) => {
      session.client.close();
      this.#sessions.delete(sessionId);
      this.#cancelPermissionsForSession(session, 'session-complete');
    },
  });

  constructor(policy: AcpAgentPolicy, options: AcpAgentRuntimeOptions) {
    super();
    this.#policy = policy;
    this.#converter = options.converter;
    this.#capabilityCache = options.capabilityCache ?? new AcpCapabilityCache();
    this.#createTransport = options.createTransport ?? (() => new AcpTransport());
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    assertExecutionAdmissionOpen(request);
    const client = await this.#connectClient(request);
    let created: Awaited<ReturnType<AcpClient['newSession']>>;
    try {
      assertExecutionAdmissionOpen(request);
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
      running: false,
      aborted: false,
      retired: false,
      turnGeneration: 0,
      permissionMode: request.permissionMode,
      pendingPermissionIds: new Set(),
      configOptions: created.configOptions,
      startedAt: now,
      lastActivityAt: Date.now(),
      lastUpdateAt: 0,
      eventMetadata: executionEventMetadata(request, 'chat-start'),
    };
    this.#sessions.set(sessionId, session);
    this.#bindClientEvents(session);
    this.emitSessionCreated(request.chatId);
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    let executionStarted = false;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const promptTask = this.#runPrompt(session, request, () => {
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
      if (this.#sessions.get(sessionId) === session) this.#sessions.delete(sessionId);
      session.retired = true;
      client.close();
      throw error;
    }

    return {
      agentSessionId: sessionId,
      nativePath: this.#nativePathFor(sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
    assertExecutionAdmissionOpen(request);
    const session = await this.#sessionForTurn(request);
    if (session.running) {
      throw new Error(`Session ${request.agentSessionId} is already running`);
    }
    await this.#runPrompt(session, request);
  }

  async prepareProjectPathUpdate(request: PrepareProjectPathUpdateRequest): Promise<void> {
    const agentSessionId = request.agentSessionId;
    if (!agentSessionId) return;

    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (session.chatId !== request.chatId) {
      throw new Error('Chat ID mismatch');
    }
    if (session.running) {
      throw new Error(`Session ${agentSessionId} is already running`);
    }
    if (session.pendingPermissionIds.size > 0) {
      throw new Error(`Session ${agentSessionId} is waiting for permission`);
    }

    session.retired = true;
    session.state = 'idle';
    session.lastActivityAt = Date.now();
    this.#sessions.delete(agentSessionId);
    session.client.close();
  }

  abort(agentSessionId: string): boolean {
    const session = this.#sessions.get(agentSessionId);
    if (!session || !session.running) return false;

    if (abortStrategy(this.#policy) === 'process-restart') {
      this.#retireSessionForAbort(session);
      return true;
    }

    session.aborted = true;
    session.state = 'aborted';
    this.#cancelPermissionsForSession(session, 'aborted');
    void session.client.cancelSession({ sessionId: session.remoteSessionId }).catch(() => {});
    return true;
  }

  isRunning(agentSessionId: string): boolean {
    return this.#sessions.get(agentSessionId)?.running === true;
  }

  getRunningSessions(): Array<{ id: string; status?: string; startedAt?: string }> {
    return Array.from(this.#sessions.values())
      .filter((session) => session.running)
      .map((session) => ({
        id: session.id,
        status: session.state,
        startedAt: session.startedAt,
      }));
  }

  resolvePermission(permissionRequestId: string, decision: PermissionDecisionPayload): void {
    const pending = this.#pendingPermissions.get(permissionRequestId);
    if (!pending) return;
    this.#pendingPermissions.delete(permissionRequestId);
    const session = this.#sessions.get(pending.sessionId);
    session?.pendingPermissionIds.delete(permissionRequestId);
    if (!session) return;

    session.client.respond(
      pending.requestId,
      decision.response ?? pending.responseForDecision(decision),
    );
    this.emitMessages(session.chatId, [
      new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, Boolean(decision.allow)),
    ], session.eventMetadata);
  }

  updateSessionSettings(agentSessionId: string, patch: AgentSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
  }

  shutdown(): void {
    this.#idlePurger.stop();
    for (const session of this.#sessions.values()) {
      session.client.close();
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
  }

  startPurgeTimer(): void {
    this.#idlePurger.start();
  }

  async #connectClient(request: StartSessionRequest | ResumeTurnRequest): Promise<AcpClient> {
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
      command: this.#policy.command,
      args: this.#policy.args ?? ['acp'],
      cwd: request.projectPath,
      env: this.#buildEnv(request),
    });
    this.#capabilityCache.set({
      command: this.#policy.command,
      binaryVersion: this.#policy.binaryVersion ?? 'unknown',
    }, client.getAdvertisedCapabilities());
    return client;
  }

  async #sessionForTurn(request: ResumeTurnRequest): Promise<AcpAgentRuntimeSession> {
    const existing = this.#sessions.get(request.agentSessionId);
    if (existing) return existing;

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
      running: false,
      aborted: false,
      retired: false,
      turnGeneration: 0,
      permissionMode: request.permissionMode,
      pendingPermissionIds: new Set(),
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      lastUpdateAt: 0,
      eventMetadata: executionEventMetadata(request),
    };
    this.#sessions.set(request.agentSessionId, baseSession);
    this.#bindClientEvents(baseSession);

    const connected = await this.#reconnectSession(baseSession, request, order);
    if (!connected) {
      this.#sessions.delete(request.agentSessionId);
      client.close();
      throw new Error(`Unable to restore ${this.#policy.agentId} session ${request.agentSessionId}. Start a new chat session.`);
    }
    return baseSession;
  }

  async #reconnectSession(
    session: AcpAgentRuntimeSession,
    request: ResumeTurnRequest,
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
    request: StartSessionRequest | ResumeTurnRequest,
    onExecutionStarted?: () => void,
  ): Promise<void> {
    assertExecutionAdmissionOpen(request);
    const turnGeneration = ++session.turnGeneration;
    session.retired = false;
    session.running = false;
    session.state = 'idle';
    session.aborted = false;
    session.permissionMode = request.permissionMode;
    session.chatId = request.chatId;
    session.projectPath = request.projectPath;
    session.lastActivityAt = Date.now();
    session.lastUpdateAt = Date.now();
    session.upstreamRequestId = undefined;
    session.eventMetadata = executionEventMetadata(
      request,
      'agentSessionId' in request ? undefined : 'chat-start',
    );
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
      markExecutionStarted(request);
      executionStarted = true;
      session.running = true;
      session.state = 'running';
      this.emitProcessing(session.chatId, true);
      onExecutionStarted?.();
      const promptRequest = session.client.promptSession({
        sessionId: session.remoteSessionId,
        prompt,
        ...(promptConfig ? { config: promptConfig } : {}),
      });
      request.onAbortable?.();
      const result = await promptRequest;
      if (typeof result.requestId === 'string' && result.requestId) {
        session.upstreamRequestId = result.requestId;
      }
      await this.#waitForUpdateQuietPeriod(session);
      success = !session.aborted;
    } catch (error) {
      admissionClosed = request.executionAdmission?.signal.aborted === true;
      if (session.aborted) {
        success = false;
      } else {
        shouldThrow = true;
        failureMessage = humanizeError(error);
      }
    } finally {
      if (session.retired || this.#sessions.get(session.id) !== session || session.turnGeneration !== turnGeneration) {
        return;
      }

      if (executionStarted) {
        this.#emitFlushedMessages(session);
        this.emitProcessing(session.chatId, false);
      }
      session.running = false;
      session.state = session.aborted
        ? 'aborted'
        : admissionClosed
          ? 'idle'
          : (failureMessage ? 'failed' : 'idle');
      session.lastActivityAt = Date.now();

      if (success) {
        const metadata = {
          ...session.eventMetadata,
          ...(session.upstreamRequestId ? { upstreamRequestId: session.upstreamRequestId } : {}),
        } satisfies AgentEventMetadata;
        this.emitFinished(session.chatId, 0, metadata);
      } else if (!session.aborted && !admissionClosed && failureMessage) {
        this.emitMessages(session.chatId, [
          new ErrorMessage(new Date().toISOString(), failureMessage),
        ], session.eventMetadata);
        this.emitFailed(session.chatId, failureMessage, session.eventMetadata);
      }

      this.#cancelPermissionsForSession(session, session.aborted ? 'aborted' : 'session-complete');
    }

    if (shouldThrow) {
      throw new Error(failureMessage);
    }
  }

  #retireSessionForAbort(session: AcpAgentRuntimeSession): void {
    session.aborted = true;
    session.retired = true;
    session.running = false;
    session.state = 'aborted';
    session.turnGeneration += 1;
    session.lastActivityAt = Date.now();

    this.#cancelPermissionsForSession(session, 'aborted');
    this.emitProcessing(session.chatId, false);
    this.#sessions.delete(session.id);

    void session.client.cancelSession({ sessionId: session.remoteSessionId }).catch(() => {});
    session.client.close();
  }

  #emitFlushedMessages(session: AcpAgentRuntimeSession): void {
    const context = this.#sessionUpdateContext(session);
    const messages = this.#converter.endTurn?.(session.id, context) ?? [];
    this.emitMessages(session.chatId, messages, session.eventMetadata);
  }

  #bindClientEvents(session: AcpAgentRuntimeSession): void {
    session.client.onRpcMessage((message) => {
      if (message.method === 'session/update') {
        this.#onSessionUpdate(session, message.params);
        return;
      }
      if (message.method === 'session/request_permission' && isJsonRpcId(message.id)) {
        this.#onPermissionRequest(session, message.id, message.params);
        return;
      }
      if (typeof message.method === 'string' && isJsonRpcId(message.id)) {
        if (!this.#onCustomBlockingRequest(session, message.id, message.method, message.params)) {
          session.client.respondError(message.id, -32601, `Unsupported ACP request method: ${message.method}`);
        }
      }
    });

    session.client.onExit((exitCode) => {
      if (!this.#isCurrentSession(session) || !session.running) return;
      if (session.aborted) return;
      const message = `${this.#policy.agentId} ACP process exited with code ${exitCode}`;
      this.emitMessages(
        session.chatId,
        [new ErrorMessage(new Date().toISOString(), message)],
        session.eventMetadata,
      );
      this.emitProcessing(session.chatId, false);
      session.running = false;
      session.state = 'failed';
      session.lastActivityAt = Date.now();
      this.emitFailed(session.chatId, message, session.eventMetadata);
      this.#cancelPermissionsForSession(session, 'cancelled');
    });

    session.client.onStderr((line) => {
      if (!this.#isCurrentSession(session) || !session.running) return;
      if (!line.trim()) return;
      this.emitMessages(
        session.chatId,
        [new ErrorMessage(new Date().toISOString(), line)],
        session.eventMetadata,
      );
    });
  }

  #onSessionUpdate(boundSession: AcpAgentRuntimeSession, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionUpdateNotification;
    const remoteSessionId = asString(params.sessionId);
    if (
      !remoteSessionId
      || remoteSessionId !== boundSession.remoteSessionId
      || !this.#isCurrentSession(boundSession)
      || !boundSession.running
    ) return;
    const session = boundSession;

    session.lastUpdateAt = Date.now();
    session.lastActivityAt = Date.now();
    const upstreamRequestId = upstreamRequestIdFromUpdate(params);
    if (upstreamRequestId) {
      session.upstreamRequestId = upstreamRequestId;
    }
    const context = this.#sessionUpdateContext(session);
    const converted = this.#converter.fromSessionUpdate(params, context);
    const metadata = {
      ...session.eventMetadata,
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
    } satisfies AgentEventMetadata;
    this.emitMessages(session.chatId, converted, metadata);
  }

  #onPermissionRequest(boundSession: AcpAgentRuntimeSession, requestId: AcpJsonRpcId, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionRequestPermission;
    const remoteSessionId = asString(params.sessionId);
    if (
      (remoteSessionId && remoteSessionId !== boundSession.remoteSessionId)
      || !this.#isCurrentSession(boundSession)
      || !boundSession.running
    ) return;
    const session = boundSession;

    const options = (Array.isArray(params.options) ? params.options : [])
      .map((option) => asObject(option));

    if (isAutoApproveMode(session.permissionMode)) {
      session.client.respond(
        requestId,
        permissionOutcome(permissionOptionId(options, autoApproveOptionId(session.permissionMode))),
      );
      return;
    }

    const permissionRequestId = `${this.#policy.agentId}-${session.id}-${String(requestId)}`;
    const toolCall = asObject(params.toolCall);
    const toolId = asString(toolCall.toolCallId ?? toolCall.callId ?? toolCall.id) ?? permissionRequestId;
    const context = this.#sessionUpdateContext(session);
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

    session.pendingPermissionIds.add(permissionRequestId);
    this.#pendingPermissions.set(permissionRequestId, {
      chatId: session.chatId,
      requestId,
      sessionId: session.id,
      responseForDecision: (decision) => {
        const fallback = decision.allow
          ? (decision.alwaysAllow ? 'allow-always' : 'allow-once')
          : 'reject-once';
        return permissionOutcome(permissionOptionId(options, fallback));
      },
      responseForCancellation: permissionCancelledOutcome,
    });
    this.emitMessages(session.chatId, [
      new PermissionRequestMessage(new Date().toISOString(), permissionRequestId, requestedTool),
    ], session.eventMetadata);
  }

  #onCustomBlockingRequest(
    session: AcpAgentRuntimeSession,
    requestId: AcpJsonRpcId,
    method: string,
    params: unknown,
  ): boolean {
    if (!this.#isCurrentSession(session) || !session.running) return false;
    const context = this.#sessionUpdateContext(session);
    const converted = this.#converter.customRequestToolUse?.({
      method,
      requestId,
      params,
    }, context) ?? null;
    if (!converted) return false;

    const permissionRequestId = `${this.#policy.agentId}-${session.id}-${String(requestId)}`;
    this.#registerBlockingRequest(session, permissionRequestId, requestId, converted);
    this.emitMessages(session.chatId, [
      new PermissionRequestMessage(new Date().toISOString(), permissionRequestId, converted.tool),
    ], session.eventMetadata);
    return true;
  }

  #registerBlockingRequest(
    session: AcpAgentRuntimeSession,
    permissionRequestId: string,
    requestId: AcpJsonRpcId,
    converted: AcpBlockingRequestToolUse,
  ): void {
    session.pendingPermissionIds.add(permissionRequestId);
    this.#pendingPermissions.set(permissionRequestId, {
      chatId: session.chatId,
      requestId,
      sessionId: session.id,
      responseForDecision: converted.responseForDecision,
      responseForCancellation: converted.responseForCancellation,
    });
  }

  #cancelPermissionsForSession(session: AcpAgentRuntimeSession, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    for (const permissionRequestId of session.pendingPermissionIds) {
      const pending = this.#pendingPermissions.get(permissionRequestId);
      if (!pending) continue;
      this.#pendingPermissions.delete(permissionRequestId);
      try {
        session.client.respond(pending.requestId, pending.responseForCancellation(reason));
      } catch {}
      this.emitMessages(session.chatId, [
        new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason),
      ], session.eventMetadata);
    }
    session.pendingPermissionIds.clear();
  }

  async #waitForUpdateQuietPeriod(session: AcpAgentRuntimeSession): Promise<void> {
    const quietMs = 125;
    const timeoutMs = 1_500;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (Date.now() - session.lastUpdateAt >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  #mappedModel(model: string): string | undefined {
    if (!model || model === 'default') return undefined;
    return this.#policy.mapModel ? this.#policy.mapModel(model) : model;
  }

  #newSessionModelForRequest(request: StartSessionRequest | ResumeTurnRequest): string | undefined {
    if (this.#policy.newSessionModelConfig === false) return undefined;
    return this.#mappedModel(request.model);
  }

  async #configureSession(
    session: AcpAgentRuntimeSession,
    request: StartSessionRequest | ResumeTurnRequest,
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

  #buildPrompt(request: StartSessionRequest | ResumeTurnRequest): Array<{ type: string; text?: string; [key: string]: unknown }> {
    const prompt = this.#policy.buildPrompt
      ? this.#policy.buildPrompt(request)
      : buildPromptFallback(request);
    return prompt.length > 0 ? prompt : buildPromptFallback(request);
  }

  #buildEnv(request: StartSessionRequest | ResumeTurnRequest): Record<string, string | undefined> {
    return this.#policy.buildEnv
      ? this.#policy.buildEnv(request)
      : buildEnvFallback(request);
  }

  #promptConfigForRequest(request: StartSessionRequest | ResumeTurnRequest): Record<string, unknown> | null {
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

  #isCurrentSession(session: AcpAgentRuntimeSession): boolean {
    return this.#sessions.get(session.id) === session;
  }

  #sessionUpdateContext(session: AcpAgentRuntimeSession): AcpSessionUpdateContext {
    return {
      chatId: session.chatId,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
    };
  }
}

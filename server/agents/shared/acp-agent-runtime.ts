import {
  ErrorMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  UnknownToolUseMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import type { PermissionDecisionPayload } from '../../../common/chat-command-contracts.js';
import { createArtificialNativePath } from '../../chats/artificial-native-path.js';
import { AgentEventEmitterRuntime } from './event-emitter-runtime.js';
import { normalizeToolInput } from './normalize-util.js';
import type { PermissionMode, AgentEventMetadata, AgentSessionSettingsPatch, PrepareProjectPathUpdateRequest, ResumeTurnRequest, StartSessionRequest, StartedAgentSession } from '../session-types.js';
import type { AgentRuntime } from '../types.js';
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
  #purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(policy: AcpAgentPolicy, options: AcpAgentRuntimeOptions) {
    super();
    this.#policy = policy;
    this.#converter = options.converter;
    this.#capabilityCache = options.capabilityCache ?? new AcpCapabilityCache();
    this.#createTransport = options.createTransport ?? (() => new AcpTransport());
  }

  async startSession(request: StartSessionRequest): Promise<StartedAgentSession> {
    const client = await this.#connectClient(request);
    const model = this.#newSessionModelForRequest(request);
    const created = await client.newSession({
      cwd: request.projectPath,
      mcpServers: this.#policy.mcpServers,
      ...(model ? { model } : {}),
    });

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
    };
    this.#sessions.set(sessionId, session);
    this.#bindClientEvents(session);
    this.emitSessionCreated(request.chatId);
    void this.#runPrompt(session, request).catch(() => {});

    return {
      agentSessionId: sessionId,
      nativePath: this.#nativePathFor(sessionId),
    };
  }

  async runTurn(request: ResumeTurnRequest): Promise<void> {
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
    ]);
  }

  updateSessionSettings(agentSessionId: string, patch: AgentSessionSettingsPatch): void {
    const session = this.#sessions.get(agentSessionId);
    if (!session) return;
    if (patch.permissionMode !== undefined) session.permissionMode = patch.permissionMode;
  }

  shutdown(): void {
    if (this.#purgeTimer) {
      clearInterval(this.#purgeTimer);
      this.#purgeTimer = null;
    }
    for (const session of this.#sessions.values()) {
      session.client.close();
    }
    this.#sessions.clear();
    this.#pendingPermissions.clear();
  }

  startPurgeTimer(): void {
    if (this.#purgeTimer) return;
    const maxIdleMs = 30 * 60 * 1000;
    this.#purgeTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.#sessions.entries()) {
        if (session.running) continue;
        if (now - session.lastActivityAt < maxIdleMs) continue;
        session.client.close();
        this.#sessions.delete(sessionId);
        this.#cancelPermissionsForSession(session, 'session-complete');
      }
    }, 5 * 60 * 1000);
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

  async #runPrompt(session: AcpAgentRuntimeSession, request: StartSessionRequest | ResumeTurnRequest): Promise<void> {
    const turnGeneration = ++session.turnGeneration;
    session.retired = false;
    session.running = true;
    session.state = 'running';
    session.aborted = false;
    session.permissionMode = request.permissionMode;
    session.chatId = request.chatId;
    session.projectPath = request.projectPath;
    session.lastActivityAt = Date.now();
    session.lastUpdateAt = Date.now();
    session.upstreamRequestId = undefined;
    this.#converter.beginTurn?.(session.id);
    this.emitProcessing(session.chatId, true);

    let success = false;
    let shouldThrow = false;
    let failureMessage = '';

    try {
      await this.#configureSession(session, request);
      const prompt = this.#buildPrompt(request);
      const promptConfig = this.#promptConfigForRequest(request);
      const result = await session.client.promptSession({
        sessionId: session.remoteSessionId,
        prompt,
        ...(promptConfig ? { config: promptConfig } : {}),
      });
      if (typeof result.requestId === 'string' && result.requestId) {
        session.upstreamRequestId = result.requestId;
      }
      await this.#waitForUpdateQuietPeriod(session);
      success = !session.aborted;
    } catch (error) {
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

      this.#emitFlushedMessages(session);
      this.emitProcessing(session.chatId, false);
      session.running = false;
      session.state = session.aborted ? 'aborted' : (failureMessage ? 'failed' : 'idle');
      session.lastActivityAt = Date.now();

      if (success) {
        const metadata = session.upstreamRequestId
          ? { upstreamRequestId: session.upstreamRequestId } satisfies AgentEventMetadata
          : undefined;
        this.emitFinished(session.chatId, 0, metadata);
      } else if (!session.aborted && failureMessage) {
        this.emitMessages(session.chatId, [
          new ErrorMessage(new Date().toISOString(), failureMessage),
        ]);
        this.emitFailed(session.chatId, failureMessage);
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
    this.emitMessages(session.chatId, messages);
  }

  #bindClientEvents(session: AcpAgentRuntimeSession): void {
    session.client.onRpcMessage((message) => {
      if (message.method === 'session/update') {
        this.#onSessionUpdate(message.params);
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
      if (!session.running) return;
      if (session.aborted) return;
      const message = `${this.#policy.agentId} ACP process exited with code ${exitCode}`;
      this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), message)]);
      this.emitProcessing(session.chatId, false);
      session.running = false;
      session.state = 'failed';
      session.lastActivityAt = Date.now();
      this.emitFailed(session.chatId, message);
      this.#cancelPermissionsForSession(session, 'cancelled');
    });

    session.client.onStderr((line) => {
      if (!session.running) return;
      if (!line.trim()) return;
      this.emitMessages(session.chatId, [new ErrorMessage(new Date().toISOString(), line)]);
    });
  }

  #onSessionUpdate(rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionUpdateNotification;
    const remoteSessionId = asString(params.sessionId);
    if (!remoteSessionId) return;
    const session = this.#sessionByRemoteId(remoteSessionId);
    if (!session || !session.running) return;

    session.lastUpdateAt = Date.now();
    session.lastActivityAt = Date.now();
    const upstreamRequestId = upstreamRequestIdFromUpdate(params);
    if (upstreamRequestId) {
      session.upstreamRequestId = upstreamRequestId;
    }
    const context = this.#sessionUpdateContext(session);
    const converted = this.#converter.fromSessionUpdate(params, context);
    const metadata = upstreamRequestId ? { upstreamRequestId } satisfies AgentEventMetadata : undefined;
    this.emitMessages(session.chatId, converted, metadata);
  }

  #onPermissionRequest(boundSession: AcpAgentRuntimeSession, requestId: AcpJsonRpcId, rawParams: unknown): void {
    const params = asObject(rawParams) as AcpSessionRequestPermission;
    const remoteSessionId = asString(params.sessionId);
    const session = remoteSessionId ? this.#sessionByRemoteId(remoteSessionId) : boundSession;
    if (!session || !session.running) return;

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
    ]);
  }

  #onCustomBlockingRequest(
    session: AcpAgentRuntimeSession,
    requestId: AcpJsonRpcId,
    method: string,
    params: unknown,
  ): boolean {
    if (!session.running) return false;
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
    ]);
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
      ]);
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

  #sessionByRemoteId(remoteSessionId: string): AcpAgentRuntimeSession | null {
    for (const session of this.#sessions.values()) {
      if (session.remoteSessionId === remoteSessionId) return session;
    }
    return null;
  }

  #sessionUpdateContext(session: AcpAgentRuntimeSession): AcpSessionUpdateContext {
    return {
      chatId: session.chatId,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
    };
  }
}

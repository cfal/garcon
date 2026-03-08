// OpenCode SDK integration. Extends AbsProvider so all output flows
// through typed events wired in the composition root.

import crypto from 'crypto';
import { normalizeToolResultContent } from '../chats/normalize.js';
import { AssistantMessage, ThinkingMessage, ToolResultMessage, ErrorMessage, PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from '../../common/chat-types.js';
import { convertOpenCodeToolUse } from './converters/opencode-tool-use.js';
import { AbsProvider } from './base.js';
import type { PermissionMode } from '../../common/chat-modes.js';
import type { StartSessionRequest, ResumeTurnRequest } from './types.js';

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
export const OPENCODE_PERMISSION_KEYS = Object.freeze([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const);

export function mapPermissionMode(mode: string): Array<{ permission: string; pattern: string; action: string }> {
  const map: Record<string, Record<string, string>> = {
    acceptEdits: { edit: 'allow', bash: 'ask', webfetch: 'allow' },
    bypassPermissions: Object.fromEntries(OPENCODE_PERMISSION_KEYS.map((permission) => [permission, 'allow'])),
    default: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  };

  const selected = map[mode] || map.default;

  return Object.entries(selected).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

function buildPromptBody(command: string, model: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: command }],
  };
  if (model && model.includes('/')) {
    const idx = model.indexOf('/');
    body.model = {
      providerID: model.slice(0, idx),
      modelID: model.slice(idx + 1),
    };
  }
  return body;
}

interface SSEEvent {
  type: string;
  properties?: Record<string, any>;
}

function extractSessionId(event: SSEEvent): string | undefined {
  const props = event.properties || {};
  return props.sessionID
    || props.part?.sessionID
    || props.info?.sessionID
    || (event.type?.startsWith('session.') ? props.info?.id : undefined);
}

function extractTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseOpenCodeModel(model: string | undefined): { providerID: string; modelID: string } | null {
  if (!model || typeof model !== 'string') return null;
  const idx = model.indexOf('/');
  if (idx < 1 || idx === model.length - 1) return null;
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
}

// Maps a permission decision to V2 reply value.
export function mapPermissionDecision(decision: { allow?: boolean; alwaysAllow?: boolean } | null | undefined): string {
  const allow = Boolean(decision?.allow);
  const alwaysAllow = Boolean(decision?.alwaysAllow);
  return allow ? (alwaysAllow ? 'always' : 'once') : 'reject';
}

// Extracts a normalized permission request from a V2 permission.asked event.
export function extractPermissionRequest(event: SSEEvent): {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionID: string | null;
} | null {
  if (event.type !== 'permission.asked') return null;

  const props = event.properties || {};
  const requestId = props.requestID || props.id;
  if (!requestId) return null;

  return {
    requestId: String(requestId),
    toolName: props.permission || 'Unknown',
    toolInput: {
      permission: props.permission || null,
      patterns: Array.isArray(props.patterns) ? props.patterns : [],
      metadata: props.metadata || {},
      always: Array.isArray(props.always) ? props.always : [],
      tool: props.tool || null,
    },
    sessionID: props.sessionID || null,
  };
}

interface OpenCodeSession {
  status: 'running' | 'completed' | 'aborted';
  chatId: string;
  model?: string;
  startedAt: string;
}

interface PendingTurnWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingPermission {
  originalRequestId: string;
  providerSessionId: string;
  chatId: string;
}

export class OpenCodeProvider extends AbsProvider {
  #client: any = null;
  #initPromise: Promise<any> | null = null;
  #sseListenerStarted = false;
  #sessions = new Map<string, OpenCodeSession>();
  #pendingTurnWaiters = new Map<string, PendingTurnWaiter>();
  #pendingPermissions = new Map<string, PendingPermission>();
  #messageRoles = new Map<string, Map<string, string>>();
  #assistantPartTypes = new Map<string, Map<string, string>>();

  constructor() {
    super();
  }

  #createTurnWaiter(providerSessionId: string): PendingTurnWaiter {
    if (this.#pendingTurnWaiters.has(providerSessionId)) {
      throw new Error(`Turn already in progress for session ${providerSessionId}`);
    }
    let resolveFn!: () => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const waiter: PendingTurnWaiter = { promise, resolve: resolveFn, reject: rejectFn };
    this.#pendingTurnWaiters.set(providerSessionId, waiter);
    return waiter;
  }

  #resolveTurnWaiter(providerSessionId: string): void {
    const waiter = this.#pendingTurnWaiters.get(providerSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(providerSessionId);
    waiter.resolve();
  }

  #rejectTurnWaiter(providerSessionId: string, error: unknown): void {
    const waiter = this.#pendingTurnWaiters.get(providerSessionId);
    if (!waiter) return;
    this.#pendingTurnWaiters.delete(providerSessionId);
    waiter.reject(error instanceof Error ? error : new Error(String(error || 'OpenCode turn failed')));
  }

  async #ensureOpenCodeServer(): Promise<any> {
    if (this.#client) return this.#client;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      try {
        const { createOpencode } = await import('@opencode-ai/sdk/v2');
        const port = 10000 + Math.floor(Math.random() * 50000);
        const result = await createOpencode({ timeout: 30000, port });

        if (!result?.client?.permission?.reply) {
          throw new Error('OpenCode v2 client missing permission.reply; aborting startup');
        }

        this.#client = result;
        return result;
      } catch (err) {
        this.#initPromise = null;
        throw err;
      }
    })();

    return this.#initPromise;
  }

  #convertOpenCodeEventToChatMessages(event: SSEEvent, chatId: string): unknown[] | undefined {
    const chatMessages: unknown[] = [];
    const now = new Date().toISOString();
    const props = event.properties || {};
    const roleFromEvent = (
      props.info?.role
      || props.part?.role
      || props.part?.snapshot?.role
      || props.message?.role
      || null
    );

    const assistantPartTypes = this.#assistantPartTypes.get(chatId) || new Map<string, string>();
    if (!this.#assistantPartTypes.has(chatId)) {
      this.#assistantPartTypes.set(chatId, assistantPartTypes);
    }
    const messageRoles = this.#messageRoles.get(chatId) || new Map<string, string>();
    if (!this.#messageRoles.has(chatId)) {
      this.#messageRoles.set(chatId, messageRoles);
    }

    switch (event.type) {
      case 'message.updated': {
        const info = props.info || {};
        const messageId = info.id;
        if (!messageId) {
          console.warn(`opencode: missing messageID for ${event.type}:`, event);
          return;
        }
        if (info.finish !== 'stop') {
          if (info.role && info.role !== 'user') {
            messageRoles.set(messageId, info.role);
          }
        } else {
          messageRoles.delete(messageId);
        }
        break;
      }

      case 'message.part.updated': {
        const part = props.part || {};
        if (!part.id) {
          console.warn(`opencode: missing partID for ${event.type}`);
          return;
        }

        const messageId = part.messageID;
        if (!messageId) {
          console.warn(`opencode: missing messageID for ${event.type}:`, event);
          return;
        }

        const messageRole = roleFromEvent || messageRoles.get(messageId) || null;
        if (!messageRole) {
          return;
        }

        if (part.type === 'tool') {
          if (part.state?.status === 'completed') {
            chatMessages.push(convertOpenCodeToolUse(now, part));
            chatMessages.push(new ToolResultMessage(now, part.callID || '', normalizeToolResultContent(part.state.output), false));
          } else if (part.state?.status === 'error') {
            chatMessages.push(new ErrorMessage(now, 'Tool Error: ' + (part.state.error || 'Unknown')));
          }
          break;
        }

        if (part.type === 'text' || part.type === 'reasoning') {
          assistantPartTypes.set(part.id, part.type);
        }

        if (part.text) {
          const partType = assistantPartTypes.get(part.id);
          if (!partType) {
            console.warn(`opencode: final text part not seen earlier:`, event);
            return;
          }
          assistantPartTypes.delete(part.id);

          if (partType === 'text') {
            chatMessages.push(new AssistantMessage(now, part.text));
          } else {
            chatMessages.push(new ThinkingMessage(now, part.text));
          }
        }
        break;
      }

      case 'message.part.delta':
        break;

      default:
        break;
    }

    return chatMessages;
  }

  #dispatchOpenCodeEvent(event: SSEEvent, chatId: string): void {
    const chatMessages = this.#convertOpenCodeEventToChatMessages(event, chatId);
    if (!chatMessages || !chatMessages.length) {
      return;
    }

    this.emitMessages(chatId, chatMessages);
  }

  #emitPermissionMessages(chatId: string, messages: unknown[]): void {
    if (!messages.length) return;
    this.emitMessages(chatId, messages);
  }

  #cancelPendingPermissionsForSession(providerSessionId: string, reason: 'cancelled' | 'session-complete' | 'aborted'): void {
    for (const [permissionRequestId, pending] of this.#pendingPermissions.entries()) {
      if (pending.providerSessionId !== providerSessionId) continue;
      this.#pendingPermissions.delete(permissionRequestId);
      this.#emitPermissionMessages(pending.chatId, [new PermissionCancelledMessage(new Date().toISOString(), permissionRequestId, reason)]);
    }
  }

  #extractPermissionRequestFromEvent(event: SSEEvent) {
    return extractPermissionRequest(event);
  }

  async #startGlobalSSEListener(): Promise<void> {
    if (this.#sseListenerStarted) return;
    this.#sseListenerStarted = true;

    const runListener = async () => {
      try {
        const client = await this.getClient();
        const result = await client.event.subscribe();

        for await (const event of result.stream) {
          const sessionId = extractSessionId(event);
          if (!sessionId) {
            if (event.type !== 'server.heartbeat') {
              console.debug('opencode: SSE event with no sessionId, type:', event.type);
            }
            continue;
          }

          const session = this.#sessions.get(sessionId);
          if (!session || session.status === 'aborted') {
            console.debug('opencode: SSE event for unknown/aborted session:', event.type, 'sid:', sessionId, 'known:', [...this.#sessions.keys()]);
            continue;
          }

          const chatId = session.chatId;
          if (!chatId) {
            console.debug('opencode: SSE event before chatId assigned:', event.type, 'sid:', sessionId);
            continue;
          }

          if (event.type === 'permission.asked') {
            const permission = this.#extractPermissionRequestFromEvent(event);
            if (!permission) continue;
            const permissionRequestId = `opencode-${crypto.randomBytes(8).toString('hex')}`;
            this.#pendingPermissions.set(permissionRequestId, {
              originalRequestId: permission.requestId,
              providerSessionId: sessionId,
              chatId,
            });

            this.#emitPermissionMessages(chatId, [new PermissionRequestMessage(new Date().toISOString(), permissionRequestId, permission.toolName, permission.toolInput)]);

            continue;
          }

          this.#dispatchOpenCodeEvent(event, chatId);

          if (event.type === 'session.status') {
            const status = event.properties?.status;
            if (status?.type === 'idle') {
              this.#cancelPendingPermissionsForSession(sessionId, 'session-complete');
              session.status = 'completed';
              this.#resolveTurnWaiter(sessionId);
              this.emitProcessing(chatId, false);
              this.emitFinished(chatId);
            }
          }
        }
      } catch (err: any) {
        for (const sessionId of this.#pendingTurnWaiters.keys()) {
          this.#rejectTurnWaiter(sessionId, err);
        }
        console.error('opencode: SSE listener error, reconnecting in 3s:', err.message);
        this.#sseListenerStarted = false;
        setTimeout(() => this.#startGlobalSSEListener(), 3000);
      }
    };

    runListener();
  }

  async getClient(): Promise<any> {
    const instance = await this.#ensureOpenCodeServer();
    return instance.client;
  }

  async getModels(): Promise<Array<{ value: string; label: string }>> {
    const client = await this.getClient();
    const result = await client.provider.list();
    const data = result.data;
    const allProviders: any[] = Array.isArray(data.all) ? data.all : [];
    const connected = new Set<string>(Array.isArray(data.connected) ? data.connected : []);

    const models: Array<{ value: string; label: string }> = [];
    for (const provider of allProviders) {
      const pid = provider.id || provider.name;
      if (!connected.has(pid)) continue;
      const providerModelsObj = provider.models || {};
      for (const [modelKey, model] of Object.entries(providerModelsObj)) {
        const m = model as any;
        models.push({
          value: `${provider.id || provider.name}/${m.id || modelKey}`,
          label: `${provider.name}: ${m.name || m.id || modelKey}`,
        });
      }
    }

    return models;
  }

  async startSession({
    command,
    chatId,
    images,
    model,
    permissionMode = 'default',
    projectPath,
    thinkingMode,
  }: StartSessionRequest): Promise<string> {
    void images;
    void projectPath;
    void thinkingMode;

    await this.#ensureOpenCodeServer();
    await this.#startGlobalSSEListener();

    const client = await this.getClient();
    const sessionResult = await client.session.create({
      permission: mapPermissionMode(permissionMode),
    });
    const providerSessionId: string = sessionResult.data.id;

    this.#sessions.set(providerSessionId, {
      status: 'running',
      chatId,
      model,
      startedAt: new Date().toISOString(),
    });
    this.emitProcessing(chatId, true);
    this.emitSessionCreated(chatId);
    console.log('opencode: session created and registered:', providerSessionId);

    const promptBody = buildPromptBody(command, model);

    client.session.promptAsync({
      sessionID: providerSessionId,
      ...promptBody,
    }).catch((err: Error) => {
      console.error(`opencode: prompt failed for session ${providerSessionId}:`, err.message);
      const sess = this.#sessions.get(providerSessionId);
      if (sess) sess.status = 'completed';
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message);
    });

    return providerSessionId;
  }

  async runTurn({
    command,
    providerSessionId,
    chatId,
    images,
    model,
    permissionMode,
    projectPath,
    thinkingMode,
  }: ResumeTurnRequest): Promise<void> {
    void images;
    void permissionMode;
    void projectPath;
    void thinkingMode;

    await this.#ensureOpenCodeServer();
    await this.#startGlobalSSEListener();

    const session = this.#sessions.get(providerSessionId);
    if (session) {
      session.status = 'running';
      session.chatId = chatId;
    } else {
      this.#sessions.set(providerSessionId, {
        status: 'running',
        chatId,
        model,
        startedAt: new Date().toISOString(),
      });
    }
    this.emitProcessing(chatId, true);

    const client = await this.getClient();
    const promptBody = buildPromptBody(command, model);
    const waiter = this.#createTurnWaiter(providerSessionId);

    try {
      await client.session.promptAsync({
        sessionID: providerSessionId,
        ...promptBody,
      });
    } catch (err: any) {
      console.error(`opencode: query failed for session ${providerSessionId}:`, err.message);
      const sess = this.#sessions.get(providerSessionId);
      if (sess) sess.status = 'completed';
      this.#rejectTurnWaiter(providerSessionId, err);
      this.emitProcessing(chatId, false);
      this.emitFailed(chatId, err.message);
      throw err;
    }

    await waiter.promise;
  }

  abort(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    if (!session) return false;

    session.status = 'aborted';
    this.#rejectTurnWaiter(providerSessionId, new Error('OpenCode session aborted'));
    this.#cancelPendingPermissionsForSession(providerSessionId, 'aborted');
    this.getClient().then((client: any) => {
      client.session.abort({ sessionID: providerSessionId }).catch((err: Error) => {
        console.warn(`opencode: failed to abort session ${providerSessionId}:`, err.message);
      });
    });
    return true;
  }

  isRunning(providerSessionId: string): boolean {
    const session = this.#sessions.get(providerSessionId);
    return session?.status === 'running';
  }

  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }> {
    return Array.from(this.#sessions.entries())
      .filter(([, session]) => session.status === 'running')
      .map(([id, session]) => ({ id, status: session.status, startedAt: session.startedAt }));
  }

  async resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void> {
    if (!permissionRequestId) return;
    const pending = this.#pendingPermissions.get(permissionRequestId);
    this.#pendingPermissions.delete(permissionRequestId);
    if (!pending) {
      console.warn('opencode: resolvePermission, no pending entry for', permissionRequestId, '(already resolved or cancelled)');
      return;
    }

    const allow = Boolean(decision?.allow);

    if (pending.chatId) {
      this.#emitPermissionMessages(pending.chatId, [new PermissionResolvedMessage(new Date().toISOString(), permissionRequestId, allow)]);
    }

    const reply = mapPermissionDecision(decision);

    const client = await this.getClient();
    await client.permission.reply({
      requestID: pending.originalRequestId,
      reply,
      message: allow ? undefined : 'User denied tool use',
    });
  }

  async runSingleQuery(prompt: string, options: Record<string, any> = {}): Promise<string> {
    const { cwd, projectPath, model, permissionMode = 'default' } = options;
    void cwd;
    void projectPath;
    const client = await this.getClient();

    const createResult = await client.session.create({
      permission: mapPermissionMode(permissionMode),
    });

    if (createResult.error || !createResult.data?.id) {
      throw new Error(createResult.error?.message || 'Failed to create OpenCode session');
    }

    const sessionId = createResult.data.id;

    try {
      const parsedModel = parseOpenCodeModel(model);
      const body: Record<string, unknown> = {
        parts: [{ type: 'text', text: prompt }],
        tools: { '*': false },
      };
      if (parsedModel) {
        body.model = parsedModel;
      }

      const promptResult = await client.session.prompt({
        sessionID: sessionId,
        ...body,
      });

      if (promptResult.error) {
        throw new Error(promptResult.error.message || 'OpenCode one-shot prompt failed');
      }

      return extractTextParts(promptResult.data?.parts);
    } finally {
      await client.session.delete({
        sessionID: sessionId,
      }).catch(() => {});
    }
  }

  startPurgeTimer(): ReturnType<typeof setInterval> {
    const maxAge = 30 * 60 * 1000;

    return setInterval(() => {
      const now = Date.now();

      for (const [id, session] of this.#sessions.entries()) {
        if (session.status !== 'running') {
          const startedAt = new Date(session.startedAt).getTime();
          if (now - startedAt > maxAge) {
            this.#sessions.delete(id);
          }
        }
      }
    }, 5 * 60 * 1000);
  }
}

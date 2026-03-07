// Unified provider registry. Routes all operations through the
// appropriate provider based on the chat registry entry. Also provides
// preview and message-loading methods so MetadataIndex and HistoryCache
// can resolve chat data without knowing per-provider details.

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { findCodexSessionFileBySessionId } from '../projects/codex.js';
import { runSingleQuery as runSingleQueryClaude } from './claude-cli.js';
import { runSingleQuery as runSingleQueryCodex } from './codex.js';
import { getClaudeAuthStatus } from './claude-auth.js';
import { getCodexAuthStatus } from './codex-auth.js';
import { getOpenCodeAuthStatus } from './opencode-auth.js';

// Stateless loaders and preview functions
import { getClaudePreviewFromNativePath, loadClaudeChatMessages } from './loaders/claude-history-loader.js';
import { getCodexPreviewFromNativePath, loadCodexChatMessages } from './loaders/codex-history-loader.js';
import { getOpenCodePreviewFromSessionId, loadOpenCodeChatMessages } from './loaders/opencode-history-loader.js';

import type { AgentCommandImage, PermissionMode } from '../../common/ws-requests.js';
import type {
  ProviderChatEntry,
  ProviderName,
  StartSessionRequest,
  ClaudeStartSessionRequest,
  ResumeTurnRequest,
} from './types.js';

// Encodes a project path into a safe directory name for Claude session storage.
function encodeProjectPath(projectPath: string): string {
  return String(projectPath || '').replace(/[\\/:\s~_]/g, '-');
}

function resolveClaudeNativePath(projectPath: string, providerSessionId: string): string | null {
  const projectName = encodeProjectPath(projectPath);
  if (!projectName || !providerSessionId) return null;
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    projectName,
    `${providerSessionId}.jsonl`,
  );
}

async function getAllProviderAuthStatus(opencode: OpenCodeProviderInstance): Promise<Record<string, unknown>> {
  const [claude, codex, opencodeStatus] = await Promise.all([
    getClaudeAuthStatus(),
    getCodexAuthStatus(),
    getOpenCodeAuthStatus(opencode),
  ]);

  return { claude, codex, opencode: opencodeStatus };
}

// Validates that a registry entry has all required execution fields.
function requireChatEntry(chatId: string, entry: ProviderChatEntry | null | undefined): ProviderChatEntry & {
  projectPath: string;
  model: string;
  permissionMode: PermissionMode;
  thinkingMode: string;
} {
  if (!entry) {
    throw new Error(`Session not initialized: ${chatId}`);
  }
  if (!entry.projectPath) {
    throw new Error(`Chat ${chatId} is missing projectPath`);
  }
  if (!entry.model) {
    throw new Error(`Chat ${chatId} is missing model`);
  }
  if (!entry.permissionMode) {
    throw new Error(`Chat ${chatId} is missing permissionMode`);
  }
  if (!entry.thinkingMode) {
    throw new Error(`Chat ${chatId} is missing thinkingMode`);
  }
  return entry as ProviderChatEntry & {
    projectPath: string;
    model: string;
    permissionMode: PermissionMode;
    thinkingMode: string;
  };
}

// Builds a fully-hydrated StartSessionRequest from registry + caller opts.
function hydrateStartSessionRequest(
  chatId: string,
  command: string,
  entry: { projectPath: string; model: string; permissionMode: PermissionMode; thinkingMode: string },
  opts: { images?: AgentCommandImage[]; modelReasoningEffort?: string },
): StartSessionRequest {
  return {
    chatId,
    command,
    projectPath: entry.projectPath,
    model: entry.model,
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
    modelReasoningEffort: opts.modelReasoningEffort,
    images: opts.images,
  };
}

// Builds a fully-hydrated ResumeTurnRequest, allowing runtime overrides.
function hydrateResumeTurnRequest(
  chatId: string,
  command: string,
  entry: { projectPath: string; providerSessionId: string; model: string; permissionMode: PermissionMode; thinkingMode: string },
  opts: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: string;
    modelReasoningEffort?: string;
  },
): ResumeTurnRequest {
  return {
    chatId,
    providerSessionId: entry.providerSessionId,
    command,
    projectPath: entry.projectPath,
    model: opts.model ?? entry.model,
    permissionMode: opts.permissionMode ?? entry.permissionMode,
    thinkingMode: opts.thinkingMode ?? entry.thinkingMode,
    modelReasoningEffort: opts.modelReasoningEffort,
    images: opts.images,
  };
}

interface ChatRegistry {
  getChat(chatId: string): ProviderChatEntry | null;
  getChatByProviderSessionId(id: string): [string, ProviderChatEntry] | null;
  updateChat(chatId: string, updates: Record<string, unknown>): void;
  listAllChats(): Record<string, ProviderChatEntry>;
}

interface ClaudeProviderInstance {
  startClaudeCliSession(request: ClaudeStartSessionRequest): Promise<string>;
  runClaudeTurn(request: ResumeTurnRequest): Promise<void>;
  isClaudeInternalSessionRunning(providerSessionId: string): boolean;
  abortClaudeInternalSession(providerSessionId: string): boolean;
  getRunningClaudeInternalSessions(): Array<{ id: string; status: string; startedAt: string }>;
  resolveInternalToolApproval(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void;
  setInternalPermissionMode(providerSessionId: string, mode: string): void;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

interface CodexProviderInstance {
  startSession(request: StartSessionRequest): Promise<string>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  isRunning(providerSessionId: string): boolean;
  abort(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

interface OpenCodeProviderInstance {
  startSession(request: StartSessionRequest): Promise<string>;
  runTurn(request: ResumeTurnRequest): Promise<void>;
  isRunning(providerSessionId: string): boolean;
  abort(providerSessionId: string): boolean;
  getRunningSessions(): Array<{ id: string; status: string; startedAt: string }>;
  getClient(): Promise<unknown>;
  getModels(): Promise<Array<{ value: string; label: string }>>;
  runSingleQuery(prompt: string, options?: Record<string, unknown>): Promise<string>;
  resolvePermission(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): Promise<void>;
  startPurgeTimer(): ReturnType<typeof setInterval>;
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void;
  onSessionCreated(cb: (chatId: string) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

export class ProviderRegistry {
  #registry: ChatRegistry;
  #claude: ClaudeProviderInstance;
  #codex: CodexProviderInstance;
  #opencode: OpenCodeProviderInstance;

  constructor(
    registry: ChatRegistry,
    claude: ClaudeProviderInstance,
    codex: CodexProviderInstance,
    opencode: OpenCodeProviderInstance,
  ) {
    this.#registry = registry;
    this.#claude = claude;
    this.#codex = codex;
    this.#opencode = opencode;
  }

  // Starts a new provider session. The chat registry entry must already
  // exist (created by the route handler with providerSessionId=null).
  async startSession(chatId: string, command: string, opts: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: string;
    modelReasoningEffort?: string;
    projectPath?: string;
  } = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);
    const entry = requireChatEntry(chatId, rawEntry);
    const request = hydrateStartSessionRequest(chatId, command, entry, opts);

    if (entry.provider === 'claude') {
      const providerSessionId = crypto.randomUUID();
      const nativePath = resolveClaudeNativePath(entry.projectPath, providerSessionId);
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });

      const claudeRequest: ClaudeStartSessionRequest = {
        ...request,
        providerSessionId,
      };

      this.#claude.startClaudeCliSession(claudeRequest).catch((error: Error) => {
        console.error(`providers: claude start failed for chat ${chatId}:`, error.message);
      });
      return;
    }

    if (entry.provider === 'codex') {
      const providerSessionId = await this.#codex.startSession(request);
      const nativePath = await findCodexSessionFileBySessionId(providerSessionId);
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });
      return;
    }

    if (entry.provider === 'opencode') {
      const providerSessionId = await this.#opencode.startSession(request);
      const nativePath = `opencode:${providerSessionId}`;
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });
      return;
    }

    throw new Error(`Unsupported provider: ${entry.provider}`);
  }

  // Resumes an existing session via the appropriate provider.
  async runProviderTurn(chatId: string, command: string, opts: {
    images?: AgentCommandImage[];
    model?: string;
    permissionMode?: PermissionMode;
    thinkingMode?: string;
    modelReasoningEffort?: string;
  } = {}): Promise<void> {
    const rawEntry = this.#registry.getChat(chatId);
    if (!rawEntry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { provider, providerSessionId } = rawEntry;
    if (!providerSessionId) {
      throw new Error(`Session missing provider session ID: ${chatId}`);
    }

    const entry = requireChatEntry(chatId, rawEntry);
    const request = hydrateResumeTurnRequest(chatId, command, {
      ...entry,
      providerSessionId,
    }, opts);

    if (provider === 'claude') {
      await this.#claude.runClaudeTurn(request);
    } else if (provider === 'codex') {
      await this.#codex.runTurn(request);
    } else if (provider === 'opencode') {
      await this.#opencode.runTurn(request);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async abortSession(chatId: string): Promise<boolean> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId) return false;

    if (entry.provider === 'claude') {
      if (this.#claude.isClaudeInternalSessionRunning(providerSessionId)) {
        return this.#claude.abortClaudeInternalSession(providerSessionId);
      }
      return false;
    }

    if (entry.provider === 'codex') {
      return this.#codex.abort(providerSessionId);
    }

    if (entry.provider === 'opencode') {
      return this.#opencode.abort(providerSessionId);
    }

    return false;
  }

  isChatRunning(chatId: string): boolean {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return false;
    return this.isProviderSessionRunning(entry.provider, entry.providerSessionId);
  }

  isProviderSessionRunning(provider: ProviderName, providerSessionId: string | null | undefined): boolean {
    if (!providerSessionId) return false;
    if (provider === 'claude') return this.#claude.isClaudeInternalSessionRunning(providerSessionId);
    if (provider === 'codex') return this.#codex.isRunning(providerSessionId);
    if (provider === 'opencode') return this.#opencode.isRunning(providerSessionId);
    return false;
  }

  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>> {
    const mapToChatId = (arr: Array<{ id: string; [key: string]: unknown }>) =>
      arr
        .map((e) => (typeof e === 'string' ? { id: e } : e))
        .map((e) => {
          const match = e?.id ? this.#registry.getChatByProviderSessionId(e.id) : null;
          const mapped = match ? match[0] : null;
          return mapped ? { ...e, id: mapped } : null;
        })
        .filter((e): e is NonNullable<typeof e> => Boolean(e));

    return {
      claude: mapToChatId(this.#claude.getRunningClaudeInternalSessions()),
      codex: mapToChatId(this.#codex.getRunningSessions()),
      opencode: mapToChatId(this.#opencode.getRunningSessions()),
    };
  }

  // Routes a tool-approval decision to the correct provider.
  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
    if (!chatId || !permissionRequestId) return;

    const chat = this.#registry.getChat(chatId);
    if (!chat) {
      console.warn('providers: resolvePermission, unknown chatId:', chatId);
      return;
    }

    if (chat.provider === 'claude') {
      this.#claude.resolveInternalToolApproval(permissionRequestId, decision);
      return;
    }

    if (chat.provider === 'opencode') {
      this.#opencode.resolvePermission(permissionRequestId, decision).catch((err: Error) => {
        console.warn('providers: opencode permission reply failed:', err.message);
      });
      return;
    }

    console.warn('providers: no permission handler for provider:', chat.provider);
  }

  async setPermissionMode(chatId: string, mode: string): Promise<void> {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId || entry.provider !== 'claude') return;
    this.#claude.setInternalPermissionMode(providerSessionId, mode);
  }

  // Model changes are applied on the next CLI spawn; no-op here.
  async setModel(_chatId: string, _model: string): Promise<void> {}

  // Runs a one-shot query against the specified provider.
  async runSingleQuery(prompt: string, options: { provider?: string; [key: string]: unknown } = {}): Promise<string> {
    const { provider = 'claude', ...rest } = options;
    if (provider === 'codex') return runSingleQueryCodex(prompt, rest);
    if (provider === 'opencode') return this.#opencode.runSingleQuery(prompt, rest);
    return runSingleQueryClaude(prompt, rest);
  }

  // Returns preview metadata for a session (createdAt, lastMessage, etc.).
  async getPreview(session: ProviderChatEntry | null): Promise<unknown> {
    if (!session?.provider) return null;

    if (session.provider === 'opencode') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('opencode:', '');
      const getClient = () => this.#opencode.getClient();
      return getOpenCodePreviewFromSessionId(sessionId, getClient);
    }
    if (session.provider === 'claude') {
      return getClaudePreviewFromNativePath(session.nativePath);
    }
    if (session.provider === 'codex') {
      return getCodexPreviewFromNativePath(session.nativePath);
    }

    return null;
  }

  // Loads full message history for a session.
  async loadMessages(session: ProviderChatEntry | null): Promise<unknown[]> {
    if (!session?.provider) return [];

    if (session.provider === 'opencode') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('opencode:', '');
      const getClient = () => this.#opencode.getClient();
      return loadOpenCodeChatMessages(sessionId, getClient);
    }
    if (session.provider === 'claude') {
      return loadClaudeChatMessages(session.nativePath);
    }
    if (session.provider === 'codex') {
      return loadCodexChatMessages(session.nativePath);
    }

    return [];
  }

  // Fetches available models for a provider.
  async getModels(provider: ProviderName): Promise<Array<{ value: string; label: string }>> {
    if (provider === 'opencode') return this.#opencode.getModels();
    return [];
  }

  // Returns current auth status for all providers.
  async getAuthStatusMap(): Promise<Record<string, unknown>> {
    return getAllProviderAuthStatus(this.#opencode);
  }

  // Starts purge timers on providers that maintain session maps.
  startPurgeTimers(): void {
    this.#codex.startPurgeTimer();
    this.#opencode.startPurgeTimer();
  }

  // Fan-out listener helpers. Registers the callback on all three
  // providers so callers don't need to know the individual instances.

  onMessages(cb: (chatId: string, messages: unknown[]) => void): void {
    this.#claude.onMessages(cb);
    this.#codex.onMessages(cb);
    this.#opencode.onMessages(cb);
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    this.#claude.onProcessing(cb);
    this.#codex.onProcessing(cb);
    this.#opencode.onProcessing(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#claude.onSessionCreated(cb);
    this.#codex.onSessionCreated(cb);
    this.#opencode.onSessionCreated(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number) => void): void {
    this.#claude.onFinished(cb);
    this.#codex.onFinished(cb);
    this.#opencode.onFinished(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string) => void): void {
    this.#claude.onFailed(cb);
    this.#codex.onFailed(cb);
    this.#opencode.onFailed(cb);
  }
}

export { encodeProjectPath };

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

function encodeProjectPath(projectPath) {
  return String(projectPath || '').replace(/[\\/:\s~_]/g, '-');
}

function resolveClaudeNativePath(projectPath, providerSessionId) {
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

async function getAllProviderAuthStatus(opencode) {
  const [claude, codex, opencodeStatus] = await Promise.all([
    getClaudeAuthStatus(),
    getCodexAuthStatus(),
    getOpenCodeAuthStatus(opencode),
  ]);

  return { claude, codex, opencode: opencodeStatus };
}

export class ProviderRegistry {
  #registry;
  #claude;
  #codex;
  #opencode;

  // registry: ChatRegistry
  // claude: ClaudeProvider
  // codex: CodexProvider
  // opencode: OpenCodeProvider
  constructor(registry, claude, codex, opencode) {
    this.#registry = registry;
    this.#claude = claude;
    this.#codex = codex;
    this.#opencode = opencode;
  }

  // Starts a new provider session. The chat registry entry must already
  // exist (created by the route handler with providerSessionId=null).
  async startSession(chatId, command, opts = {}) {
    const entry = this.#registry.getChat(chatId);
    if (!entry) {
      throw new Error(`Session not initialized: ${chatId}`);
    }

    const { provider, projectPath } = entry;
    const mergedOpts = {
      ...opts,
      model: opts.model ?? entry.model ?? undefined,
      permissionMode: opts.permissionMode ?? entry.permissionMode ?? undefined,
      thinkingMode: opts.thinkingMode ?? entry.thinkingMode ?? undefined,
    };

    if (provider === 'claude') {
      const providerSessionId = crypto.randomUUID();
      const nativePath = resolveClaudeNativePath(projectPath, providerSessionId);
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });

      this.#claude.startClaudeInternalSession(command, {
        ...mergedOpts,
        sessionId: providerSessionId,
        chatId,
        cwd: mergedOpts.cwd || projectPath,
      }).catch((error) => {
        console.error(`providers: claude start failed for chat ${chatId}:`, error.message);
      });
      return;
    }

    if (provider === 'codex') {
      const providerSessionId = await this.#codex.startSession(command, {
        ...mergedOpts,
        sessionId: null,
        chatId,
        cwd: mergedOpts.cwd || projectPath,
      });
      const nativePath = await findCodexSessionFileBySessionId(providerSessionId);
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });
      return;
    }

    if (provider === 'opencode') {
      const providerSessionId = await this.#opencode.startSession(command, {
        ...mergedOpts,
        chatId,
        cwd: mergedOpts.cwd || projectPath,
      });
      const nativePath = `opencode:${providerSessionId}`;
      this.#registry.updateChat(chatId, { providerSessionId, nativePath });
      return;
    }

    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Resumes an existing session via the appropriate provider.
  async runProviderTurn(chatId, command, opts = {}) {
    const entry = this.#registry.getChat(chatId);
    if (!entry) {
      throw new Error(`Session not initialized: ${chatId}. Call /api/chats/start first.`);
    }

    const { provider, model, permissionMode, thinkingMode, providerSessionId } = entry;
    if (!providerSessionId) {
      throw new Error(`Session missing provider session ID: ${chatId}`);
    }

    const mergedOpts = {
      ...opts,
      model: opts.model ?? model ?? undefined,
      permissionMode: opts.permissionMode ?? permissionMode ?? undefined,
      thinkingMode: opts.thinkingMode ?? thinkingMode ?? undefined,
    };

    if (provider === 'claude') {
      await this.#claude.runClaudeTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else if (provider === 'codex') {
      await this.#codex.runTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else if (provider === 'opencode') {
      await this.#opencode.runTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async abortSession(chatId) {
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

  isChatRunning(chatId) {
    const entry = this.#registry.getChat(chatId);
    if (!entry) return false;
    return this.isProviderSessionRunning(entry.provider, entry.providerSessionId);
  }

  isProviderSessionRunning(provider, providerSessionId) {
    if (!providerSessionId) return false;
    if (provider === 'claude') return this.#claude.isClaudeInternalSessionRunning(providerSessionId);
    if (provider === 'codex') return this.#codex.isRunning(providerSessionId);
    if (provider === 'opencode') return this.#opencode.isRunning(providerSessionId);
    return false;
  }

  getRunningSessions() {
    const mapToChatId = (arr) =>
      arr
        .map((e) => (typeof e === 'string' ? { id: e } : e))
        .map((e) => {
          const match = e?.id ? this.#registry.getChatByProviderSessionId(e.id) : null;
          const mapped = match ? match[0] : null;
          return mapped ? { ...e, id: mapped } : null;
        })
        .filter(Boolean);

    return {
      claude: mapToChatId(this.#claude.getRunningClaudeInternalSessions()),
      codex: mapToChatId(this.#codex.getRunningSessions()),
      opencode: mapToChatId(this.#opencode.getRunningSessions()),
    };
  }

  // Routes a tool-approval decision to the correct provider.
  resolvePermission(chatId, permissionRequestId, decision) {
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
      this.#opencode.resolvePermission(permissionRequestId, decision).catch((err) => {
        console.warn('providers: opencode permission reply failed:', err.message);
      });
      return;
    }

    console.warn('providers: no permission handler for provider:', chat.provider);
  }

  async setPermissionMode(chatId, mode) {
    const entry = this.#registry.getChat(chatId);
    const providerSessionId = entry?.providerSessionId;
    if (!providerSessionId || entry.provider !== 'claude') return;
    this.#claude.setInternalPermissionMode(providerSessionId, mode);
  }

  // Model changes are applied on the next CLI spawn; no-op here.
  async setModel(chatId, model) {}

  // Runs a one-shot query against the specified provider.
  async runSingleQuery(prompt, options = {}) {
    const { provider = 'claude', ...rest } = options;
    if (provider === 'codex') return runSingleQueryCodex(prompt, rest);
    if (provider === 'opencode') return this.#opencode.runSingleQuery(prompt, rest);
    return runSingleQueryClaude(prompt, rest);
  }

  // Returns preview metadata for a session (createdAt, lastMessage, etc.).
  // Used by MetadataIndex during init.
  async getPreview(session) {
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

  // Loads full message history for a session. Used by HistoryCache
  // for on-demand loading.
  async loadMessages(session) {
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
  async getModels(provider) {
    if (provider === 'opencode') return this.#opencode.getModels();
    return [];
  }

  // Returns current auth status for all providers.
  async getAuthStatusMap() {
    return getAllProviderAuthStatus(this.#opencode);
  }

  // Starts purge timers on providers that maintain session maps.
  startPurgeTimers() {
    this.#codex.startPurgeTimer();
    this.#opencode.startPurgeTimer();
  }

  // Fan-out listener helpers. Registers the callback on all three
  // providers so callers don't need to know the individual instances.

  onMessages(cb) {
    this.#claude.onMessages(cb);
    this.#codex.onMessages(cb);
    this.#opencode.onMessages(cb);
  }

  onProcessing(cb) {
    this.#claude.onProcessing(cb);
    this.#codex.onProcessing(cb);
    this.#opencode.onProcessing(cb);
  }

  onSessionCreated(cb) {
    this.#claude.onSessionCreated(cb);
    this.#codex.onSessionCreated(cb);
    this.#opencode.onSessionCreated(cb);
  }

  onFinished(cb) {
    this.#claude.onFinished(cb);
    this.#codex.onFinished(cb);
    this.#opencode.onFinished(cb);
  }

  onFailed(cb) {
    this.#claude.onFailed(cb);
    this.#codex.onFailed(cb);
    this.#opencode.onFailed(cb);
  }
}

export { encodeProjectPath };

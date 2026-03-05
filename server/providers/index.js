// Unified provider registry. Routes all operations through the
// appropriate provider based on the chat registry entry. Also provides
// preview and message-loading methods so MetadataIndex and HistoryCache
// can resolve chat data without knowing per-provider details.

import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { findCodexSessionFileBySessionId, getCodexSessionMeta } from '../projects/codex.js';
import { runSingleQuery as runSingleQueryClaude } from './claude-cli.js';
import { runSingleQuery as runSingleQueryCodex } from './codex.js';
import { runSingleQuery as runSingleQueryAmp } from './amp.js';

// Stateless loaders and preview functions
import { getClaudePreviewFromNativePath, loadClaudeChatMessages } from './loaders/claude-history-loader.js';
import { getCodexPreviewFromNativePath, loadCodexChatMessages } from './loaders/codex-history-loader.js';
import { getOpenCodePreviewFromSessionId, loadOpenCodeChatMessages } from './loaders/opencode-history-loader.js';
import { getAmpPreviewFromSessionId, loadAmpChatMessages } from './loaders/amp-history-loader.js';

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

// Recovers missing providerSessionId for legacy registry entries.
async function recoverProviderSessionId(entry) {
  if (!entry?.nativePath) return null;

  if (entry.provider === 'claude') {
    return path.basename(entry.nativePath, '.jsonl') || null;
  }

  if (entry.provider === 'opencode') {
    if (entry.nativePath.startsWith('opencode:')) {
      return entry.nativePath.slice('opencode:'.length) || null;
    }
    return null;
  }

  if (entry.provider === 'codex') {
    const meta = await getCodexSessionMeta(entry.nativePath).catch(() => null);
    return meta?.id || null;
  }

  if (entry.provider === 'amp') {
    if (entry.nativePath.startsWith('amp:')) {
      return entry.nativePath.slice('amp:'.length) || null;
    }
    return path.basename(entry.nativePath, '.json') || null;
  }

  return null;
}

export class ProviderRegistry {
  #registry;
  #claude;
  #codex;
  #opencode;
  #amp;

  // registry: ChatRegistry
  // claude: ClaudeProvider
  // codex: CodexProvider
  // opencode: OpenCodeProvider
  // amp: AmpProvider
  constructor(registry, claude, codex, opencode, amp) {
    this.#registry = registry;
    this.#claude = claude;
    this.#codex = codex;
    this.#opencode = opencode;
    this.#amp = amp;
  }

  // Starts a new provider session. The chat registry entry must already
  // exist (created by the route handler with providerSessionId=null).
  async startSession(chatId, command, opts = {}) {
    const entry = this.#registry.getChat(chatId);
    if (!entry) {
      throw new Error(`Session not initialized: ${chatId}`);
    }

    const { provider, projectPath } = entry;
    const mergedOpts = { ...opts, model: entry.model || undefined };

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

    if (provider === 'amp') {
      const providerSessionId = await this.#amp.startSession(command, {
        ...mergedOpts,
        chatId,
        cwd: mergedOpts.cwd || projectPath,
      });
      const nativePath = `amp:${providerSessionId}`;
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

    const { provider, model, providerSessionId } = entry;
    if (!providerSessionId) {
      throw new Error(`Session missing provider session ID: ${chatId}`);
    }

    const mergedOpts = { ...opts, model };

    if (provider === 'claude') {
      await this.#claude.runClaudeTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else if (provider === 'codex') {
      await this.#codex.runTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else if (provider === 'opencode') {
      await this.#opencode.runTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
    } else if (provider === 'amp') {
      await this.#amp.runTurn(command, { ...mergedOpts, sessionId: providerSessionId, chatId });
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

    if (entry.provider === 'amp') {
      return this.#amp.abort(providerSessionId);
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
    if (provider === 'amp') return this.#amp.isRunning(providerSessionId);
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
      amp: mapToChatId(this.#amp.getRunningSessions()),
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
    if (provider === 'amp') return runSingleQueryAmp(prompt, rest);
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
    if (session.provider === 'amp') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('amp:', '');
      return getAmpPreviewFromSessionId(sessionId);
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
    if (session.provider === 'amp') {
      const sessionId = session.providerSessionId || session.nativePath?.replace('amp:', '');
      return loadAmpChatMessages(sessionId);
    }

    return [];
  }

  // Fetches available models for a provider.
  async getModels(provider) {
    if (provider === 'opencode') return this.#opencode.getModels();
    return [];
  }

  // Starts purge timers on providers that maintain session maps.
  startPurgeTimers() {
    this.#codex.startPurgeTimer();
    this.#opencode.startPurgeTimer();
    this.#amp.startPurgeTimer();
  }

  // Fan-out listener helpers. Registers the callback on all providers
  // providers so callers don't need to know the individual instances.

  onMessages(cb) {
    this.#claude.onMessages(cb);
    this.#codex.onMessages(cb);
    this.#opencode.onMessages(cb);
    this.#amp.onMessages(cb);
  }

  onProcessing(cb) {
    this.#claude.onProcessing(cb);
    this.#codex.onProcessing(cb);
    this.#opencode.onProcessing(cb);
    this.#amp.onProcessing(cb);
  }

  onSessionCreated(cb) {
    this.#claude.onSessionCreated(cb);
    this.#codex.onSessionCreated(cb);
    this.#opencode.onSessionCreated(cb);
    this.#amp.onSessionCreated(cb);
  }

  onFinished(cb) {
    this.#claude.onFinished(cb);
    this.#codex.onFinished(cb);
    this.#opencode.onFinished(cb);
    this.#amp.onFinished(cb);
  }

  onFailed(cb) {
    this.#claude.onFailed(cb);
    this.#codex.onFailed(cb);
    this.#opencode.onFailed(cb);
    this.#amp.onFailed(cb);
  }
}

export { encodeProjectPath, recoverProviderSessionId };

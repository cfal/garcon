import type { ProviderAdapter } from './provider-adapter.js';
import type { HarnessAuthDriver, HarnessCapabilityDriver, HarnessPlugin, HarnessTranscriptSource, SupportedHarnessProtocol } from './harness-plugin.js';
import type { ProviderChatEntry } from './types.js';
import type { ChatMessage } from '../../common/chat-types.js';

interface AdapterHarnessPluginOptions {
  auth: HarnessAuthDriver;
  capabilities: HarnessCapabilityDriver;
  transcript?: HarnessTranscriptSource;
}

const EMPTY_TRANSCRIPT: HarnessTranscriptSource = {
  async loadMessages(): Promise<ChatMessage[]> {
    return [];
  },
  async getPreview(): Promise<unknown> {
    return null;
  },
};

function defaultTranscript(adapter: ProviderAdapter): HarnessTranscriptSource {
  if (!adapter.loadMessages && !adapter.getPreview) return EMPTY_TRANSCRIPT;
  return {
    async loadMessages(session: ProviderChatEntry, context?: { chatId?: string }): Promise<ChatMessage[]> {
      if (!adapter.loadMessages) return [];
      return adapter.loadMessages(session, context) as Promise<ChatMessage[]>;
    },
    async getPreview(session: ProviderChatEntry): Promise<unknown> {
      if (!adapter.getPreview) return null;
      return adapter.getPreview(session);
    },
  };
}

export function createHarnessCapabilities(input: {
  supportsFork?: boolean;
  supportsImages?: boolean;
  acceptsApiProviderEndpoints?: boolean;
  supportedProtocols?: SupportedHarnessProtocol[];
  authLoginSupported?: boolean;
  getModels?: HarnessCapabilityDriver['getModels'];
} = {}): HarnessCapabilityDriver {
  return {
    supportsFork: input.supportsFork ?? false,
    supportsImages: input.supportsImages ?? false,
    acceptsApiProviderEndpoints: input.acceptsApiProviderEndpoints ?? false,
    supportedProtocols: input.supportedProtocols ?? [],
    authLoginSupported: input.authLoginSupported ?? false,
    ...(input.getModels ? { getModels: input.getModels } : {}),
  };
}

export function adapterToHarnessPlugin(
  adapter: ProviderAdapter,
  options: AdapterHarnessPluginOptions,
): HarnessPlugin {
  return {
    id: adapter.id,
    label: adapter.label,
    runtime: {
      startSession: (request) => adapter.startSession(request),
      runTurn: (request) => adapter.runTurn(request),
      abort: (providerSessionId) => adapter.abort(providerSessionId),
      isRunning: (providerSessionId) => adapter.isRunning(providerSessionId),
      getRunningSessions: () => adapter.getRunningSessions(),
      resolvePermission: adapter.resolvePermission
        ? (permissionRequestId, decision) => adapter.resolvePermission?.(permissionRequestId, decision)
        : undefined,
      shutdown: adapter.shutdown ? () => adapter.shutdown?.() : undefined,
      startPurgeTimer: adapter.startPurgeTimer ? () => adapter.startPurgeTimer?.() : undefined,
      onMessages: (cb) => adapter.onMessages((chatId, messages, metadata) => cb(chatId, messages as ChatMessage[], metadata)),
      onProcessing: (cb) => adapter.onProcessing(cb),
      onSessionCreated: (cb) => adapter.onSessionCreated(cb),
      onFinished: (cb) => adapter.onFinished(cb),
      onFailed: (cb) => adapter.onFailed(cb),
    },
    transcript: options.transcript ?? defaultTranscript(adapter),
    auth: options.auth,
    capabilities: options.capabilities,
    forkSession: adapter.forkSession
      ? (args) => adapter.forkSession?.(args)
      : undefined,
    runSingleQuery: adapter.runSingleQuery
      ? (prompt, runOptions) => adapter.runSingleQuery?.(prompt, runOptions)
      : undefined,
  };
}

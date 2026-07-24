import {
  AgentIntegrationError,
  computeAgentTranscriptRevision,
  type AgentLogger,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { CodexConfig } from '../../config.js';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { inspectCodexHistoryProfile } from './history-profile.js';
import { resolveCodexNativePath } from './native-path.js';

type CodexTranscriptRuntime = Pick<
  CodexAppServerRuntime,
  | 'getPreview'
  | 'loadMessagePage'
  | 'loadMessages'
  | 'requestNativePathDiscoveryRefresh'
  | 'resolveNativePath'
>;

export function createCodexTranscript(
  runtime: CodexTranscriptRuntime,
  nativeSessions: PathNativeSessionCodec,
  config: CodexConfig,
  logger: AgentLogger,
): AgentTranscript {
  const reference = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => {
    const native = nativeSessions.decode(chat.nativeSession);
    return {
      projectPath: chat.projectPath,
      model: chat.model,
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      nativePath: native.path,
    };
  };
  const resolvePath = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => {
    const value = reference(chat);
    return resolveCodexNativePath(
      {
        agentSessionId: value.agentSessionId,
        nativePath: value.nativePath,
      },
      {
        discover: () => runtime.resolveNativePath(value),
        logger,
        signal,
      },
    );
  };
  const resolvedReference = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => {
    const value = reference(chat);
    const nativePath = await resolvePath(chat, signal);
    if (value.agentSessionId && !nativePath) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Codex native transcript could not be resolved',
        true,
        {
          provider: 'codex',
          agentSessionId: value.agentSessionId,
          reason: 'not-found',
        },
      );
    }
    return { ...value, nativePath };
  };
  const retryableReference = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => {
    const value = reference(chat);
    try {
      return await resolvedReference(chat, signal);
    } catch (error) {
      if (
        error instanceof AgentIntegrationError &&
        error.code === 'TRANSCRIPT_UNAVAILABLE' &&
        error.details?.reason === 'not-found' &&
        value.agentSessionId
      ) {
        runtime.requestNativePathDiscoveryRefresh(value.agentSessionId);
      }
      throw error;
    }
  };
  const loadMessages = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => runtime.loadMessages(await resolvedReference(chat, signal), signal);
  const loadRetryableMessages = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => runtime.loadMessages(await retryableReference(chat, signal), signal);
  const resolveIndexSource = async (
    chat: Parameters<AgentTranscript['load']>[0]['chat'],
    signal: AbortSignal,
  ) => {
    const nativePath = await resolvePath(chat, signal);
    if (!nativePath) return null;
    const value = reference(chat);
    const profile = await inspectCodexHistoryProfile({
      nativePath,
      expectedThreadId: value.agentSessionId,
      signal,
    });
    return {
      ownerId: 'codex',
      schemaVersion: 2,
      value: {
        nativePath,
        threadId: profile.threadId,
        historyMode: profile.mode,
        codexHome: config.home(),
      },
    } as const;
  };
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const current = nativeSessions.decode(chat.nativeSession);
      const agentSessionId = chat.agentSessionId ?? current.agentSessionId;
      if (!agentSessionId) return null;
      const nativePath = await resolvePath(chat, signal);
      if (!nativePath) {
        if (
          chat.nativeSession &&
          !current.path &&
          current.agentSessionId === agentSessionId
        ) {
          return chat.nativeSession;
        }
        return null;
      }
      if (current.path === nativePath && chat.nativeSession) {
        return chat.nativeSession;
      }
      return nativeSessions.encode({
        path: nativePath,
        agentSessionId,
        modelEndpointId: current.modelEndpointId,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadRetryableMessages(chat, signal);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async loadPage({ chat, page, signal }) {
      signal.throwIfAborted();
      return runtime.loadMessagePage(await retryableReference(chat, signal), page, signal);
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      return normalizeCodexPreview(
        await runtime.getPreview(await resolvedReference(chat, signal), signal),
      );
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat, signal));
    },
    async resolveIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat, signal);
    },
    async refreshIndexSource({ chat, signal }) {
      signal.throwIfAborted();
      return resolveIndexSource(chat, signal);
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await resolvePath(chat, signal);
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
    },
    async release({ signal }) {
      signal.throwIfAborted();
    },
  };
}

function normalizeCodexPreview(value: unknown) {
  const preview =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!preview || typeof preview.firstMessage !== 'string') return null;
  return {
    firstMessage: preview.firstMessage,
    lastMessage:
      typeof preview.lastMessage === 'string' ? preview.lastMessage : preview.firstMessage,
    createdAt: typeof preview.createdAt === 'string' ? preview.createdAt : null,
    lastActivity: typeof preview.lastActivity === 'string' ? preview.lastActivity : null,
  };
}

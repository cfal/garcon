import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '@garcon/server-agent-common/native-session/evidence-source';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { CodexAppServerRuntime } from './app-server/runtime.js';
import { resolveCodexNativePath } from './native-path.js';

type CodexTranscriptRuntime = Pick<
  CodexAppServerRuntime,
  'loadMessages' | 'requestNativePathDiscoveryRefresh' | 'resolveNativePath'
>;

export function createCodexNativeEvidence(
  runtime: CodexTranscriptRuntime,
  nativeSessions: PathNativeSessionCodec,
  logger: AgentLogger,
): AgentNativeEvidenceSource & {
  readonly loadLegacy: AgentNativeEvidenceSource['load'];
} {
  const reference = (chat: AgentChatReference) => {
    const native = nativeSessions.decode(chat.nativeSession);
    return {
      projectPath: chat.projectPath,
      model: chat.model,
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      nativePath: native.path,
    };
  };
  const resolvePath = async (chat: AgentChatReference, signal: AbortSignal) => {
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
  const resolvedReference = async (chat: AgentChatReference, signal: AbortSignal) => {
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
  const retryableReference = async (chat: AgentChatReference, signal: AbortSignal) => {
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
      return { messages: await runtime.loadMessages(await retryableReference(chat, signal), signal) };
    },
    async loadLegacy({ chat, signal }) {
      signal.throwIfAborted();
      const value = reference(chat);
      const nativePath = await resolvePath(chat, signal);
      if (!nativePath) return { messages: [] };
      return {
        messages: await runtime.loadMessages({ ...value, nativePath }, signal),
      };
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

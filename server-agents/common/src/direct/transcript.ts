import {
  computeAgentTranscriptRevision,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import type {
  DirectCompatibleTranscriptReader,
  DirectTranscriptReference,
} from './transcript-source.js';

export function createDirectTranscript(options: {
  readonly reader: DirectCompatibleTranscriptReader;
  readonly nativeSessions: PathNativeSessionCodec;
}): AgentTranscript {
  const reference = (chat: Parameters<AgentTranscript['load']>[0]['chat']): DirectTranscriptReference => {
    const native = options.nativeSessions.decode(chat.nativeSession);
    return {
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      modelEndpointId: native.modelEndpointId,
      nativePath: native.path,
    };
  };
  const loadMessages = (chat: Parameters<AgentTranscript['load']>[0]['chat']) => (
    options.reader.loadMessages(reference(chat))
  );
  return {
    async resolveNativeSession({ chat, signal }) {
      signal.throwIfAborted();
      const current = options.nativeSessions.decode(chat.nativeSession);
      const agentSessionId = chat.agentSessionId ?? current.agentSessionId;
      const path = await options.reader.resolveNativePath(reference(chat));
      return options.nativeSessions.encode({
        path,
        agentSessionId,
        modelEndpointId: current.modelEndpointId,
      });
    },
    async load({ chat, signal }) {
      signal.throwIfAborted();
      const messages = await loadMessages(chat);
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
    async preview({ chat, signal }) {
      signal.throwIfAborted();
      return options.reader.getPreview(reference(chat));
    },
    async revision({ chat, signal }) {
      signal.throwIfAborted();
      return computeAgentTranscriptRevision(await loadMessages(chat));
    },
    async release({ chat, signal }) {
      signal.throwIfAborted();
      await options.reader.release(reference(chat));
    },
  };
}

export function directTranscriptReference(
  chat: { readonly agentSessionId?: string | null; readonly nativeSession: Parameters<PathNativeSessionCodec['decode']>[0] },
  nativeSessions: PathNativeSessionCodec,
): DirectTranscriptReference {
  const native = nativeSessions.decode(chat.nativeSession);
  return {
    agentSessionId: chat.agentSessionId ?? native.agentSessionId,
    modelEndpointId: native.modelEndpointId,
    nativePath: native.path,
  };
}

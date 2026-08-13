import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../native-session/evidence-source.js';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import type {
  DirectCompatibleTranscriptReader,
  DirectTranscriptReference,
} from './transcript-source.js';

export function createDirectNativeEvidence(options: {
  readonly reader: DirectCompatibleTranscriptReader;
  readonly nativeSessions: PathNativeSessionCodec;
}): AgentNativeEvidenceSource {
  const reference = (chat: AgentChatReference): DirectTranscriptReference => {
    const native = options.nativeSessions.decode(chat.nativeSession);
    return {
      agentSessionId: chat.agentSessionId ?? native.agentSessionId,
      modelEndpointId: native.modelEndpointId,
      nativePath: native.path,
    };
  };
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
      return { messages: await options.reader.loadMessages(reference(chat)) };
    },
    async describeSource({ chat, signal }) {
      signal.throwIfAborted();
      const nativePath = await options.reader.resolveNativePath(reference(chat));
      return nativePath ? { kind: 'filesystem-path', value: nativePath } : null;
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

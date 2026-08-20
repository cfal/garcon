import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentNativeFork,
  type AgentNativeForkRequest,
} from '@garcon/server-agent-interface';
import { retargetNativeSeedReceiptIfPreserved } from '@garcon/common/transcript-seed';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import {
  fetchOpenCodeStoredMessages,
  loadRequiredOpenCodeChatMessages,
  type OpenCodeMessage,
} from './history-loader.js';
import type { OpenCodeRuntime } from './opencode.js';

type SessionReference = Pick<AgentChatReference, 'nativeSession'> & {
  readonly agentSessionId?: string | null;
};

export interface OpenCodeForkingOptions {
  readonly runtime: OpenCodeRuntime;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly sessionId: (chat: SessionReference) => string | null;
}

// Native-fidelity fork over OpenCode's server-side session fork. The provider
// clones messages strictly below an exclusive message boundary, so a point
// fork resolves the anchor row's provider identity to the first message to
// exclude; forking the tip omits the boundary and clones the whole session.
export function createOpenCodeNativeForking(
  options: OpenCodeForkingOptions,
): AgentNativeFork {
  return {
    async fork(request) {
      request.admission.signal.throwIfAborted();
      const sourceSessionId = options.sessionId(request.source);
      if (!sourceSessionId) {
        if (request.providerMeta) throw notSettled();
        return { kind: 'unmaterialized' };
      }
      const boundary = request.providerMeta
        ? await resolveForkBoundary(options.runtime, request, sourceSessionId)
        : null;
      const forkedSessionId = await options.runtime.forkSession(sourceSessionId, {
        projectPath: request.projectPath,
        ...(boundary ? { messageId: boundary } : {}),
      });
      return {
        kind: 'materialized',
        session: {
          agentSessionId: forkedSessionId,
          nativeSession: options.nativeSessions.encode({
            path: createArtificialNativePath('opencode', forkedSessionId),
            agentSessionId: forkedSessionId,
            modelEndpointId: null,
          }),
          nativeSeedReceipt: await retargetForkedSeedReceipt(
            options.runtime,
            request,
            forkedSessionId,
          ),
        },
      };
    },
    async discard(session, signal) {
      signal.throwIfAborted();
      await options.runtime.deleteSession(session.agentSessionId, signal);
    },
  };
}

// Upstream clones messages with id < messageID. The boundary is therefore the
// message after the one owning the anchor's provider identity; an anchor in
// the last message forks the whole session.
async function resolveForkBoundary(
  runtime: OpenCodeRuntime,
  request: AgentNativeForkRequest,
  sourceSessionId: string,
): Promise<string | null> {
  const entryId = typeof request.providerMeta?.entryId === 'string'
    ? request.providerMeta.entryId
    : '';
  if (!entryId) throw notSettled();
  const messages = await runtime.withClientLease((client) => (
    fetchOpenCodeStoredMessages(sourceSessionId, async () => client, {
      directory: request.projectPath,
      signal: request.admission.signal,
      throwOnError: true,
    })
  ));
  const anchorIndex = messages.findIndex((message) => ownsEntry(message, entryId));
  if (anchorIndex === -1) throw notSettled();
  const boundary = messages[anchorIndex + 1]?.info?.id;
  return typeof boundary === 'string' && boundary ? boundary : null;
}

async function retargetForkedSeedReceipt(
  runtime: OpenCodeRuntime,
  request: AgentNativeForkRequest,
  forkedSessionId: string,
): Promise<ReturnType<typeof retargetNativeSeedReceiptIfPreserved>> {
  const receipt = request.source.nativeSeedReceipt ?? null;
  if (!receipt) return null;
  const forkedMessages = await runtime.withClientLease((client) => (
    loadRequiredOpenCodeChatMessages(forkedSessionId, async () => client, {
      directory: request.projectPath,
      signal: request.admission.signal,
    })
  ));
  return retargetNativeSeedReceiptIfPreserved(receipt, forkedSessionId, forkedMessages);
}

function ownsEntry(message: OpenCodeMessage, entryId: string): boolean {
  if (message.info?.id === entryId) return true;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some((part) => (
    Boolean(part)
    && typeof part === 'object'
    && (part as { id?: unknown }).id === entryId
  ));
}

function notSettled(): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'The selected ledger row has no provider-native fork position',
    true,
    { nativeForkReason: 'not-settled' },
  );
}

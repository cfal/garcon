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
      const boundaryMessageId = request.providerMeta
        ? await resolveExclusiveBoundaryMessageId(options.runtime, request, sourceSessionId)
        : null;
      const forkedSessionId = await options.runtime.forkSession(sourceSessionId, {
        projectPath: request.projectPath,
        // OpenCode resolves the boundary by exact identity and clones its
        // chronological prefix.
        // https://github.com/anomalyco/opencode/blob/2b72179c663cadcb54f54d9f19221b3fb3d11fb6/packages/opencode/src/session/session.ts#L704-L706
        ...(boundaryMessageId ? { messageId: boundaryMessageId } : {}),
      });
      try {
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
      } catch (error) {
        await options.runtime.deleteSession(forkedSessionId).catch(() => undefined);
        throw error;
      }
    },
    async discard(session, signal) {
      signal.throwIfAborted();
      await options.runtime.deleteSession(session.agentSessionId, signal);
    },
  };
}

// Locates the stored message owning the anchor's provider identity; an
// identity the provider has not persisted refuses as not settled.
async function resolveExclusiveBoundaryMessageId(
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
  )).catch((error) => {
    if (error instanceof AgentIntegrationError) throw error;
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'OpenCode fork boundary resolution failed',
      true,
    );
  });
  if (messages.length === 0) throw missingSource();
  const anchorIndex = messages.findIndex((message) => ownsEntry(message, entryId));
  if (anchorIndex < 0) throw notSettled();
  const boundaryMessage = messages[anchorIndex + 1];
  if (!boundaryMessage) return null;
  const boundaryMessageId = boundaryMessage.info?.id;
  if (typeof boundaryMessageId !== 'string' || !boundaryMessageId) throw notSettled();
  return boundaryMessageId;
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

function missingSource(): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'The OpenCode source session is unavailable',
    true,
    { nativeForkReason: 'source-missing' },
  );
}

function notSettled(): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'The selected ledger row has no provider-native fork position',
    true,
    { nativeForkReason: 'not-settled' },
  );
}

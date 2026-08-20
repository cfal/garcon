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
      const anchorMessageId = request.providerMeta
        ? await resolveAnchorMessageId(options.runtime, request, sourceSessionId)
        : null;
      const forkedSessionId = await options.runtime.forkSession(sourceSessionId, {
        projectPath: request.projectPath,
        // Appending a character to the fixed-length ascending anchor id yields
        // an exclusive boundary that includes the anchor message and excludes
        // every later one, even if the provider appends concurrently; upstream
        // validates only the "msg" prefix.
        // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/schema/src/v1/session.ts#L17-L20
        ...(anchorMessageId ? { messageId: `${anchorMessageId}0` } : {}),
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
async function resolveAnchorMessageId(
  runtime: OpenCodeRuntime,
  request: AgentNativeForkRequest,
  sourceSessionId: string,
): Promise<string> {
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
  const anchor = messages.find((message) => ownsEntry(message, entryId));
  const anchorMessageId = anchor?.info?.id;
  if (typeof anchorMessageId !== 'string' || !anchorMessageId) throw notSettled();
  return anchorMessageId;
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

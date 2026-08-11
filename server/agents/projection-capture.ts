import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  type AgentChatReferenceV4,
  type AgentIntegrationV4,
  type AgentProjectionState,
} from '@garcon/server-agent-interface';
import { DomainError } from '../lib/domain-error.js';

export interface CapturedProjection {
  readonly messages: readonly ChatMessage[];
  readonly revision: string;
}

// Captures the durable conversation ledger at one pinned projection state for
// immutable carryover. Every page is validated against that state, so the
// result is consistent without content-stability polling. An active suffix
// means an admission has not settled, and the capture refuses rather than
// freezing a row the provider may still discard.
export class ProjectionCaptureService {
  async loadStable(input: {
    readonly chatId: string;
    readonly integration: AgentIntegrationV4;
    readonly reference: AgentChatReferenceV4;
    readonly signal: AbortSignal;
  }): Promise<CapturedProjection> {
    input.signal.throwIfAborted();
    const projection = await openProjection(input.integration, input.reference, input.signal);
    if (projection.total !== projection.durableCount) {
      throw unsettledError('An admitted input has not settled into the durable ledger');
    }
    const messages = await loadPinned(
      input.integration,
      input.reference,
      projection,
      input.signal,
    );
    return { messages, revision: projection.durableRevision };
  }

  async assertRevision(input: {
    readonly integration: AgentIntegrationV4;
    readonly reference: AgentChatReferenceV4;
    readonly expectedRevision: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const projection = await openProjection(input.integration, input.reference, input.signal);
    if (projection.durableRevision !== input.expectedRevision) {
      throw unsettledError('The projection changed during handoff preparation');
    }
  }
}

async function openProjection(
  integration: AgentIntegrationV4,
  reference: AgentChatReferenceV4,
  signal: AbortSignal,
): Promise<AgentProjectionState> {
  try {
    const opened = await integration.transcript.openSegment({ chat: reference, signal });
    if (opened.kind !== 'ready') throw accessError();
    return opened.value.checkpoint.projection;
  } catch (error) {
    throw sourceUnavailable(error);
  }
}

async function loadPinned(
  integration: AgentIntegrationV4,
  reference: AgentChatReferenceV4,
  projection: AgentProjectionState,
  signal: AbortSignal,
): Promise<readonly ChatMessage[]> {
  const pages: ChatMessage[][] = [];
  let beforeOrdinal: number | null = null;
  try {
    do {
      const result = await integration.transcript.loadPage({
        chat: reference,
        signal,
        limit: 500,
        beforeOrdinal,
        expectedProjection: projection,
      });
      if (result.kind !== 'ready') throw accessError();
      pages.push(result.page.entries.map((entry) => entry.message));
      beforeOrdinal = result.page.firstOrdinal;
      if (!result.page.hasMore) break;
    } while (beforeOrdinal > 1);
  } catch (error) {
    throw sourceUnavailable(error);
  }
  return pages.reverse().flat();
}

function accessError(): Error {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'The authoritative transcript projection is unavailable',
    true,
  );
}

function unsettledError(message: string): DomainError {
  return new DomainError('TRANSCRIPT_NOT_YET_PERSISTED', message, 409, true);
}

function sourceUnavailable(error: unknown): unknown {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof DomainError) return error;
  const retryable = error instanceof AgentIntegrationError ? error.retryable : true;
  return new DomainError(
    'SOURCE_TRANSCRIPT_UNAVAILABLE',
    retryable
      ? 'The source transcript is temporarily unavailable. Retry the handoff.'
      : 'The source transcript is unavailable.',
    422,
    retryable,
    { cause: error },
  );
}

import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { AgentLogger } from './host.js';

export interface AgentTranscriptIndexModuleReference {
  readonly apiVersion: 1;
  readonly moduleUrl: string;
}

export interface AgentTranscriptIndexSourceRef {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly value: JsonObject;
}

export interface AgentTranscriptIndexProbe {
  readonly revision: string | null;
}

export interface AgentTranscriptIndexFailure {
  readonly kind: 'agent-transcript-index-failure';
  readonly code: string;
  readonly retryable: boolean;
  readonly refreshSource: boolean;
}

export class AgentTranscriptIndexError extends Error {
  override readonly name = 'AgentTranscriptIndexError';
  readonly failure: AgentTranscriptIndexFailure;

  constructor(failure: AgentTranscriptIndexFailure) {
    const sanitized = failure?.kind === 'agent-transcript-index-failure'
      && typeof failure.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)
      && typeof failure.retryable === 'boolean'
      && typeof failure.refreshSource === 'boolean'
      ? failure
      : {
        kind: 'agent-transcript-index-failure' as const,
        code: 'SOURCE_INTERNAL',
        retryable: false,
        refreshSource: false,
      };
    super(sanitized.code);
    this.failure = sanitized;
  }
}

export interface AgentTranscriptIndexLoadLimits {
  readonly maxMessagesPerBatch: number;
  readonly maxBatchBytes: number;
  readonly maxRecordBytes: number;
}

export interface AgentTranscriptIndexLoadRequest {
  readonly source: AgentTranscriptIndexSourceRef;
  readonly signal: AbortSignal;
  readonly limits: AgentTranscriptIndexLoadLimits;
  readonly scratchDirectory: string;
}

export interface AgentTranscriptIndexSource {
  probe(
    source: AgentTranscriptIndexSourceRef,
    signal: AbortSignal,
  ): Promise<AgentTranscriptIndexProbe>;
  load(request: AgentTranscriptIndexLoadRequest): AsyncIterable<readonly ChatMessage[]>;
  close(): Promise<void>;
}

export interface AgentTranscriptIndexerHost {
  readonly agentId: string;
  readonly logger: AgentLogger;
}

export interface AgentTranscriptIndexerModule {
  readonly integrationId: string;
  readonly apiVersion: 1;
  create(host: AgentTranscriptIndexerHost): AgentTranscriptIndexSource;
}

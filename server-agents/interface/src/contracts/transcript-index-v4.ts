import type { JsonObject } from '@garcon/common/json';
import type { AgentSegmentIdentity, AgentTranscriptEntry } from './transcript-stream-v4.js';
import type { AgentTranscriptRevision } from '../transcript-revision.js';
import type { AgentTranscriptContentEpoch } from './transcript-stream-v4.js';

export interface AgentTranscriptIndexCheckpointV4 extends AgentSegmentIdentity {
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly durableCount: number;
  readonly durableRevision: AgentTranscriptRevision;
}

export interface AgentTranscriptIndexEntryV4 {
  readonly ordinal: number;
  readonly entry: AgentTranscriptEntry & { readonly lifetime: 'durable' };
}

export interface AgentTranscriptIndexSourceRefV4 {
  readonly apiVersion: 2;
  readonly ownerId: string;
  readonly schemaVersion: 2;
  readonly checkpoint: AgentTranscriptIndexCheckpointV4;
  readonly value: JsonObject;
}

export interface AgentTranscriptIndexRefreshRequestV4 {
  readonly chat: import('./transcript-stream-v4.js').AgentChatReferenceV4;
  readonly signal: AbortSignal;
  readonly failedSource: AgentTranscriptIndexSourceRefV4;
  readonly failureCode: string;
}

export type AgentTranscriptIndexOpenResultV4 =
  | { readonly kind: 'unchanged'; readonly checkpoint: AgentTranscriptIndexCheckpointV4 }
  | {
      readonly kind: 'append';
      readonly previous: AgentTranscriptIndexCheckpointV4;
      readonly checkpoint: AgentTranscriptIndexCheckpointV4;
      readonly batches: AsyncIterable<readonly AgentTranscriptIndexEntryV4[]>;
    }
  | {
      readonly kind: 'snapshot';
      readonly checkpoint: AgentTranscriptIndexCheckpointV4;
      readonly batches: AsyncIterable<readonly AgentTranscriptIndexEntryV4[]>;
    }
  | { readonly kind: 'expired'; readonly checkpoint: AgentTranscriptIndexCheckpointV4 }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

export interface AgentTranscriptIndexSourceV4 {
  open(request: {
    readonly source: AgentTranscriptIndexSourceRefV4;
    readonly previous: AgentTranscriptIndexCheckpointV4 | null;
    readonly signal: AbortSignal;
    readonly maxEntriesPerBatch: number;
  }): Promise<AgentTranscriptIndexOpenResultV4>;
  close(): Promise<void>;
}

export interface AgentTranscriptIndexerModuleV4 {
  readonly integrationId: string;
  readonly apiVersion: 2;
  create(host: import('./transcript-index.js').AgentTranscriptIndexerHost): AgentTranscriptIndexSourceV4;
}

import type { ChatMessage, UserMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import type { AgentIntegrationError } from '../errors.js';
import type { AgentOwnershipEpoch } from '../ownership-epoch.js';
import type { AgentTranscriptRevision } from '../transcript-revision.js';
import type {
  AgentOperationIdentityV4,
  AgentTranscriptAdmissionIdentity,
  AgentTurnBoundOperationIdentityV4,
  AgentTurnOwnerOperationIdentityV4,
} from './execution-events-v4.js';
import type {
  AgentChatReference,
  AgentNativeSessionRef,
  AgentTranscriptPreview,
  AgentTranscriptSourceLocation,
} from './transcript.js';
import type {
  AgentTranscriptIndexRefreshRequestV4,
  AgentTranscriptIndexSourceRefV4,
} from './transcript-index-v4.js';

declare const streamEpochBrand: unique symbol;
declare const streamOffsetBrand: unique symbol;
declare const entryIdBrand: unique symbol;
declare const eventDigestBrand: unique symbol;
declare const projectionRevisionBrand: unique symbol;
declare const transcriptContentEpochBrand: unique symbol;
declare const handoffSealBrand: unique symbol;
declare const handoffDecisionBrand: unique symbol;

export type AgentStreamEpoch = string & { readonly [streamEpochBrand]: true };
export type AgentStreamOffset = string & { readonly [streamOffsetBrand]: true };
export type AgentTranscriptEntryId = string & { readonly [entryIdBrand]: true };
export type AgentEventDigest = string & { readonly [eventDigestBrand]: true };
export type AgentProjectionStateRevision = string & {
  readonly [projectionRevisionBrand]: true;
};
export type AgentTranscriptContentEpoch = string & {
  readonly [transcriptContentEpochBrand]: true;
};

export interface AgentSegmentIdentity {
  readonly chatId: string;
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
}

export interface AgentProjectionState {
  readonly epoch: AgentStreamEpoch;
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly total: number;
  readonly durableCount: number;
  readonly durableRevision: AgentTranscriptRevision;
  readonly stateRevision: AgentProjectionStateRevision;
}

export interface AgentStreamCheckpoint extends AgentSegmentIdentity {
  readonly offset: AgentStreamOffset;
  readonly projection: AgentProjectionState;
}

export interface AgentTranscriptSourceIdentity {
  readonly namespace: string;
  readonly itemId: string;
  readonly subrowId: string;
}

export interface AgentTranscriptProvenance extends AgentTurnBoundOperationIdentityV4 {
  readonly upstreamRequestId: string | null;
}

export interface AgentTranscriptEntry {
  readonly id: AgentTranscriptEntryId;
  readonly lifetime: 'durable' | 'active';
  readonly source: AgentTranscriptSourceIdentity | null;
  readonly provenance: AgentTranscriptProvenance | null;
  readonly message: ChatMessage;
}

export interface AgentTranscriptPromotion {
  readonly entryId: AgentTranscriptEntryId;
  readonly source: AgentTranscriptSourceIdentity;
}

export interface AgentStreamEventBase extends AgentSegmentIdentity {
  readonly previous: AgentStreamCheckpoint;
  readonly checkpoint: AgentStreamCheckpoint;
  readonly digest: AgentEventDigest;
}

export interface AgentTranscriptCommitEvent extends AgentStreamEventBase {
  readonly kind: 'commit';
  readonly promoted: readonly AgentTranscriptPromotion[];
  readonly appended: readonly AgentTranscriptEntry[];
}

export type AgentTranscriptResetReason =
  | 'input-not-sent'
  | 'user-revert'
  | 'user-truncate'
  | 'adopt-external'
  | 'journal-repair'
  | 'migration';

export interface AgentTranscriptResetEvent extends AgentStreamEventBase {
  readonly kind: 'reset';
  readonly reason: AgentTranscriptResetReason;
}

export interface AgentControlRow {
  readonly id: string;
  readonly incarnation: string;
  readonly operation: AgentTurnBoundOperationIdentityV4;
  readonly anchorEntryId: AgentTranscriptEntryId | null;
  readonly displayOrder: number;
  readonly message: ChatMessage;
}

export interface AgentControlEvent extends AgentStreamEventBase {
  readonly kind: 'control';
  readonly operation: AgentTurnBoundOperationIdentityV4;
  readonly mutation:
    | { readonly kind: 'upsert'; readonly row: AgentControlRow }
    | { readonly kind: 'remove'; readonly id: string; readonly incarnation: string }
    | { readonly kind: 'clear' };
}

export interface AgentTransientControlCapabilityV4 {
  readonly protocol: 'ordered-stream-v1';
}

export interface AgentSessionEvent extends AgentStreamEventBase {
  readonly kind: 'session';
  readonly operation: AgentOperationIdentityV4;
  readonly session: import('./execution.js').AgentStartedSession;
}

export interface AgentTerminalCompleteness {
  readonly acceptedInputEntryIds: readonly AgentTranscriptEntryId[];
  readonly attributableEntryCount: number;
}

export interface AgentTerminalEvent extends AgentStreamEventBase {
  readonly kind: 'terminal';
  readonly operation: AgentTurnOwnerOperationIdentityV4;
  readonly outcome:
    | { readonly kind: 'finished'; readonly exitCode: number }
    | { readonly kind: 'failed'; readonly error: AgentIntegrationError };
  readonly completeness: AgentTerminalCompleteness;
  readonly sourceSettlement: 'confirmed' | 'unresolved';
}

export type AgentStreamEvent =
  | AgentTranscriptCommitEvent
  | AgentTranscriptResetEvent
  | AgentControlEvent
  | AgentSessionEvent
  | AgentTerminalEvent;

export interface AgentChatReferenceV4 extends AgentChatReference {
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
}

export interface AgentTranscriptRequestV4 {
  readonly chat: AgentChatReferenceV4;
  readonly signal: AbortSignal;
}

export interface AgentSegmentOpenResult {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly idle: true;
}

export interface AgentTranscriptPageV4 {
  readonly projection: AgentProjectionState;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly firstOrdinal: number;
  readonly hasMore: boolean;
}

export type AgentTranscriptAccessResult<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

export type AgentTranscriptPageResultV4 =
  | { readonly kind: 'ready'; readonly page: AgentTranscriptPageV4 }
  | { readonly kind: 'expired'; readonly current: AgentProjectionState }
  | { readonly kind: 'deferred'; readonly retry: 'execution-settled' }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

export type AgentStreamReplayResult =
  | {
      readonly kind: 'events';
      readonly events: readonly AgentStreamEvent[];
      readonly checkpoint: AgentStreamCheckpoint;
    }
  | { readonly kind: 'expired'; readonly checkpoint: AgentStreamCheckpoint }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

export interface AgentInputPreparation {
  commit(): Promise<AgentTranscriptCommitEvent>;
  rollback(): Promise<AgentInputRollbackResult>;
  discardCommitted(): Promise<AgentTranscriptResetEvent>;
}

export type AgentInputAdmissionState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'prepared' }
  | { readonly kind: 'rolled-back' }
  | { readonly kind: 'committed'; readonly event: AgentTranscriptCommitEvent }
  | { readonly kind: 'discarded'; readonly event: AgentTranscriptResetEvent }
  | { readonly kind: 'committed-settled'; readonly entryId: AgentTranscriptEntryId }
  | { readonly kind: 'discarded-settled'; readonly entryId: AgentTranscriptEntryId }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

export type AgentInputRollbackResult =
  | { readonly kind: 'rolled-back' }
  | { readonly kind: 'conflict'; readonly state: 'committed' | 'discarded' };

export interface AgentConsumerOffsetCommit extends AgentSegmentIdentity {
  readonly applied: AgentStreamCheckpoint;
}

export type AgentHandoffSeal = { readonly [handoffSealBrand]: true };

export interface AgentHandoffDecision {
  readonly operationId: string;
  readonly targetOwnershipEpoch: AgentOwnershipEpoch;
  readonly [handoffDecisionBrand]: true;
}

export interface AgentFrozenSegment {
  readonly checkpoint: AgentStreamCheckpoint;
  readonly entries: readonly AgentTranscriptEntry[];
}

export interface AgentOutgoingHandoffLease {
  readonly operationId: string;
  readonly frozen: AgentFrozenSegment;
  sealForDecision(): AgentHandoffSeal;
  commitAfterDecision(seal: AgentHandoffSeal, decision: AgentHandoffDecision): Promise<void>;
  rollbackBeforeDecision(): Promise<void>;
}

export interface AgentIncomingOwnershipPreparation {
  readonly checkpoint: AgentStreamCheckpoint;
  commitAfterDecision(decision: AgentHandoffDecision): Promise<void>;
  rollbackBeforeDecision(): Promise<void>;
}

export interface AgentNativeSessionRefV4 {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly value: JsonObject;
}

export interface AgentTranscriptStream {
  openSegment(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentSegmentOpenResult>>;
  subscribe(listener: (event: AgentStreamEvent) => void): () => void;
  replay(request: AgentTranscriptRequestV4 & { readonly after: AgentStreamCheckpoint }): Promise<AgentStreamReplayResult>;
  loadPage(request: AgentTranscriptRequestV4 & {
    readonly limit: number;
    readonly beforeOrdinal: number | null;
    readonly expectedProjection: AgentProjectionState | null;
  }): Promise<AgentTranscriptPageResultV4>;
  commitOffset(request: AgentTranscriptRequestV4 & { readonly commit: AgentConsumerOffsetCommit }): Promise<void>;
  prepareInput(request: AgentTranscriptRequestV4 & {
    readonly message: UserMessage;
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputPreparation>;
  resolveInputAdmission(request: AgentTranscriptRequestV4 & {
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputAdmissionState>;
  prepareHandoffLease(request: AgentTranscriptRequestV4 & {
    readonly handoffOperationId: string;
  }): Promise<AgentTranscriptAccessResult<AgentOutgoingHandoffLease>>;
  prepareOwnershipSegment(request: AgentTranscriptRequestV4 & {
    readonly handoffOperationId: string;
  }): Promise<AgentTranscriptAccessResult<AgentIncomingOwnershipPreparation>>;
  resolveNativeSession(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentNativeSessionRef | null>>;
  preview(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentTranscriptPreview | null>>;
  resolveIndexSource(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>>;
  refreshIndexSource(request: AgentTranscriptIndexRefreshRequestV4): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>>;
  describeSource(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentTranscriptSourceLocation | null>>;
  release(request: AgentTranscriptRequestV4 & { readonly reason: 'deleted' | 'transferred' }): Promise<void>;
}

export interface AgentForkPoint {
  readonly kind: 'projection-entry';
  readonly agentOwnershipEpoch: AgentOwnershipEpoch;
  readonly contentEpoch: AgentTranscriptContentEpoch;
  readonly entryId: AgentTranscriptEntryId;
  readonly durableRevision: AgentTranscriptRevision;
}

export interface AgentNativeForkRef {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly value: JsonObject;
}

export type AgentNativeForkResolution =
  | { readonly kind: 'ready'; readonly reference: AgentNativeForkRef }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'below-native-retention-floor'
        | 'no-native-source'
        | 'projection-ahead-of-provider'
        | 'not-settled'
        | 'source-diverged';
    }
  | { readonly kind: 'degraded'; readonly errorCode: string; readonly retryable: boolean };

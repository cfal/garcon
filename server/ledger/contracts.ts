import type { AgentAttachment } from '../../common/agent-execution.js';
import type {
  AgentEstablishedSession,
  AgentPermissionLifecycle,
  AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type { ChatMessage, UserMessage } from '../../common/chat-types.js';
import type { JsonObject } from '../../common/json.js';

declare const transcriptViewIdBrand: unique symbol;

export type TranscriptViewId = string & { readonly [transcriptViewIdBrand]: true };

export function transcriptViewId(value: string): TranscriptViewId {
  if (!value) throw new TypeError('Transcript view ID is required');
  return value as TranscriptViewId;
}

export type TranscriptViewStatus = 'current' | 'staging';

export interface TranscriptView {
  readonly viewId: TranscriptViewId;
  readonly status: TranscriptViewStatus;
  readonly createdAt: string;
  readonly contentStartOrdinal: number;
}

export interface LedgerRowBase {
  readonly viewId: TranscriptViewId;
  readonly ordinal: number;
  readonly at: string;
  readonly providerMeta: JsonObject | null;
}

export interface LedgerUserInputDetail {
  readonly clientMessageId: string | null;
  readonly message: UserMessage;
  readonly attachments: readonly AgentAttachment[];
  readonly steer: boolean;
}

export interface LedgerUserInputRow extends LedgerRowBase {
  readonly kind: 'user-input';
  readonly detail: LedgerUserInputDetail;
}

export interface LedgerProviderRow extends LedgerRowBase {
  readonly kind: 'provider-row';
  readonly message: ChatMessage;
}

export interface LedgerNoticeRow extends LedgerRowBase {
  readonly kind: 'notice';
  readonly message: string;
  readonly detail: JsonObject;
}

export interface LedgerSessionRow extends LedgerRowBase {
  readonly kind: 'session';
  readonly detail: AgentEstablishedSession;
}

export interface LedgerRunEndedRow extends LedgerRowBase {
  readonly kind: 'run-ended';
  readonly outcome: 'finished' | 'failed' | 'interrupted';
  readonly origin: 'provider' | 'core';
  readonly error?: AgentRunFailureDetail;
}

export interface LedgerPermissionRow extends LedgerRowBase {
  readonly kind:
    | 'permission-requested'
    | 'permission-resolved'
    | 'permission-cancelled'
    | 'permission-expired';
  readonly lifecycle: AgentPermissionLifecycle;
}

export type LedgerRow =
  | LedgerUserInputRow
  | LedgerProviderRow
  | LedgerNoticeRow
  | LedgerSessionRow
  | LedgerRunEndedRow
  | LedgerPermissionRow;

type DraftBase = {
  readonly at: string;
  readonly providerMeta?: JsonObject | null;
};

export type LedgerRowDraft =
  | (DraftBase & { readonly kind: 'user-input'; readonly detail: LedgerUserInputDetail })
  | (DraftBase & { readonly kind: 'provider-row'; readonly message: ChatMessage })
  | (DraftBase & { readonly kind: 'notice'; readonly message: string; readonly detail: JsonObject })
  | (DraftBase & { readonly kind: 'session'; readonly detail: AgentEstablishedSession })
  | (DraftBase & {
      readonly kind: 'run-ended';
      readonly outcome: LedgerRunEndedRow['outcome'];
      readonly origin: LedgerRunEndedRow['origin'];
      readonly error?: AgentRunFailureDetail;
    })
  | (DraftBase & {
      readonly kind: LedgerPermissionRow['kind'];
      readonly lifecycle: AgentPermissionLifecycle;
    });

export interface TranscriptPage {
  readonly viewId: TranscriptViewId;
  readonly rows: readonly LedgerRow[];
  readonly nextBefore: number | null;
}

export interface InputComposition {
  readonly input: LedgerUserInputRow;
  readonly prompt: readonly LedgerUserInputRow[];
  readonly inserted: boolean;
}

export interface TranscriptWatermark {
  readonly viewId: TranscriptViewId;
  readonly ordinal: number;
}

export interface LedgerCheckpoint extends TranscriptWatermark {
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

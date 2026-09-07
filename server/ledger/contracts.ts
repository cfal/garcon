import type { AgentAttachment } from '../../common/agent-execution.js';
import type {
  AgentEstablishedSession,
  AgentPermissionLifecycle,
  AgentRunFailureDetail,
} from '@garcon/server-agent-interface';
import type {
  ChatMessage,
  CliRowMessage,
  ErrorMessage,
  UserMessage,
} from '../../common/chat-types.js';
import {
  isCliBodyDisclosure,
  isCliPresentation,
  isCliRowFormat,
  type CliBodyDisclosure,
  type CliPresentation,
  type CliRowFormat,
} from '../../common/cli-presentation.js';
import type { JsonObject } from '../../common/json.js';
import { isCommandCorrelationIdWithinLimit } from '../../common/command-request-validation.js';
import {
  isPreambleId,
  normalizePreambleTitle,
  PREAMBLE_MAX_COUNT,
  type PendingPreambleBoundary,
  type Preamble,
} from '../../common/preambles.js';
import type { PreamblePrefixReceipt } from '../../common/preamble-prefix.js';

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
  readonly preambleBoundary: PendingPreambleBoundary | null;
  readonly preamblePrefixReceipt: PreamblePrefixReceipt | null;
}

export interface LedgerUserInputRow extends LedgerRowBase {
  readonly kind: 'user-input';
  readonly detail: LedgerUserInputDetail;
}

export interface LedgerProviderRow extends LedgerRowBase {
  readonly kind: 'provider-row';
  readonly message: ChatMessage;
}

export interface LedgerConversationalProviderRow extends LedgerProviderRow {
  readonly message: Exclude<ChatMessage, ErrorMessage | CliRowMessage>;
}

export interface LedgerNoticeRow extends LedgerRowBase {
  readonly kind: 'notice';
  readonly message: string;
  readonly detail: JsonObject;
}

export interface LedgerCliRowNoticeDetail extends JsonObject {
  readonly type: 'cli-row';
  readonly clientMessageId: string;
  readonly presentation: CliPresentation;
  readonly format: CliRowFormat;
  readonly disclosure: CliBodyDisclosure;
  readonly title: string | null;
}

export interface LedgerCliRowNoticeRow extends LedgerNoticeRow {
  readonly detail: LedgerCliRowNoticeDetail;
  readonly providerMeta: null;
}

// Private durable identity for the Preambles updated notice. Carries only the
// submission identity needed for retry; titles are public snapshots and the
// fingerprint excludes catalog titles, bodies, paths, and catalog revision so a
// retry survives catalog edits.
export interface LedgerPreambleSelectionChangedNoticeDetail extends JsonObject {
  readonly type: 'preamble-selection-change';
  readonly clientMessageId: string;
  readonly requestFingerprint: string;
  readonly selectionRevision: number;
  readonly preambles: readonly { readonly id: string; readonly title: string }[];
}

export interface LedgerPreambleSelectionChangedNoticeRow extends LedgerNoticeRow {
  readonly detail: LedgerPreambleSelectionChangedNoticeDetail;
  readonly providerMeta: null;
}

export function isLedgerPreambleSelectionChangedNoticeDetail(
  value: JsonObject,
): value is LedgerPreambleSelectionChangedNoticeDetail {
  if (
    value.type !== 'preamble-selection-change'
    || typeof value.clientMessageId !== 'string'
    || value.clientMessageId.length === 0
    || value.clientMessageId.trim() !== value.clientMessageId
    || !isCommandCorrelationIdWithinLimit(value.clientMessageId)
    || typeof value.requestFingerprint !== 'string'
    || value.requestFingerprint.length === 0
    || typeof value.selectionRevision !== 'number'
    || !Number.isSafeInteger(value.selectionRevision)
    || value.selectionRevision < 0
    || !Array.isArray(value.preambles)
    // Reuse the shared reference count bound.
    || value.preambles.length > PREAMBLE_MAX_COUNT
  ) return false;
  const allowed = new Set(['type', 'clientMessageId', 'requestFingerprint', 'selectionRevision', 'preambles']);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  const ids = new Set<string>();
  for (const entry of value.preambles) {
    // Canonical UUID identity and shared title bounds, no trimming.
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !Object.keys(entry).every((key) => key === 'id' || key === 'title')
      || !isPreambleId((entry as { id: unknown }).id)
      || ids.has((entry as { id: string }).id)
      || normalizePreambleTitle((entry as { title: unknown }).title)
        !== (entry as { title: unknown }).title
    ) return false;
    ids.add((entry as { id: string }).id);
  }
  return true;
}

export function isLedgerCliRowNoticeDetail(
  value: JsonObject,
): value is LedgerCliRowNoticeDetail {
  return value.type === 'cli-row'
    && typeof value.clientMessageId === 'string'
    && value.clientMessageId.length > 0
    && isCliPresentation(value.presentation)
    && isCliRowFormat(value.format)
    && isCliBodyDisclosure(value.disclosure)
    && (
      value.title === null
      || (typeof value.title === 'string' && value.title.length > 0)
    );
}

export function isLedgerCliRowNoticeRow(row: LedgerRow): row is LedgerCliRowNoticeRow {
  return row.kind === 'notice'
    && row.providerMeta === null
    && isLedgerCliRowNoticeDetail(row.detail);
}

export function isLedgerPreambleSelectionChangedNoticeRow(
  row: LedgerRow,
): row is LedgerPreambleSelectionChangedNoticeRow {
  return row.kind === 'notice'
    && row.providerMeta === null
    && isLedgerPreambleSelectionChangedNoticeDetail(row.detail);
}

export const PREAMBLES_UPDATED_MESSAGE = 'Preambles updated';

export interface AppendSelectionChangeNoticeResult {
  readonly row: LedgerPreambleSelectionChangedNoticeRow;
  readonly inserted: boolean;
}

export interface LedgerAgentSwitchDetail {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly fromModel: string | null;
  readonly toModel: string | null;
}

export interface LedgerAgentSwitchRow extends LedgerRowBase {
  readonly kind: 'agent-switch';
  readonly detail: LedgerAgentSwitchDetail;
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
  | LedgerAgentSwitchRow
  | LedgerSessionRow
  | LedgerRunEndedRow
  | LedgerPermissionRow;

export type LedgerConversationRow = LedgerUserInputRow | LedgerConversationalProviderRow;

export function isPresentationOnlyProviderRow(row: LedgerRow): boolean {
  return row.kind === 'provider-row'
    && (row.message.type === 'error' || row.message.type === 'cli-row');
}

export function isConversationalLedgerRow(row: LedgerRow): row is LedgerConversationRow {
  return row.kind === 'user-input'
    || (row.kind === 'provider-row' && !isPresentationOnlyProviderRow(row));
}

type DraftBase = {
  readonly at: string;
  readonly providerMeta?: JsonObject | null;
};

export type LedgerRowDraft =
  | (DraftBase & { readonly kind: 'user-input'; readonly detail: LedgerUserInputDetail })
  | (DraftBase & { readonly kind: 'provider-row'; readonly message: ChatMessage })
  | (DraftBase & { readonly kind: 'notice'; readonly message: string; readonly detail: JsonObject })
  | (DraftBase & { readonly kind: 'agent-switch'; readonly detail: LedgerAgentSwitchDetail })
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
  readonly committedRows: readonly LedgerRow[];
  readonly prompt: readonly LedgerUserInputRow[];
  readonly providerPrefix: string;
  readonly inserted: boolean;
}

export interface PreambleInputApplication {
  readonly boundary: PendingPreambleBoundary;
  readonly preambles: readonly Preamble[];
}

export interface AppendInputRequest {
  readonly viewId: TranscriptViewId;
  readonly at: string;
  readonly detail: LedgerUserInputDetail;
  readonly excludedOrdinals?: ReadonlySet<number>;
  readonly preambleBoundary: PendingPreambleBoundary | null;
  readonly preambles: readonly Preamble[];
}

export interface AppendChatRowRequest {
  readonly viewId: TranscriptViewId;
  readonly at: string;
  readonly message: string;
  readonly detail: LedgerCliRowNoticeDetail;
}

export interface AppendChatRowResult {
  readonly row: LedgerCliRowNoticeRow;
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

export interface NativeActivityProviderWatermark {
  readonly ordinal: number;
  readonly at: string;
}

export interface TranscriptNativeActivityState {
  readonly viewId: TranscriptViewId;
  readonly session: LedgerSessionRow | null;
  readonly providerWatermark: NativeActivityProviderWatermark | null;
}

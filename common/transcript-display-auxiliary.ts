import { parseUserMessagePresentation, type UserMessagePresentation } from './user-message-presentation.js';
import { displayArray, displayInteger, displayRecord, displayString } from './transcript-display-contract.js';
import type { SubagentManagementEntry } from './subagent-management.js';

export interface DisplayAuxiliaryRequest {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly atWatermark?: number;
  readonly beforeOrdinal?: number;
  readonly afterOrder?: number;
  readonly mode: 'navigation' | 'recall';
  readonly limit: number;
}
export interface DisplayAuxiliaryIdentity {
  readonly serverInstanceId: string;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly watermark: number;
  readonly sourceHead: number;
}
export interface UserRowSummary {
  readonly ordinal: number;
  readonly preview: string;
  readonly timestamp: string;
  readonly attachmentCount: number;
  readonly presentation?: UserMessagePresentation;
}
export interface UserRowPage extends DisplayAuxiliaryIdentity {
  readonly kind: 'available';
  readonly rows: readonly UserRowSummary[];
  readonly nextBeforeOrdinal: number | null;
}
export interface ResendSummaryPage extends UserRowPage { readonly total: number }
export interface SubagentSummaryPage extends DisplayAuxiliaryIdentity {
  readonly kind: 'available';
  readonly entries: readonly SubagentManagementEntry[];
  readonly nextAfterOrder: number | null;
}
export interface AuxiliaryPreparing extends DisplayAuxiliaryIdentity {
  readonly kind: 'preparing' | 'failed';
  readonly errorCode: string | null;
}
export type AuxiliaryResponse<T> = T | AuxiliaryPreparing;

export function parseDisplayAuxiliaryRequest(value: unknown): DisplayAuxiliaryRequest {
  const raw = displayRecord(value);
  if (raw.mode !== 'navigation' && raw.mode !== 'recall') throw new TypeError('Invalid user-row mode');
  return { chatId: displayString(raw.chatId, 128), transcriptViewId: displayString(raw.transcriptViewId, 256), mode: raw.mode,
    limit: displayInteger(raw.limit, 1, raw.mode === 'recall' ? 100 : 50),
    ...(raw.atWatermark === undefined ? {} : { atWatermark: displayInteger(raw.atWatermark) }),
    ...(raw.beforeOrdinal === undefined ? {} : { beforeOrdinal: displayInteger(raw.beforeOrdinal, 1) }),
    ...(raw.afterOrder === undefined ? {} : { afterOrder: displayInteger(raw.afterOrder) }) };
}

export function parseAuxiliaryIdentity(value: unknown): DisplayAuxiliaryIdentity {
  const raw = displayRecord(value), watermark = displayInteger(raw.watermark);
  return { serverInstanceId: displayString(raw.serverInstanceId), chatId: displayString(raw.chatId, 128),
    transcriptViewId: displayString(raw.transcriptViewId, 256), watermark, sourceHead: displayInteger(raw.sourceHead, watermark) };
}

function parsePreparing(raw: Record<string, unknown>): AuxiliaryPreparing {
  if (raw.kind !== 'preparing' && raw.kind !== 'failed') throw new TypeError('Invalid auxiliary state');
  return { ...parseAuxiliaryIdentity(raw), kind: raw.kind, errorCode: raw.errorCode === null ? null : displayString(raw.errorCode, 128) };
}

export function parseUserRowPage(value: unknown): AuxiliaryResponse<UserRowPage> {
  const raw = displayRecord(value);
  if (raw.kind !== 'available') return parsePreparing(raw);
  const identity = parseAuxiliaryIdentity(raw);
  const rows = displayArray(raw.rows, 100).map(value => {
    const row = displayRecord(value);
    if (typeof row.preview !== 'string' || row.preview.length > 300) throw new TypeError('Invalid user-row preview');
    return { ordinal: displayInteger(row.ordinal, 1, identity.watermark), preview: row.preview, timestamp: displayString(row.timestamp),
      attachmentCount: displayInteger(row.attachmentCount), presentation: parseUserMessagePresentation(row.presentation) };
  });
  if (rows.some((row, index) => index > 0 && row.ordinal >= rows[index - 1].ordinal)) throw new TypeError('Invalid user-row order');
  const nextBeforeOrdinal = raw.nextBeforeOrdinal === null ? null : displayInteger(raw.nextBeforeOrdinal, 1, identity.watermark);
  if (nextBeforeOrdinal !== null && nextBeforeOrdinal !== rows.at(-1)?.ordinal) throw new TypeError('Invalid user-row cursor');
  return { ...identity, kind: 'available', rows, nextBeforeOrdinal };
}

export function parseResendSummaryPage(value: unknown): AuxiliaryResponse<ResendSummaryPage> {
  const page = parseUserRowPage(value);
  return page.kind === 'available' ? { ...page, total: displayInteger(displayRecord(value).total, page.rows.length) } : page;
}

export function parseSubagentSummaryPage(value: unknown): AuxiliaryResponse<SubagentSummaryPage> {
  const raw = displayRecord(value);
  if (raw.kind !== 'available') return parsePreparing(raw);
  const identity = parseAuxiliaryIdentity(raw);
  const statuses = ['idle', 'running', 'waiting', 'interrupted', 'completed', 'closed', 'error', 'observing'] as const;
  const entries = displayArray(raw.entries, 50).map(value => {
    const entry = displayRecord(value), status = statuses.find(status => status === entry.status);
    if (entry.kind !== 'subagent' || !status) throw new TypeError('Invalid subagent summary');
    const optional = (key: string): string | undefined => {
      const preview = entry[key];
      if (preview === undefined) return undefined;
      if (typeof preview !== 'string' || preview.length > 300) throw new TypeError('Invalid subagent preview');
      return preview;
    };
    return { id: displayString(entry.id), kind: 'subagent' as const, name: displayString(entry.name, 300), status,
      statusLabel: displayString(entry.statusLabel, 300), model: optional('model'), path: optional('path'), message: optional('message'),
      lastActionLabel: optional('lastActionLabel'), anchorOrdinal: displayInteger(entry.anchorOrdinal, 1, identity.watermark) };
  });
  return { ...identity, kind: 'available', entries, nextAfterOrder: raw.nextAfterOrder === null ? null : displayInteger(raw.nextAfterOrder, 1) };
}

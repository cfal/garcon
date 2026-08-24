import type {
  TranscriptExportCategory,
  TranscriptExportOmittedCount,
} from '../../common/chat-export-contracts.js';
import {
  isCarryoverMigrationQuarantineNoticeDetail,
  isToolUseMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import type { AgentRunFailureDetail } from '@garcon/server-agent-interface';
import type { LedgerRow } from './contracts.js';
import { ledgerRowToMessage } from './presentation.js';

export type TranscriptExportEntryCategory = TranscriptExportCategory | 'conversation';

export type TranscriptExportEntry =
  | {
      readonly kind: 'message';
      readonly ordinal: number;
      readonly category: TranscriptExportEntryCategory;
      readonly message: ChatMessage;
    }
  | {
      readonly kind: 'run-ended';
      readonly ordinal: number;
      readonly category: 'diagnostics';
      readonly at: string;
      readonly outcome: 'finished' | 'failed' | 'interrupted';
      readonly origin: 'provider' | 'core';
      readonly error?: AgentRunFailureDetail;
    };

export interface FilteredTranscriptExportEntries {
  readonly entries: readonly TranscriptExportEntry[];
  readonly omitted: readonly TranscriptExportOmittedCount[];
}

export function foldRowsForExport(rows: readonly LedgerRow[]): TranscriptExportEntry[] {
  const entries: TranscriptExportEntry[] = [];
  for (const row of rows) {
    if (row.kind === 'session') continue;
    if (row.kind === 'run-ended') {
      entries.push({
        kind: 'run-ended',
        ordinal: row.ordinal,
        category: 'diagnostics',
        at: row.at,
        outcome: row.outcome,
        origin: row.origin,
        ...(row.error === undefined ? {} : { error: { ...row.error } }),
      });
      continue;
    }
    const message = ledgerRowToMessage(row);
    if (!message) continue;
    entries.push({
      kind: 'message',
      ordinal: row.ordinal,
      category: exportCategoryForMessage(message),
      message,
    });
  }
  return entries;
}

export function filterTranscriptExportEntries(
  entries: readonly TranscriptExportEntry[],
  exclusions: readonly TranscriptExportCategory[],
): FilteredTranscriptExportEntries {
  const excluded = new Set<TranscriptExportCategory>(exclusions);
  const counts = new Map<TranscriptExportCategory, number>(
    exclusions.map((category) => [category, 0]),
  );
  const kept = entries.filter((entry) => {
    if (entry.category === 'conversation' || !excluded.has(entry.category)) return true;
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    return false;
  });
  return {
    entries: kept,
    omitted: exclusions.map((category) => ({ category, count: counts.get(category) ?? 0 })),
  };
}

export function exportCategoryForMessage(message: ChatMessage): TranscriptExportEntryCategory {
  if (isToolUseMessage(message)) return 'tool-calls';
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
    case 'compaction':
      return 'conversation';
    case 'thinking':
      return 'reasoning';
    case 'tool-result':
      return 'tool-results';
    case 'permission-request':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired':
      return 'permissions';
    case 'error':
    case 'cli-row':
      return 'diagnostics';
    case 'transcript-notice':
      return isCarryoverMigrationQuarantineNoticeDetail(message.detail)
        ? 'conversation'
        : 'diagnostics';
    case 'agent-switch':
      return 'handoffs';
    default:
      return assertNever(message);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported transcript export message: ${String(value)}`);
}

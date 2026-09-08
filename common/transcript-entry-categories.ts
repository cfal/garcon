import { isToolUseMessage, type ChatMessage } from './chat-types.js';
import { isCarryoverMigrationQuarantineNoticeDetail } from './transcript-notice-details.js';

export const TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES = [
  'tool-calls',
  'tool-results',
  'reasoning',
  'permissions',
  'diagnostics',
  'handoffs',
] as const;

export type TranscriptEntryOptionalCategory =
  (typeof TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES)[number];

export type TranscriptEntryCategory = TranscriptEntryOptionalCategory | 'conversation';

export const TRANSCRIPT_ENTRY_CATEGORY_ALIASES = {
  tools: ['tool-calls', 'tool-results'],
} as const satisfies Record<string, readonly TranscriptEntryOptionalCategory[]>;

const categorySet = new Set<string>(TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES);

export function isTranscriptEntryOptionalCategory(
  value: unknown,
): value is TranscriptEntryOptionalCategory {
  return typeof value === 'string' && categorySet.has(value);
}

export function canonicalTranscriptEntryOptionalCategories(
  categories: Iterable<TranscriptEntryOptionalCategory>,
): TranscriptEntryOptionalCategory[] {
  const selected = new Set(categories);
  return TRANSCRIPT_ENTRY_OPTIONAL_CATEGORIES.filter((category) => selected.has(category));
}

export function transcriptEntryCategoryForMessage(message: ChatMessage): TranscriptEntryCategory {
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
  throw new TypeError(`Unsupported transcript message: ${String(value)}`);
}

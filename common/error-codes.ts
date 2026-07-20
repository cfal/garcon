// Single registry for every structured error code that can cross a server
// boundary. `DomainError` is constructed with one of these, and the wire-facing
// `CommandErrorCode` / `ClientRequestErrorCode` vocabularies are narrowing
// subsets of it (see `chat-command-contracts.ts` and `ws-events.ts`). Adding a
// server error code means adding it here first.
export const ERROR_CODES = [
  // Generic
  'VALIDATION_FAILED',
  'INTERNAL_ERROR',
  'SESSION_NOT_FOUND',
  'SESSION_BUSY',
  'IDEMPOTENCY_CONFLICT',
  'REQUEST_NOT_FOUND',
  'SERVER_SHUTTING_DOWN',
  // Queue mutations
  'QUEUE_ENTRY_NOT_FOUND',
  'QUEUE_ENTRY_ALREADY_SENT',
  'QUEUE_ENTRY_REVISION_CONFLICT',
  'QUEUE_PAUSE_CHANGED',
  // Active input
  'ACTIVE_INPUT_NOT_DELIVERED',
  'ACTIVE_INPUT_OUTCOME_UNKNOWN',
  // Agents and project paths
  'UNSUPPORTED_AGENT',
  'CHAT_NOT_IDLE',
  'PROJECT_PATH_UPDATE_UNSUPPORTED',
  'PROJECT_PATH_OUTSIDE_BASE',
  'PROJECT_PATH_NOT_FOUND',
  'PROJECT_PATH_NOT_DIRECTORY',
  'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
  'FOLDER_ALREADY_EXISTS',
  'SAVED_SEARCH_ALREADY_EXISTS',
  // Client-request transport
  'MISSING_CHAT_ID',
  'REQUEST_VALIDATION_FAILED',
  'CHAT_RUNNING',
  'NATIVE_PATH_UNRESOLVED',
  'HISTORY_LOAD_FAILED',
  'REQUEST_TIMEOUT',
  // Feature-specific (not part of the command/client-request subsets)
  'TITLE_GENERATION_EMPTY',
  'TITLE_GENERATION_FAILED',
  'TITLE_GENERATION_UNAVAILABLE',
  'FILE_CHANGED_DURING_READ',
  'FILE_PATH_MUST_IDENTIFY_FILE',
  'FOLDER_NOT_FOUND',
  'SAVED_SEARCH_NOT_FOUND',
  'GENERATION_TEST_UNAVAILABLE',
  'GENERATION_TEST_CONFIGURATION_CHANGED',
  'GENERATION_TEST_UNSUPPORTED_EFFORT',
  'GENERATION_TEST_EMPTY_RESPONSE',
  'GENERATION_TEST_TIMEOUT',
  'GENERATION_TEST_FAILED',
  'TRANSCRIPT_SEARCH_DISABLED',
  'SEARCH_INDEX_UNAVAILABLE',
  'SEARCH_INDEX_BUSY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

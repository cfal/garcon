//! Ports `common/error-codes.ts`.
//!
//! The single registry of every structured error code that can cross a server
//! boundary. `DomainError` is constructed with one of these, and the
//! wire-facing `CommandErrorCode` and `ClientRequestErrorCode` vocabularies
//! are narrowing subsets of it. Adding a server error code means adding it
//! here first.

use std::fmt;

use serde_json::Value;

/// One of the registered error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ErrorCode(&'static str);

impl ErrorCode {
    pub const AUTH_VALIDATION_FAILED: ErrorCode = ErrorCode("AUTH_VALIDATION_FAILED");
    pub const AUTH_CURRENT_PASSWORD_INVALID: ErrorCode = ErrorCode("AUTH_CURRENT_PASSWORD_INVALID");
    pub const AUTH_NO_CHANGE: ErrorCode = ErrorCode("AUTH_NO_CHANGE");
    pub const AUTH_CREDENTIALS_INVALID: ErrorCode = ErrorCode("AUTH_CREDENTIALS_INVALID");
    pub const AUTH_SESSION_INVALID: ErrorCode = ErrorCode("AUTH_SESSION_INVALID");
    pub const AUTH_CHANGE_FORBIDDEN: ErrorCode = ErrorCode("AUTH_CHANGE_FORBIDDEN");
    pub const AUTH_REVISION_EXHAUSTED: ErrorCode = ErrorCode("AUTH_REVISION_EXHAUSTED");
    pub const AUTH_REQUEST_TOO_LARGE: ErrorCode = ErrorCode("AUTH_REQUEST_TOO_LARGE");
    pub const AUTH_BUSY: ErrorCode = ErrorCode("AUTH_BUSY");
    pub const AUTH_SAVE_FAILED: ErrorCode = ErrorCode("AUTH_SAVE_FAILED");
    pub const AUTH_STORAGE_UNAVAILABLE: ErrorCode = ErrorCode("AUTH_STORAGE_UNAVAILABLE");
    // Generic
    pub const VALIDATION_FAILED: ErrorCode = ErrorCode("VALIDATION_FAILED");
    pub const INTERNAL_ERROR: ErrorCode = ErrorCode("INTERNAL_ERROR");
    pub const SESSION_NOT_FOUND: ErrorCode = ErrorCode("SESSION_NOT_FOUND");
    pub const NATIVE_SESSION_NOT_FOUND: ErrorCode = ErrorCode("NATIVE_SESSION_NOT_FOUND");
    pub const NATIVE_SESSION_AMBIGUOUS: ErrorCode = ErrorCode("NATIVE_SESSION_AMBIGUOUS");
    pub const SESSION_BUSY: ErrorCode = ErrorCode("SESSION_BUSY");
    pub const IDEMPOTENCY_CONFLICT: ErrorCode = ErrorCode("IDEMPOTENCY_CONFLICT");
    pub const CHAT_ID_COLLISION: ErrorCode = ErrorCode("CHAT_ID_COLLISION");
    pub const SESSION_LIMIT: ErrorCode = ErrorCode("SESSION_LIMIT");
    pub const REQUEST_NOT_FOUND: ErrorCode = ErrorCode("REQUEST_NOT_FOUND");
    pub const TURN_RECEIPT_NOT_FOUND: ErrorCode = ErrorCode("TURN_RECEIPT_NOT_FOUND");
    pub const TURN_RESULT_EXPIRED: ErrorCode = ErrorCode("TURN_RESULT_EXPIRED");
    pub const SERVER_SHUTTING_DOWN: ErrorCode = ErrorCode("SERVER_SHUTTING_DOWN");
    pub const REQUEST_CANCELLED: ErrorCode = ErrorCode("REQUEST_CANCELLED");
    // Executor CLI bridge
    pub const CLI_CONTROLLER_UNAVAILABLE: ErrorCode = ErrorCode("CLI_CONTROLLER_UNAVAILABLE");
    pub const CLI_CONTROLLER_CHANGED: ErrorCode = ErrorCode("CLI_CONTROLLER_CHANGED");
    pub const CLI_ACCESS_DENIED: ErrorCode = ErrorCode("CLI_ACCESS_DENIED");
    pub const CLI_SERVICE_BUSY: ErrorCode = ErrorCode("CLI_SERVICE_BUSY");
    pub const CLI_REQUEST_TOO_LARGE: ErrorCode = ErrorCode("CLI_REQUEST_TOO_LARGE");
    pub const CLI_RESULT_TOO_LARGE: ErrorCode = ErrorCode("CLI_RESULT_TOO_LARGE");
    pub const CLI_OUTCOME_UNKNOWN: ErrorCode = ErrorCode("CLI_OUTCOME_UNKNOWN");
    // Queue mutations
    pub const QUEUE_ENTRY_NOT_FOUND: ErrorCode = ErrorCode("QUEUE_ENTRY_NOT_FOUND");
    pub const QUEUE_ENTRY_ALREADY_SENT: ErrorCode = ErrorCode("QUEUE_ENTRY_ALREADY_SENT");
    pub const QUEUE_ENTRY_IN_FLIGHT: ErrorCode = ErrorCode("QUEUE_ENTRY_IN_FLIGHT");
    pub const QUEUE_ENTRY_REVISION_CONFLICT: ErrorCode = ErrorCode("QUEUE_ENTRY_REVISION_CONFLICT");
    pub const QUEUE_ENTRY_REORDER_CONFLICT: ErrorCode = ErrorCode("QUEUE_ENTRY_REORDER_CONFLICT");
    pub const QUEUE_PAUSE_CHANGED: ErrorCode = ErrorCode("QUEUE_PAUSE_CHANGED");
    pub const CONTROL_INPUT_QUEUE_FULL: ErrorCode = ErrorCode("CONTROL_INPUT_QUEUE_FULL");
    pub const QUEUE_ATTACHMENTS_FULL: ErrorCode = ErrorCode("QUEUE_ATTACHMENTS_FULL");
    // Strict steering
    pub const STEER_NOT_DELIVERED: ErrorCode = ErrorCode("STEER_NOT_DELIVERED");
    pub const STEER_OUTCOME_UNKNOWN: ErrorCode = ErrorCode("STEER_OUTCOME_UNKNOWN");
    pub const STEER_PROVIDER_REJECTED: ErrorCode = ErrorCode("STEER_PROVIDER_REJECTED");
    pub const STEER_TURN_UNAVAILABLE: ErrorCode = ErrorCode("STEER_TURN_UNAVAILABLE");
    pub const STEER_TURN_CHANGED: ErrorCode = ErrorCode("STEER_TURN_CHANGED");
    pub const STEER_TURN_NOT_STEERABLE: ErrorCode = ErrorCode("STEER_TURN_NOT_STEERABLE");
    pub const STEER_CAPACITY_EXHAUSTED: ErrorCode = ErrorCode("STEER_CAPACITY_EXHAUSTED");
    pub const QUEUE_STEER_FINALIZATION_FAILED: ErrorCode =
        ErrorCode("QUEUE_STEER_FINALIZATION_FAILED");
    pub const QUEUE_STEER_RECOVERY_FAILED: ErrorCode = ErrorCode("QUEUE_STEER_RECOVERY_FAILED");
    pub const PERMISSION_NOT_ACTIONABLE: ErrorCode = ErrorCode("PERMISSION_NOT_ACTIONABLE");
    pub const PERMISSION_DECISION_NOT_DELIVERED: ErrorCode =
        ErrorCode("PERMISSION_DECISION_NOT_DELIVERED");
    pub const PERMISSION_DECISION_OUTCOME_UNKNOWN: ErrorCode =
        ErrorCode("PERMISSION_DECISION_OUTCOME_UNKNOWN");
    // Agents and project paths
    pub const UNSUPPORTED_AGENT: ErrorCode = ErrorCode("UNSUPPORTED_AGENT");
    pub const EXECUTOR_NOT_FOUND: ErrorCode = ErrorCode("EXECUTOR_NOT_FOUND");
    pub const EXECUTOR_BUSY: ErrorCode = ErrorCode("EXECUTOR_BUSY");
    pub const EXECUTOR_UNAVAILABLE: ErrorCode = ErrorCode("EXECUTOR_UNAVAILABLE");
    pub const LOGIN_INSTANCE_CHANGED: ErrorCode = ErrorCode("LOGIN_INSTANCE_CHANGED");
    pub const MODEL_DISCOVERY_UNAVAILABLE: ErrorCode = ErrorCode("MODEL_DISCOVERY_UNAVAILABLE");
    pub const EXECUTOR_IN_USE: ErrorCode = ErrorCode("EXECUTOR_IN_USE");
    pub const API_PROVIDER_UNAVAILABLE: ErrorCode = ErrorCode("API_PROVIDER_UNAVAILABLE");
    pub const API_PROVIDER_CONFIGURATION_CHANGED: ErrorCode =
        ErrorCode("API_PROVIDER_CONFIGURATION_CHANGED");
    pub const API_PROVIDER_IN_USE: ErrorCode = ErrorCode("API_PROVIDER_IN_USE");
    pub const API_PROVIDER_STORAGE_UNAVAILABLE: ErrorCode =
        ErrorCode("API_PROVIDER_STORAGE_UNAVAILABLE");
    pub const EXPECTED_AGENT_MISMATCH: ErrorCode = ErrorCode("EXPECTED_AGENT_MISMATCH");
    pub const EXPLICIT_BYPASS_REQUIRED: ErrorCode = ErrorCode("EXPLICIT_BYPASS_REQUIRED");
    pub const INCOMPLETE_EXECUTION_CONFIG: ErrorCode = ErrorCode("INCOMPLETE_EXECUTION_CONFIG");
    pub const STALE_CHAT_OWNERSHIP: ErrorCode = ErrorCode("STALE_CHAT_OWNERSHIP");
    pub const OWNERSHIP_TRANSFER_PENDING: ErrorCode = ErrorCode("OWNERSHIP_TRANSFER_PENDING");
    pub const AGENT_HANDOFF_REQUIRES_IDLE: ErrorCode = ErrorCode("AGENT_HANDOFF_REQUIRES_IDLE");
    pub const CARRYOVER_COMPACTION_REQUIRED: ErrorCode = ErrorCode("CARRYOVER_COMPACTION_REQUIRED");
    pub const CARRYOVER_COMPACTION_UNAVAILABLE: ErrorCode =
        ErrorCode("CARRYOVER_COMPACTION_UNAVAILABLE");
    pub const CARRYOVER_COMPACTION_FAILED: ErrorCode = ErrorCode("CARRYOVER_COMPACTION_FAILED");
    pub const SOURCE_TRANSCRIPT_UNAVAILABLE: ErrorCode = ErrorCode("SOURCE_TRANSCRIPT_UNAVAILABLE");
    pub const CARRYOVER_HISTORY_UNAVAILABLE: ErrorCode = ErrorCode("CARRYOVER_HISTORY_UNAVAILABLE");
    pub const CONTEXT_ENVELOPE_MISMATCH: ErrorCode = ErrorCode("CONTEXT_ENVELOPE_MISMATCH");
    pub const CHAT_DELETED: ErrorCode = ErrorCode("CHAT_DELETED");
    pub const OPERATION_UNSUPPORTED: ErrorCode = ErrorCode("OPERATION_UNSUPPORTED");
    pub const SOURCE_REVISION_CHANGED: ErrorCode = ErrorCode("SOURCE_REVISION_CHANGED");
    pub const TRANSCRIPT_UNAVAILABLE: ErrorCode = ErrorCode("TRANSCRIPT_UNAVAILABLE");
    pub const TRANSCRIPT_WORK_BUSY: ErrorCode = ErrorCode("TRANSCRIPT_WORK_BUSY");
    pub const TRANSCRIPT_READ_INTERRUPTED: ErrorCode = ErrorCode("TRANSCRIPT_READ_INTERRUPTED");
    pub const SHARE_STORAGE_UNAVAILABLE: ErrorCode = ErrorCode("SHARE_STORAGE_UNAVAILABLE");
    pub const TRANSCRIPT_DEFERRED: ErrorCode = ErrorCode("TRANSCRIPT_DEFERRED");
    pub const TRANSCRIPT_NOT_YET_PERSISTED: ErrorCode = ErrorCode("TRANSCRIPT_NOT_YET_PERSISTED");
    pub const STALE_TRANSCRIPT_VIEW: ErrorCode = ErrorCode("STALE_TRANSCRIPT_VIEW");
    pub const TRANSCRIPT_CURSOR_AHEAD: ErrorCode = ErrorCode("TRANSCRIPT_CURSOR_AHEAD");
    pub const TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN: ErrorCode =
        ErrorCode("TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN");
    pub const AGENT_RESUME_NOT_DELEGATED: ErrorCode = ErrorCode("AGENT_RESUME_NOT_DELEGATED");
    pub const AGENT_STOP_NOT_DELEGATED: ErrorCode = ErrorCode("AGENT_STOP_NOT_DELEGATED");
    pub const CHAT_NOT_IDLE: ErrorCode = ErrorCode("CHAT_NOT_IDLE");
    pub const ORDER_CROSS_GROUP: ErrorCode = ErrorCode("ORDER_CROSS_GROUP");
    pub const PROJECT_PATH_UPDATE_UNSUPPORTED: ErrorCode =
        ErrorCode("PROJECT_PATH_UPDATE_UNSUPPORTED");
    pub const PROJECT_PATH_DESTINATION_REJECTED: ErrorCode =
        ErrorCode("PROJECT_PATH_DESTINATION_REJECTED");
    pub const PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN: ErrorCode =
        ErrorCode("PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN");
    pub const PROJECT_PATH_UPDATE_FAILED: ErrorCode = ErrorCode("PROJECT_PATH_UPDATE_FAILED");
    pub const PROJECT_PATH_OUTSIDE_BASE: ErrorCode = ErrorCode("PROJECT_PATH_OUTSIDE_BASE");
    pub const PROJECT_PATH_NOT_FOUND: ErrorCode = ErrorCode("PROJECT_PATH_NOT_FOUND");
    pub const PROJECT_PATH_NOT_DIRECTORY: ErrorCode = ErrorCode("PROJECT_PATH_NOT_DIRECTORY");
    pub const PROJECT_PATH_CHANGED: ErrorCode = ErrorCode("PROJECT_PATH_CHANGED");
    pub const PROJECT_UNAVAILABLE: ErrorCode = ErrorCode("PROJECT_UNAVAILABLE");
    pub const PROJECT_PATH_NATIVE_PATH_UNRESOLVED: ErrorCode =
        ErrorCode("PROJECT_PATH_NATIVE_PATH_UNRESOLVED");
    pub const FOLDER_ALREADY_EXISTS: ErrorCode = ErrorCode("FOLDER_ALREADY_EXISTS");
    pub const SAVED_SEARCH_ALREADY_EXISTS: ErrorCode = ErrorCode("SAVED_SEARCH_ALREADY_EXISTS");
    pub const SEARCH_RESULT_STALE: ErrorCode = ErrorCode("SEARCH_RESULT_STALE");
    // Client-request transport
    pub const MISSING_CHAT_ID: ErrorCode = ErrorCode("MISSING_CHAT_ID");
    pub const REQUEST_VALIDATION_FAILED: ErrorCode = ErrorCode("REQUEST_VALIDATION_FAILED");
    pub const CHAT_RUNNING: ErrorCode = ErrorCode("CHAT_RUNNING");
    pub const NATIVE_PATH_UNRESOLVED: ErrorCode = ErrorCode("NATIVE_PATH_UNRESOLVED");
    pub const HISTORY_LOAD_FAILED: ErrorCode = ErrorCode("HISTORY_LOAD_FAILED");
    pub const REQUEST_TIMEOUT: ErrorCode = ErrorCode("REQUEST_TIMEOUT");
    // Feature-specific (not part of the command/client-request subsets)
    pub const TITLE_GENERATION_EMPTY: ErrorCode = ErrorCode("TITLE_GENERATION_EMPTY");
    pub const TITLE_GENERATION_FAILED: ErrorCode = ErrorCode("TITLE_GENERATION_FAILED");
    pub const TITLE_GENERATION_UNAVAILABLE: ErrorCode = ErrorCode("TITLE_GENERATION_UNAVAILABLE");
    pub const FILE_CHANGED_DURING_READ: ErrorCode = ErrorCode("FILE_CHANGED_DURING_READ");
    pub const FILE_PATH_MUST_IDENTIFY_FILE: ErrorCode = ErrorCode("FILE_PATH_MUST_IDENTIFY_FILE");
    pub const FILE_TOO_LARGE: ErrorCode = ErrorCode("FILE_TOO_LARGE");
    pub const FILE_REVISION_CONFLICT: ErrorCode = ErrorCode("FILE_REVISION_CONFLICT");
    pub const FILE_NOT_FOUND: ErrorCode = ErrorCode("FILE_NOT_FOUND");
    pub const FILE_PERMISSION_DENIED: ErrorCode = ErrorCode("FILE_PERMISSION_DENIED");
    pub const FILE_OUTSIDE_ROOT: ErrorCode = ErrorCode("FILE_OUTSIDE_ROOT");
    pub const FILE_DIRECTORY_REQUIRED: ErrorCode = ErrorCode("FILE_DIRECTORY_REQUIRED");
    pub const FILE_LIST_TOO_LARGE: ErrorCode = ErrorCode("FILE_LIST_TOO_LARGE");
    pub const FILE_SERVICE_BUSY: ErrorCode = ErrorCode("FILE_SERVICE_BUSY");
    pub const FILE_INVALID_DATA: ErrorCode = ErrorCode("FILE_INVALID_DATA");
    pub const FILE_SAVE_OUTCOME_UNKNOWN: ErrorCode = ErrorCode("FILE_SAVE_OUTCOME_UNKNOWN");
    pub const FILE_ALREADY_EXISTS: ErrorCode = ErrorCode("FILE_ALREADY_EXISTS");
    pub const FILE_CREATE_OUTCOME_UNKNOWN: ErrorCode = ErrorCode("FILE_CREATE_OUTCOME_UNKNOWN");
    pub const FOLDER_NOT_FOUND: ErrorCode = ErrorCode("FOLDER_NOT_FOUND");
    pub const SAVED_SEARCH_NOT_FOUND: ErrorCode = ErrorCode("SAVED_SEARCH_NOT_FOUND");
    pub const GENERATION_TEST_UNAVAILABLE: ErrorCode = ErrorCode("GENERATION_TEST_UNAVAILABLE");
    pub const GENERATION_TEST_CONFIGURATION_CHANGED: ErrorCode =
        ErrorCode("GENERATION_TEST_CONFIGURATION_CHANGED");
    pub const GENERATION_TEST_UNSUPPORTED_EFFORT: ErrorCode =
        ErrorCode("GENERATION_TEST_UNSUPPORTED_EFFORT");
    pub const GENERATION_TEST_UNSAFE_AGENT: ErrorCode = ErrorCode("GENERATION_TEST_UNSAFE_AGENT");
    pub const GENERATION_TEST_EMPTY_RESPONSE: ErrorCode =
        ErrorCode("GENERATION_TEST_EMPTY_RESPONSE");
    pub const GENERATION_TEST_TIMEOUT: ErrorCode = ErrorCode("GENERATION_TEST_TIMEOUT");
    pub const GENERATION_TEST_FAILED: ErrorCode = ErrorCode("GENERATION_TEST_FAILED");
    pub const PROMPT_REFINEMENT_INVALID_REQUEST: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_INVALID_REQUEST");
    pub const PROMPT_REFINEMENT_INPUT_TOO_LONG: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_INPUT_TOO_LONG");
    pub const PROMPT_REFINEMENT_UNAVAILABLE: ErrorCode = ErrorCode("PROMPT_REFINEMENT_UNAVAILABLE");
    pub const PROMPT_REFINEMENT_UNSAFE_AGENT: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_UNSAFE_AGENT");
    pub const PROMPT_REFINEMENT_TEMPLATE_INVALID: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_TEMPLATE_INVALID");
    pub const PROMPT_REFINEMENT_AUTH_REQUIRED: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_AUTH_REQUIRED");
    pub const PROMPT_REFINEMENT_RATE_LIMITED: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_RATE_LIMITED");
    pub const PROMPT_REFINEMENT_AGENT_UNAVAILABLE: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_AGENT_UNAVAILABLE");
    pub const PROMPT_REFINEMENT_UNSUPPORTED_EFFORT: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_UNSUPPORTED_EFFORT");
    pub const PROMPT_REFINEMENT_EMPTY_RESPONSE: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_EMPTY_RESPONSE");
    pub const PROMPT_REFINEMENT_OUTPUT_TOO_LONG: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_OUTPUT_TOO_LONG");
    pub const PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED: ErrorCode =
        ErrorCode("PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED");
    pub const PROMPT_REFINEMENT_TIMEOUT: ErrorCode = ErrorCode("PROMPT_REFINEMENT_TIMEOUT");
    pub const PROMPT_REFINEMENT_FAILED: ErrorCode = ErrorCode("PROMPT_REFINEMENT_FAILED");
    pub const TRANSCRIPT_SEARCH_DISABLED: ErrorCode = ErrorCode("TRANSCRIPT_SEARCH_DISABLED");
    pub const SEARCH_INDEX_UNAVAILABLE: ErrorCode = ErrorCode("SEARCH_INDEX_UNAVAILABLE");
    pub const SEARCH_INDEX_BUSY: ErrorCode = ErrorCode("SEARCH_INDEX_BUSY");
    pub const SEARCH_TIMEOUT: ErrorCode = ErrorCode("SEARCH_TIMEOUT");
    pub const CHAT_TAGS_SAVE_UNKNOWN: ErrorCode = ErrorCode("CHAT_TAGS_SAVE_UNKNOWN");
    pub const PARENT_CHAT_NOT_FOUND: ErrorCode = ErrorCode("PARENT_CHAT_NOT_FOUND");
    pub const CHAT_PARENT_CYCLE: ErrorCode = ErrorCode("CHAT_PARENT_CYCLE");
    pub const CHAT_PARENT_SAVE_FAILED: ErrorCode = ErrorCode("CHAT_PARENT_SAVE_FAILED");
    pub const CHAT_PARENT_SAVE_UNKNOWN: ErrorCode = ErrorCode("CHAT_PARENT_SAVE_UNKNOWN");
    pub const PREAMBLE_VALIDATION_FAILED: ErrorCode = ErrorCode("PREAMBLE_VALIDATION_FAILED");
    pub const PREAMBLE_NOT_FOUND: ErrorCode = ErrorCode("PREAMBLE_NOT_FOUND");
    pub const PREAMBLE_REVISION_CONFLICT: ErrorCode = ErrorCode("PREAMBLE_REVISION_CONFLICT");
    pub const PREAMBLE_REVISION_EXHAUSTED: ErrorCode = ErrorCode("PREAMBLE_REVISION_EXHAUSTED");
    pub const PREAMBLE_LIMIT_REACHED: ErrorCode = ErrorCode("PREAMBLE_LIMIT_REACHED");
    pub const PREAMBLE_COMBINED_LIMIT_EXCEEDED: ErrorCode =
        ErrorCode("PREAMBLE_COMBINED_LIMIT_EXCEEDED");
    pub const PREAMBLE_PROJECT_PATH_OUTSIDE_BASE: ErrorCode =
        ErrorCode("PREAMBLE_PROJECT_PATH_OUTSIDE_BASE");
    pub const PREAMBLE_PROJECT_PATH_NOT_FOUND: ErrorCode =
        ErrorCode("PREAMBLE_PROJECT_PATH_NOT_FOUND");
    pub const PREAMBLE_PROJECT_PATH_INACCESSIBLE: ErrorCode =
        ErrorCode("PREAMBLE_PROJECT_PATH_INACCESSIBLE");
    pub const PREAMBLE_PROJECT_PATH_NOT_DIRECTORY: ErrorCode =
        ErrorCode("PREAMBLE_PROJECT_PATH_NOT_DIRECTORY");
    pub const PREAMBLE_ENVELOPE_MISMATCH: ErrorCode = ErrorCode("PREAMBLE_ENVELOPE_MISMATCH");
    pub const PREAMBLE_SLASH_COMMAND_BLOCKED: ErrorCode =
        ErrorCode("PREAMBLE_SLASH_COMMAND_BLOCKED");
    pub const PREAMBLE_ID_COLLISION: ErrorCode = ErrorCode("PREAMBLE_ID_COLLISION");
    pub const PREAMBLE_ID_LIFETIME_LIMIT_REACHED: ErrorCode =
        ErrorCode("PREAMBLE_ID_LIFETIME_LIMIT_REACHED");
    pub const PREAMBLE_CATALOG_SAVE_UNKNOWN: ErrorCode = ErrorCode("PREAMBLE_CATALOG_SAVE_UNKNOWN");
    pub const PREAMBLE_SELECTION_REVISION_CONFLICT: ErrorCode =
        ErrorCode("PREAMBLE_SELECTION_REVISION_CONFLICT");
    pub const PREAMBLE_SELECTION_COMPOSITION_INVALID: ErrorCode =
        ErrorCode("PREAMBLE_SELECTION_COMPOSITION_INVALID");
    pub const PREAMBLE_SELECTION_NOTICE_FAILED: ErrorCode =
        ErrorCode("PREAMBLE_SELECTION_NOTICE_FAILED");
    pub const PREAMBLE_SELECTION_SAVE_UNKNOWN: ErrorCode =
        ErrorCode("PREAMBLE_SELECTION_SAVE_UNKNOWN");
    // Workspace tickets
    pub const TICKET_VALIDATION_FAILED: ErrorCode = ErrorCode("TICKET_VALIDATION_FAILED");
    pub const TICKET_UNAUTHORIZED: ErrorCode = ErrorCode("TICKET_UNAUTHORIZED");
    pub const TICKET_FORBIDDEN: ErrorCode = ErrorCode("TICKET_FORBIDDEN");
    pub const TICKET_COMMANDS_DISABLED: ErrorCode = ErrorCode("TICKET_COMMANDS_DISABLED");
    pub const TICKET_NOT_FOUND: ErrorCode = ErrorCode("TICKET_NOT_FOUND");
    pub const TICKET_COMMENT_NOT_FOUND: ErrorCode = ErrorCode("TICKET_COMMENT_NOT_FOUND");
    pub const TICKET_CHAT_NOT_FOUND: ErrorCode = ErrorCode("TICKET_CHAT_NOT_FOUND");
    pub const TICKET_STORE_CHANGED: ErrorCode = ErrorCode("TICKET_STORE_CHANGED");
    pub const TICKET_REVISION_CONFLICT: ErrorCode = ErrorCode("TICKET_REVISION_CONFLICT");
    pub const TICKET_COMMENT_REVISION_CONFLICT: ErrorCode =
        ErrorCode("TICKET_COMMENT_REVISION_CONFLICT");
    pub const TICKET_ALREADY_CLAIMED: ErrorCode = ErrorCode("TICKET_ALREADY_CLAIMED");
    pub const TICKET_REQUEST_CONFLICT: ErrorCode = ErrorCode("TICKET_REQUEST_CONFLICT");
    pub const TICKET_COLLECTION_CHANGED: ErrorCode = ErrorCode("TICKET_COLLECTION_CHANGED");
    pub const TICKET_RELATIONSHIP_CYCLE: ErrorCode = ErrorCode("TICKET_RELATIONSHIP_CYCLE");
    pub const TICKET_INVALID_TRANSITION: ErrorCode = ErrorCode("TICKET_INVALID_TRANSITION");
    pub const TICKET_LIMIT_REACHED: ErrorCode = ErrorCode("TICKET_LIMIT_REACHED");
    pub const TICKET_SOURCE_UNAVAILABLE: ErrorCode = ErrorCode("TICKET_SOURCE_UNAVAILABLE");
    pub const TICKET_REQUEST_TOO_LARGE: ErrorCode = ErrorCode("TICKET_REQUEST_TOO_LARGE");
    pub const TICKET_RESULT_TOO_LARGE: ErrorCode = ErrorCode("TICKET_RESULT_TOO_LARGE");
    pub const TICKET_PROJECT_UNAVAILABLE: ErrorCode = ErrorCode("TICKET_PROJECT_UNAVAILABLE");
    pub const TICKET_STORAGE_UNAVAILABLE: ErrorCode = ErrorCode("TICKET_STORAGE_UNAVAILABLE");
    pub const TICKET_INTERNAL_ERROR: ErrorCode = ErrorCode("TICKET_INTERNAL_ERROR");
    pub const PULL_REQUEST_REVIEW_VALIDATION_FAILED: ErrorCode =
        ErrorCode("PULL_REQUEST_REVIEW_VALIDATION_FAILED");
    pub const PULL_REQUEST_REVIEW_NOT_FOUND: ErrorCode = ErrorCode("PULL_REQUEST_REVIEW_NOT_FOUND");
    pub const PULL_REQUEST_REVIEW_CONFLICT: ErrorCode = ErrorCode("PULL_REQUEST_REVIEW_CONFLICT");
    pub const PULL_REQUEST_REVIEW_LIMIT_REACHED: ErrorCode =
        ErrorCode("PULL_REQUEST_REVIEW_LIMIT_REACHED");
    pub const PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE: ErrorCode =
        ErrorCode("PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE");
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

/// Every registered code, in registry order.
pub const ERROR_CODES: &[ErrorCode] = &[
    ErrorCode::AUTH_VALIDATION_FAILED,
    ErrorCode::AUTH_CURRENT_PASSWORD_INVALID,
    ErrorCode::AUTH_NO_CHANGE,
    ErrorCode::AUTH_CREDENTIALS_INVALID,
    ErrorCode::AUTH_SESSION_INVALID,
    ErrorCode::AUTH_CHANGE_FORBIDDEN,
    ErrorCode::AUTH_REVISION_EXHAUSTED,
    ErrorCode::AUTH_REQUEST_TOO_LARGE,
    ErrorCode::AUTH_BUSY,
    ErrorCode::AUTH_SAVE_FAILED,
    ErrorCode::AUTH_STORAGE_UNAVAILABLE,
    // Generic
    ErrorCode::VALIDATION_FAILED,
    ErrorCode::INTERNAL_ERROR,
    ErrorCode::SESSION_NOT_FOUND,
    ErrorCode::NATIVE_SESSION_NOT_FOUND,
    ErrorCode::NATIVE_SESSION_AMBIGUOUS,
    ErrorCode::SESSION_BUSY,
    ErrorCode::IDEMPOTENCY_CONFLICT,
    ErrorCode::CHAT_ID_COLLISION,
    ErrorCode::SESSION_LIMIT,
    ErrorCode::REQUEST_NOT_FOUND,
    ErrorCode::TURN_RECEIPT_NOT_FOUND,
    ErrorCode::TURN_RESULT_EXPIRED,
    ErrorCode::SERVER_SHUTTING_DOWN,
    ErrorCode::REQUEST_CANCELLED,
    // Executor CLI bridge
    ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
    ErrorCode::CLI_CONTROLLER_CHANGED,
    ErrorCode::CLI_ACCESS_DENIED,
    ErrorCode::CLI_SERVICE_BUSY,
    ErrorCode::CLI_REQUEST_TOO_LARGE,
    ErrorCode::CLI_RESULT_TOO_LARGE,
    ErrorCode::CLI_OUTCOME_UNKNOWN,
    // Queue mutations
    ErrorCode::QUEUE_ENTRY_NOT_FOUND,
    ErrorCode::QUEUE_ENTRY_ALREADY_SENT,
    ErrorCode::QUEUE_ENTRY_IN_FLIGHT,
    ErrorCode::QUEUE_ENTRY_REVISION_CONFLICT,
    ErrorCode::QUEUE_ENTRY_REORDER_CONFLICT,
    ErrorCode::QUEUE_PAUSE_CHANGED,
    ErrorCode::CONTROL_INPUT_QUEUE_FULL,
    ErrorCode::QUEUE_ATTACHMENTS_FULL,
    // Strict steering
    ErrorCode::STEER_NOT_DELIVERED,
    ErrorCode::STEER_OUTCOME_UNKNOWN,
    ErrorCode::STEER_PROVIDER_REJECTED,
    ErrorCode::STEER_TURN_UNAVAILABLE,
    ErrorCode::STEER_TURN_CHANGED,
    ErrorCode::STEER_TURN_NOT_STEERABLE,
    ErrorCode::STEER_CAPACITY_EXHAUSTED,
    ErrorCode::QUEUE_STEER_FINALIZATION_FAILED,
    ErrorCode::QUEUE_STEER_RECOVERY_FAILED,
    ErrorCode::PERMISSION_NOT_ACTIONABLE,
    ErrorCode::PERMISSION_DECISION_NOT_DELIVERED,
    ErrorCode::PERMISSION_DECISION_OUTCOME_UNKNOWN,
    // Agents and project paths
    ErrorCode::UNSUPPORTED_AGENT,
    ErrorCode::EXECUTOR_NOT_FOUND,
    ErrorCode::EXECUTOR_BUSY,
    ErrorCode::EXECUTOR_UNAVAILABLE,
    ErrorCode::LOGIN_INSTANCE_CHANGED,
    ErrorCode::MODEL_DISCOVERY_UNAVAILABLE,
    ErrorCode::EXECUTOR_IN_USE,
    ErrorCode::API_PROVIDER_UNAVAILABLE,
    ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
    ErrorCode::API_PROVIDER_IN_USE,
    ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE,
    ErrorCode::EXPECTED_AGENT_MISMATCH,
    ErrorCode::EXPLICIT_BYPASS_REQUIRED,
    ErrorCode::INCOMPLETE_EXECUTION_CONFIG,
    ErrorCode::STALE_CHAT_OWNERSHIP,
    ErrorCode::OWNERSHIP_TRANSFER_PENDING,
    ErrorCode::AGENT_HANDOFF_REQUIRES_IDLE,
    ErrorCode::CARRYOVER_COMPACTION_REQUIRED,
    ErrorCode::CARRYOVER_COMPACTION_UNAVAILABLE,
    ErrorCode::CARRYOVER_COMPACTION_FAILED,
    ErrorCode::SOURCE_TRANSCRIPT_UNAVAILABLE,
    ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE,
    ErrorCode::CONTEXT_ENVELOPE_MISMATCH,
    ErrorCode::CHAT_DELETED,
    ErrorCode::OPERATION_UNSUPPORTED,
    ErrorCode::SOURCE_REVISION_CHANGED,
    ErrorCode::TRANSCRIPT_UNAVAILABLE,
    ErrorCode::TRANSCRIPT_WORK_BUSY,
    ErrorCode::TRANSCRIPT_READ_INTERRUPTED,
    ErrorCode::SHARE_STORAGE_UNAVAILABLE,
    ErrorCode::TRANSCRIPT_DEFERRED,
    ErrorCode::TRANSCRIPT_NOT_YET_PERSISTED,
    ErrorCode::STALE_TRANSCRIPT_VIEW,
    ErrorCode::TRANSCRIPT_CURSOR_AHEAD,
    ErrorCode::TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN,
    ErrorCode::AGENT_RESUME_NOT_DELEGATED,
    ErrorCode::AGENT_STOP_NOT_DELEGATED,
    ErrorCode::CHAT_NOT_IDLE,
    ErrorCode::ORDER_CROSS_GROUP,
    ErrorCode::PROJECT_PATH_UPDATE_UNSUPPORTED,
    ErrorCode::PROJECT_PATH_DESTINATION_REJECTED,
    ErrorCode::PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN,
    ErrorCode::PROJECT_PATH_UPDATE_FAILED,
    ErrorCode::PROJECT_PATH_OUTSIDE_BASE,
    ErrorCode::PROJECT_PATH_NOT_FOUND,
    ErrorCode::PROJECT_PATH_NOT_DIRECTORY,
    ErrorCode::PROJECT_PATH_CHANGED,
    ErrorCode::PROJECT_UNAVAILABLE,
    ErrorCode::PROJECT_PATH_NATIVE_PATH_UNRESOLVED,
    ErrorCode::FOLDER_ALREADY_EXISTS,
    ErrorCode::SAVED_SEARCH_ALREADY_EXISTS,
    ErrorCode::SEARCH_RESULT_STALE,
    // Client-request transport
    ErrorCode::MISSING_CHAT_ID,
    ErrorCode::REQUEST_VALIDATION_FAILED,
    ErrorCode::CHAT_RUNNING,
    ErrorCode::NATIVE_PATH_UNRESOLVED,
    ErrorCode::HISTORY_LOAD_FAILED,
    ErrorCode::REQUEST_TIMEOUT,
    // Feature-specific (not part of the command/client-request subsets)
    ErrorCode::TITLE_GENERATION_EMPTY,
    ErrorCode::TITLE_GENERATION_FAILED,
    ErrorCode::TITLE_GENERATION_UNAVAILABLE,
    ErrorCode::FILE_CHANGED_DURING_READ,
    ErrorCode::FILE_PATH_MUST_IDENTIFY_FILE,
    ErrorCode::FILE_TOO_LARGE,
    ErrorCode::FILE_REVISION_CONFLICT,
    ErrorCode::FILE_NOT_FOUND,
    ErrorCode::FILE_PERMISSION_DENIED,
    ErrorCode::FILE_OUTSIDE_ROOT,
    ErrorCode::FILE_DIRECTORY_REQUIRED,
    ErrorCode::FILE_LIST_TOO_LARGE,
    ErrorCode::FILE_SERVICE_BUSY,
    ErrorCode::FILE_INVALID_DATA,
    ErrorCode::FILE_SAVE_OUTCOME_UNKNOWN,
    ErrorCode::FILE_ALREADY_EXISTS,
    ErrorCode::FILE_CREATE_OUTCOME_UNKNOWN,
    ErrorCode::FOLDER_NOT_FOUND,
    ErrorCode::SAVED_SEARCH_NOT_FOUND,
    ErrorCode::GENERATION_TEST_UNAVAILABLE,
    ErrorCode::GENERATION_TEST_CONFIGURATION_CHANGED,
    ErrorCode::GENERATION_TEST_UNSUPPORTED_EFFORT,
    ErrorCode::GENERATION_TEST_UNSAFE_AGENT,
    ErrorCode::GENERATION_TEST_EMPTY_RESPONSE,
    ErrorCode::GENERATION_TEST_TIMEOUT,
    ErrorCode::GENERATION_TEST_FAILED,
    ErrorCode::PROMPT_REFINEMENT_INVALID_REQUEST,
    ErrorCode::PROMPT_REFINEMENT_INPUT_TOO_LONG,
    ErrorCode::PROMPT_REFINEMENT_UNAVAILABLE,
    ErrorCode::PROMPT_REFINEMENT_UNSAFE_AGENT,
    ErrorCode::PROMPT_REFINEMENT_TEMPLATE_INVALID,
    ErrorCode::PROMPT_REFINEMENT_AUTH_REQUIRED,
    ErrorCode::PROMPT_REFINEMENT_RATE_LIMITED,
    ErrorCode::PROMPT_REFINEMENT_AGENT_UNAVAILABLE,
    ErrorCode::PROMPT_REFINEMENT_UNSUPPORTED_EFFORT,
    ErrorCode::PROMPT_REFINEMENT_EMPTY_RESPONSE,
    ErrorCode::PROMPT_REFINEMENT_OUTPUT_TOO_LONG,
    ErrorCode::PROMPT_REFINEMENT_TOKEN_SIGNATURE_CHANGED,
    ErrorCode::PROMPT_REFINEMENT_TIMEOUT,
    ErrorCode::PROMPT_REFINEMENT_FAILED,
    ErrorCode::TRANSCRIPT_SEARCH_DISABLED,
    ErrorCode::SEARCH_INDEX_UNAVAILABLE,
    ErrorCode::SEARCH_INDEX_BUSY,
    ErrorCode::SEARCH_TIMEOUT,
    ErrorCode::CHAT_TAGS_SAVE_UNKNOWN,
    ErrorCode::PARENT_CHAT_NOT_FOUND,
    ErrorCode::CHAT_PARENT_CYCLE,
    ErrorCode::CHAT_PARENT_SAVE_FAILED,
    ErrorCode::CHAT_PARENT_SAVE_UNKNOWN,
    ErrorCode::PREAMBLE_VALIDATION_FAILED,
    ErrorCode::PREAMBLE_NOT_FOUND,
    ErrorCode::PREAMBLE_REVISION_CONFLICT,
    ErrorCode::PREAMBLE_REVISION_EXHAUSTED,
    ErrorCode::PREAMBLE_LIMIT_REACHED,
    ErrorCode::PREAMBLE_COMBINED_LIMIT_EXCEEDED,
    ErrorCode::PREAMBLE_PROJECT_PATH_OUTSIDE_BASE,
    ErrorCode::PREAMBLE_PROJECT_PATH_NOT_FOUND,
    ErrorCode::PREAMBLE_PROJECT_PATH_INACCESSIBLE,
    ErrorCode::PREAMBLE_PROJECT_PATH_NOT_DIRECTORY,
    ErrorCode::PREAMBLE_ENVELOPE_MISMATCH,
    ErrorCode::PREAMBLE_SLASH_COMMAND_BLOCKED,
    ErrorCode::PREAMBLE_ID_COLLISION,
    ErrorCode::PREAMBLE_ID_LIFETIME_LIMIT_REACHED,
    ErrorCode::PREAMBLE_CATALOG_SAVE_UNKNOWN,
    ErrorCode::PREAMBLE_SELECTION_REVISION_CONFLICT,
    ErrorCode::PREAMBLE_SELECTION_COMPOSITION_INVALID,
    ErrorCode::PREAMBLE_SELECTION_NOTICE_FAILED,
    ErrorCode::PREAMBLE_SELECTION_SAVE_UNKNOWN,
    // Workspace tickets
    ErrorCode::TICKET_VALIDATION_FAILED,
    ErrorCode::TICKET_UNAUTHORIZED,
    ErrorCode::TICKET_FORBIDDEN,
    ErrorCode::TICKET_COMMANDS_DISABLED,
    ErrorCode::TICKET_NOT_FOUND,
    ErrorCode::TICKET_COMMENT_NOT_FOUND,
    ErrorCode::TICKET_CHAT_NOT_FOUND,
    ErrorCode::TICKET_STORE_CHANGED,
    ErrorCode::TICKET_REVISION_CONFLICT,
    ErrorCode::TICKET_COMMENT_REVISION_CONFLICT,
    ErrorCode::TICKET_ALREADY_CLAIMED,
    ErrorCode::TICKET_REQUEST_CONFLICT,
    ErrorCode::TICKET_COLLECTION_CHANGED,
    ErrorCode::TICKET_RELATIONSHIP_CYCLE,
    ErrorCode::TICKET_INVALID_TRANSITION,
    ErrorCode::TICKET_LIMIT_REACHED,
    ErrorCode::TICKET_SOURCE_UNAVAILABLE,
    ErrorCode::TICKET_REQUEST_TOO_LARGE,
    ErrorCode::TICKET_RESULT_TOO_LARGE,
    ErrorCode::TICKET_PROJECT_UNAVAILABLE,
    ErrorCode::TICKET_STORAGE_UNAVAILABLE,
    ErrorCode::TICKET_INTERNAL_ERROR,
    ErrorCode::PULL_REQUEST_REVIEW_VALIDATION_FAILED,
    ErrorCode::PULL_REQUEST_REVIEW_NOT_FOUND,
    ErrorCode::PULL_REQUEST_REVIEW_CONFLICT,
    ErrorCode::PULL_REQUEST_REVIEW_LIMIT_REACHED,
    ErrorCode::PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE,
];

/// Whether `value` is a registered error code.
pub fn is_error_code(value: &Value) -> Option<ErrorCode> {
    let text = value.as_str()?;
    ERROR_CODES
        .iter()
        .copied()
        .find(|code| code.as_str() == text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recognizes_registered_codes() {
        assert_eq!(
            is_error_code(&json!("VALIDATION_FAILED")),
            Some(ErrorCode::VALIDATION_FAILED)
        );
        assert_eq!(
            is_error_code(&json!("PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE")),
            Some(ErrorCode::PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE)
        );
        assert_eq!(is_error_code(&json!("validation_failed")), None);
        assert_eq!(is_error_code(&json!("UNKNOWN")), None);
        assert_eq!(is_error_code(&json!(null)), None);
        assert_eq!(is_error_code(&json!(400)), None);
        assert_eq!(ErrorCode::INTERNAL_ERROR.as_str(), "INTERNAL_ERROR");
        assert_eq!(ErrorCode::INTERNAL_ERROR.to_string(), "INTERNAL_ERROR");
    }

    #[test]
    fn registry_has_no_duplicate() {
        let mut codes: Vec<&str> = ERROR_CODES.iter().map(|code| code.as_str()).collect();
        let total = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), total);
    }
}

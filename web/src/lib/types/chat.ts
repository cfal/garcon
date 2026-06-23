// Chat-specific types for the Svelte frontend. Re-exports shared message
// types from the canonical definitions in $shared/chat-types.

export type {
	AmpAgentMode,
	ClaudeThinkingMode,
	PermissionMode,
	ThinkingMode,
} from '$shared/chat-modes';

export type {
	TodoItem,
	TodoStatus,
	ChatImage,
	UserMessage,
	AssistantMessage,
	ThinkingMessage,
	ToolUseChatMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	ListToolUseMessage,
	EditToolUseMessage,
	WriteToolUseMessage,
	ApplyPatchToolUseMessage,
	GrepToolUseMessage,
	GlobToolUseMessage,
	WebSearchToolUseMessage,
	WebFetchToolUseMessage,
	TodoWriteToolUseMessage,
	TodoReadToolUseMessage,
	TaskToolUseMessage,
	CodexSubagentAction,
	CodexSubagentDetails,
	CodexSubagentInputItem,
	CodexSubagentToolUseMessage,
	UpdatePlanToolUseMessage,
	WriteStdinToolUseMessage,
	EnterPlanModeToolUseMessage,
	ExitPlanModeToolUseMessage,
	CursorAskQuestionToolUseMessage,
	CursorCreatePlanToolUseMessage,
	CursorAskQuestionOption,
	CursorAskQuestionPrompt,
	CursorPlanTodo,
	CursorPlanTodoStatus,
	CursorPlanPhase,
	AmpFinderToolUseMessage,
	AmpOracleToolUseMessage,
	AmpLibrarianToolUseMessage,
	AmpSkillToolUseMessage,
	AmpMermaidToolUseMessage,
	AmpHandoffToolUseMessage,
	AmpLookAtToolUseMessage,
	AmpFindThreadToolUseMessage,
	AmpReadThreadToolUseMessage,
	AmpTaskListToolUseMessage,
	ExternalToolUseMessage,
	McpToolUseMessage,
	RequestPermissionsToolUseMessage,
	UnknownToolUseMessage,
	ToolResultMessage,
	ErrorMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	ChatMessage,
} from '$shared/chat-types';
export type { QueueEntry, QueueState } from '$shared/queue-state';

export type PendingViewChat = {
	chatId: string | null;
	startedAt: number;
};

export interface PendingPermissionRequest {
	permissionRequestId: string;
	requestedTool: import('$shared/chat-types').ToolUseChatMessage;
	chatId?: string | null;
	receivedAt?: Date;
}

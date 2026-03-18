// Chat-specific types for the Svelte frontend. Re-exports shared message
// types from the canonical definitions in $shared/chat-types.

export type {
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
	ToolUseMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
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
	UpdatePlanToolUseMessage,
	WriteStdinToolUseMessage,
	EnterPlanModeToolUseMessage,
	ExitPlanModeToolUseMessage,
	UnknownToolUseMessage,
	ToolResultMessage,
	ErrorMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	ChatMessage
} from '$shared/chat-types';
export type { QueueEntry, QueueState } from '$shared/queue-state';

export type PendingViewChat = {
	chatId: string | null;
	startedAt: number;
};

export interface PendingPermissionRequest {
	permissionRequestId: string;
	toolName: string;
	toolInput?: Record<string, unknown>;
	chatId?: string | null;
	receivedAt?: Date;
}

export interface ConversationWorkspaceProps {
	ws: WebSocket | null;
	sendMessage: (message: unknown) => boolean;
	onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
}

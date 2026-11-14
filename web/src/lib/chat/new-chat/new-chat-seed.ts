import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import type { ChatId } from '$shared/chat-id';
import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';
import type { PreambleSelectionChoice } from '$shared/preambles';
import type { ResolvedModelSelection } from '$shared/start-selection';

export interface NewChatStartupSeed extends ResolvedModelSelection {
	readonly executorId?: string | null;
	readonly agentId: string;
	readonly projectPath: string;
	readonly permissionMode: PermissionMode;
	readonly thinkingMode: ThinkingMode;
	readonly agentSettingsById: Record<string, AgentSettingsEnvelope>;
	readonly tags: readonly string[];
	readonly preambleChoice: PreambleSelectionChoice;
}

/** An executor-qualified folder that seeds only the location, not the agent selection. */
export interface NewChatProjectTarget {
	readonly executorId: string;
	readonly projectPath: string;
}

export interface NewChatDialogSeed {
	readonly prefill?: string;
	/** Ignored when `startup` is present, which restores its own location. */
	readonly project?: NewChatProjectTarget;
	readonly startup?: NewChatStartupSeed;
	readonly prospectiveChatId?: ChatId;
}

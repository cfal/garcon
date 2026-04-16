// Session and settings types used by app.ts and components.

import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '$shared/chat-modes';

export type SidebarSearchBarPosition = 'top' | 'bottom';
export type PinnedInsertPosition = 'top' | 'bottom';

export interface ChatSession {
	id: string;
	provider: 'claude' | 'codex' | 'opencode' | 'amp' | 'factory' | 'openrouter' | 'zai';
	model: string | null;
	permissionMode?: PermissionMode;
	thinkingMode?: ThinkingMode;
	claudeThinkingMode?: ClaudeThinkingMode;
	ampAgentMode?: AmpAgentMode;
	title: string;
	projectPath: string;
	tags: string[];
	native: {
		path: string | null;
	};
	activity: {
		createdAt: string | null;
		lastActivityAt: string | null;
		lastReadAt: string | null;
	};
	preview: {
		lastMessage: string;
		firstMessage?: string;
	};
	isPinned: boolean;
	isArchived: boolean;
	isActive: boolean;
	isUnread: boolean;
}

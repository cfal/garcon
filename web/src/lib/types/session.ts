// Session and settings types used by app.ts and components.

import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '$shared/chat-modes';

export interface ChatSession {
	id: string;
	provider: 'claude' | 'codex' | 'opencode' | 'amp' | 'factory';
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

export interface AppSettings {
	ui: Record<string, unknown>;
	uiEffective?: Record<string, unknown>;
	paths: {
		pinnedProjectPaths?: string[];
		browseStartPath?: string;
	};
	pinnedChatIds: string[];
	lastProvider: ChatSession['provider'];
	lastProjectPath: string;
	lastModel: string;
	lastPermissionMode: PermissionMode;
	lastThinkingMode: ThinkingMode;
	lastClaudeThinkingMode: ClaudeThinkingMode;
	lastAmpAgentMode?: AmpAgentMode;
	projectBasePath?: string;
	telegramBotTokenAvailable?: boolean;
}

// Session and settings types used by app.ts and components.

export interface ChatSession {
	id: string;
	provider: 'claude' | 'codex' | 'opencode';
	model: string | null;
	permissionMode?: string;
	thinkingMode?: string;
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
	lastPermissionMode: string;
	lastThinkingMode: string;
	projectBasePath?: string;
}

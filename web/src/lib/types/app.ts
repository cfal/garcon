// Application-level types shared across the Svelte frontend.

import type { PermissionMode, ThinkingMode } from '$shared/chat-modes';

export type SessionProvider = 'claude' | 'codex' | 'opencode';

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'preview';

export { type ChatSession, type AppSettings } from './session';

export interface ChatEntry {
	id: string;
	projectPath: string;
	title?: string;
	name?: string;
	model?: string | null;
	createdAt?: string;
	lastActivityAt?: string;
	provider?: SessionProvider;
}

export interface LoadingProgress {
	phase?: string;
	current: number;
	total: number;
	currentProject?: string;
}

export interface LoadingProgressMessage extends LoadingProgress {
	type: 'loading_progress';
}

export interface NewChatConfig {
	provider: SessionProvider;
	projectPath: string;
	model: string;
	permissionMode: PermissionMode;
	thinkingMode: ThinkingMode;
	firstMessage: string;
	initialImages?: File[];
}

export type AppSocketMessage =
	| LoadingProgressMessage
	| { type?: string; [key: string]: unknown };

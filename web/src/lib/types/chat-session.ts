// Canonical chat session types used by the ChatSessionsStore. Replaces
// ad-hoc ChatEntry snapshots with a single authoritative record shape.

import type { SessionProvider } from '$lib/types/app';
import type { PermissionMode } from '$lib/types/chat';

export type ChatStatus = 'draft' | 'running';

export interface ChatStartupConfig {
	provider: SessionProvider;
	model: string;
	permissionMode: PermissionMode;
	thinkingMode: string;
	firstMessage: string;
	initialImages?: File[];
}

export interface ChatSessionRecord {
	id: string;
	projectPath: string;
	title: string;
	provider: SessionProvider;
	model: string | null;
	permissionMode: PermissionMode;
	thinkingMode: string;
	createdAt: string | null;
	lastActivityAt: string | null;
	lastReadAt: string | null;
	canFork: boolean;
	isPinned: boolean;
	isArchived: boolean;
	isProcessing: boolean;
	isUnread: boolean;
	status: ChatStatus;
	lastMessage?: string;
}

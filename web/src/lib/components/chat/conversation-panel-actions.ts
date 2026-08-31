import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
import type { QueueEntry } from '$lib/types/chat.js';
import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
import type { GitRefSortKey } from '$lib/api/git.js';

export class StaleConversationSurfaceError extends Error {
	constructor(surfaceId: ChatViewSurfaceId, chatId: string) {
		super(`Conversation surface is no longer rendered: ${surfaceId} (${chatId})`);
		this.name = 'StaleConversationSurfaceError';
	}
}

export interface ConversationPanelActions {
	reload(surfaceId: ChatViewSurfaceId, chatId: string): void;
	decidePermission(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		permissionOccurrenceId: string,
		decision: PermissionDecisionPayload & { message?: string },
	): void;
	exitPlanMode(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		permissionOccurrenceId: string,
		choice: string,
		plan: string,
	): void;
	fork(surfaceId: ChatViewSurfaceId, chatId: string, upToOrdinal?: number): void;
	generateTitle(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		message: string,
		ordinal?: number,
	): Promise<void>;
	interruptQueue(surfaceId: ChatViewSurfaceId, chatId: string): Promise<void>;
	steerQueue(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		entry: QueueEntry,
		reorderRevision: number,
	): Promise<void>;
	pauseQueue(surfaceId: ChatViewSurfaceId, chatId: string): Promise<void>;
	resumeQueue(surfaceId: ChatViewSurfaceId, chatId: string, pauseId: string): Promise<void>;
	reportQueueControlError(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		action: 'pause' | 'resume',
		error: unknown,
	): void;
	editQueue(surfaceId: ChatViewSurfaceId, chatId: string, entry: QueueEntry): void;
	openQueue(surfaceId: ChatViewSurfaceId, chatId: string): void;
	deleteQueue(surfaceId: ChatViewSurfaceId, chatId: string, entryId: string): Promise<void>;
	stop(surfaceId: ChatViewSurfaceId, chatId: string): Promise<void>;
	openCommit(surfaceId: ChatViewSurfaceId, chatId: string): void;
	toggleBranch(surfaceId: ChatViewSurfaceId, chatId: string): void;
	closeBranch(surfaceId: ChatViewSurfaceId, chatId: string): void;
	createBranch(surfaceId: ChatViewSurfaceId, chatId: string): void;
	switchBranch(surfaceId: ChatViewSurfaceId, chatId: string, branch: string): Promise<void>;
	searchBranches(surfaceId: ChatViewSurfaceId, chatId: string, query: string): void;
	sortBranches(
		surfaceId: ChatViewSurfaceId,
		chatId: string,
		key: GitRefSortKey,
		query: string,
	): void;
	closeSwitchBranchDialog(surfaceId: ChatViewSurfaceId, chatId: string): void;
}

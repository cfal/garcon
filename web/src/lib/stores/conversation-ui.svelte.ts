import type {
	PendingPermissionRequest,
	PendingViewChat,
	PermissionMode,
	QueueState,
} from '$lib/types/chat';

export type PendingPermissionRequestUpdate =
	| PendingPermissionRequest[]
	| ((previous: PendingPermissionRequest[]) => PendingPermissionRequest[]);

export interface QueuePruningOptions {
	getActiveChatIds: () => Set<string>;
}

export class ConversationUiStore {
	pendingPermissionRequests = $state<PendingPermissionRequest[]>([]);
	pendingViewChat = $state<PendingViewChat | null>(null);
	previousPermissionMode = $state<PermissionMode | null>(null);
	private queueByChatId = $state<Record<string, QueueState | null>>({});

	get queueChatIds(): string[] {
		return Object.keys(this.queueByChatId);
	}

	setPendingPermissionRequests(update: PendingPermissionRequestUpdate): void {
		this.pendingPermissionRequests =
			typeof update === 'function' ? update(this.pendingPermissionRequests) : update;
	}

	clearPendingPermissionRequests(): void {
		this.pendingPermissionRequests = [];
	}

	setPendingViewChat(chat: PendingViewChat | null): void {
		this.pendingViewChat = chat;
	}

	setPreviousPermissionMode(mode: PermissionMode | null): void {
		this.previousPermissionMode = mode;
	}

	getQueue(chatId: string | null | undefined): QueueState | null {
		if (!chatId) return null;
		return this.queueByChatId[chatId] ?? null;
	}

	setMessageQueue(chatId: string, queue: QueueState | null): void {
		this.queueByChatId = { ...this.queueByChatId, [chatId]: queue };
	}

	pruneQueues(activeChatIds: Set<string>): void {
		const staleIds = Object.keys(this.queueByChatId).filter((chatId) => !activeChatIds.has(chatId));
		if (staleIds.length === 0) return;

		const nextQueueByChatId = { ...this.queueByChatId };
		for (const chatId of staleIds) {
			delete nextQueueByChatId[chatId];
		}
		this.queueByChatId = nextQueueByChatId;
	}

	mountQueuePruning(options: QueuePruningOptions): void {
		$effect(() => {
			this.pruneQueues(options.getActiveChatIds());
		});
	}
}

export function createConversationUiStore(): ConversationUiStore {
	return new ConversationUiStore();
}

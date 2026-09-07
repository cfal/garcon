import type { ChatSessionRecord } from '$lib/types/chat-session';

interface PendingArchiveChange {
	operationId: number;
	position: number;
	targetArchived: boolean;
}

export interface ChatArchiveProjectionOperation {
	id: number;
	chatIds: string[];
	targetArchived: boolean;
}

export class ChatArchiveProjectionState {
	#pendingByChatId = $state<Record<string, PendingArchiveChange>>({});
	#nextOperationId = 1;

	isPending(chatId: string): boolean {
		return Boolean(this.#pendingByChatId[chatId]);
	}

	isOptimisticallyArchived(chatId: string): boolean {
		return this.#pendingByChatId[chatId]?.targetArchived === true;
	}

	admit(
		records: Readonly<Record<string, ChatSessionRecord>>,
		chatIds: readonly string[],
		targetArchived: boolean,
	): ChatArchiveProjectionOperation {
		const operationId = this.#nextOperationId++;
		const admittedIds: string[] = [];
		const seen = new Set<string>();

		for (const chatId of chatIds) {
			if (seen.has(chatId)) continue;
			seen.add(chatId);

			const chat = records[chatId];
			if (!chat || chat.isArchived === targetArchived || this.isPending(chatId)) continue;
			admittedIds.push(chatId);
		}

		if (admittedIds.length > 0) {
			const nextPending = { ...this.#pendingByChatId };
			for (const [position, chatId] of admittedIds.entries()) {
				nextPending[chatId] = {
					operationId,
					position,
					targetArchived,
				};
			}
			this.#pendingByChatId = nextPending;
		}

		return { id: operationId, chatIds: admittedIds, targetArchived };
	}

	projectRecords(records: Record<string, ChatSessionRecord>): Record<string, ChatSessionRecord> {
		let projected = records;
		for (const [chatId, pending] of Object.entries(this.#pendingByChatId)) {
			if (!pending.targetArchived) continue;
			const chat = records[chatId];
			if (!chat) continue;
			if (projected === records) projected = { ...records };
			projected[chatId] = {
				...chat,
				isArchived: true,
				isPinned: false,
				orderGroup: 'archived',
			};
		}
		return projected;
	}

	projectOrder(
		order: string[],
		records: Readonly<Record<string, ChatSessionRecord>>,
	): string[] {
		const optimisticArchives = Object.entries(this.#pendingByChatId)
			.filter(([chatId, pending]) => pending.targetArchived && Boolean(records[chatId]))
			.sort(
				([, left], [, right]) =>
					right.operationId - left.operationId || left.position - right.position,
			)
			.map(([chatId]) => chatId);
		if (optimisticArchives.length === 0) return order;

		const optimisticIds = new Set(optimisticArchives);
		const projected = order.filter(
			(chatId) => !optimisticIds.has(chatId) && Boolean(records[chatId]),
		);
		const archivedIndex = projected.findIndex(
			(chatId) => records[chatId]?.orderGroup === 'archived',
		);
		projected.splice(
			archivedIndex < 0 ? projected.length : archivedIndex,
			0,
			...optimisticArchives,
		);
		return projected;
	}

	complete(operation: ChatArchiveProjectionOperation): void {
		const nextPending = { ...this.#pendingByChatId };
		let changed = false;
		for (const chatId of operation.chatIds) {
			if (nextPending[chatId]?.operationId !== operation.id) continue;
			delete nextPending[chatId];
			changed = true;
		}
		if (changed) this.#pendingByChatId = nextPending;
	}
}

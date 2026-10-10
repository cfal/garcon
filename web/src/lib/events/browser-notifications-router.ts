import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import {
	AgentRunFinishedMessage,
	ChatSessionDeletedWsMessage,
	ChatTranscriptReplacedMessage,
	ChatTransientFeedMutationMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { TransientFeedRow } from '$shared/chat-transient-feed';
import type { BrowserNotificationDeliveryPort } from '$lib/notifications/browser-notifications.js';
import * as m from '$lib/paraglide/messages.js';

export class BrowserNotificationsRouter {
	#handle: DrainHandle | null = null;
	readonly #seen = new Map<string, string>();
	readonly #permissions = new Map<
		string,
		{ chatId: string; row: TransientFeedRow; announced: boolean }
	>();
	constructor(
		private readonly ws: WsMessageLog,
		private readonly delivery: Pick<BrowserNotificationDeliveryPort, 'show' | 'close'>,
		private readonly deps: {
			enabled(): boolean;
			isFocused(): boolean;
			isChatProcessing(chatId: string): boolean;
			allowsNotifications(chatId: string): boolean;
		},
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		for (const { data } of this.#handle?.drain() ?? []) {
			if (
				data.type !== 'agent-run-finished' &&
				data.type !== 'chat-transient-feed-mutation' &&
				data.type !== 'chat-session-deleted' &&
				data.type !== 'chat-transcript-replaced'
			)
				continue;
			const message = parseServerWsMessage(data);
			if (message instanceof AgentRunFinishedMessage) {
				if (
					message.outcome !== 'finished' ||
					!message.turnId ||
					(message.exitCode !== undefined && message.exitCode !== 0) ||
					this.deps.isChatProcessing(message.chatId)
				)
					continue;
				this.#notify(
					`completion:${message.chatId}:${message.turnId}`,
					message.chatId,
					m.browser_notification_completed(),
				);
			} else if (message instanceof ChatTransientFeedMutationMessage) {
				const prefix = `permission:${message.serverInstanceId}:${message.chatId}:`;
				const mutation = message.mutation;
				if (mutation.kind === 'upsert') {
					const key = prefix + mutation.row.permissionOccurrenceId;
					this.#permissions.set(key, {
						chatId: message.chatId,
						row: mutation.row,
						announced: this.#permissions.get(key)?.announced ?? false,
					});
				}
				if (mutation.kind === 'remove')
					this.#closePermission(prefix + mutation.permissionOccurrenceId);
				if (mutation.kind === 'clear-run') {
					for (const [key, entry] of this.#permissions)
						if (entry.chatId === message.chatId && entry.row.runId === mutation.runId)
							this.#closePermission(key);
				}
			} else if (
				message instanceof ChatSessionDeletedWsMessage ||
				message instanceof ChatTranscriptReplacedMessage
			) {
				for (const [key, entry] of this.#permissions)
					if (entry.chatId === message.chatId) this.#closePermission(key);
				for (const [key, chatId] of this.#seen)
					if (chatId === message.chatId) {
						this.delivery.close(key);
						this.#seen.delete(key);
					}
			}
		}
		while (this.#permissions.size > 256)
			this.#closePermission(this.#permissions.keys().next().value!);
		for (const [key, entry] of this.#permissions) {
			if (entry.announced) continue;
			entry.announced = true;
			const { chatId, row } = entry;
			const question =
				row.message.requestedTool.type === 'ask-user-question-tool-use' ||
				row.message.requestedTool.type === 'cursor-ask-question-tool-use';
			this.#notify(
				key,
				chatId,
				question ? m.browser_notification_answer() : m.browser_notification_permission(),
			);
		}
	}

	#closePermission(key: string): void {
		if (this.#permissions.delete(key)) this.delivery.close(key);
	}

	clearPermissions(): void {
		for (const key of this.#permissions.keys()) this.#closePermission(key);
	}

	#notify(key: string, chatId: string, title: string): void {
		if (this.#seen.has(key)) return;
		this.#seen.set(key, chatId);
		while (this.#seen.size > 256) this.#seen.delete(this.#seen.keys().next().value!);
		if (this.deps.enabled() && !this.deps.isFocused() && this.deps.allowsNotifications(chatId))
			this.delivery.show(title, chatId, key);
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
		this.clearPermissions();
		this.#seen.clear();
	}
}

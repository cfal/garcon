import type { WsPushEvents } from '$lib/ws/connection.svelte.js';
import type {
	AgentRunFinishedMessage,
	ChatSessionDeletedWsMessage,
	ChatTranscriptReplacedMessage,
	ChatTransientFeedMutationMessage,
} from '$shared/ws-events';
import type { TransientFeedRow } from '$shared/chat-transient-feed';
import type { BrowserNotificationDeliveryPort } from '$lib/notifications/browser-notifications.js';
import * as m from '$lib/paraglide/messages.js';

export class BrowserNotificationsRouter {
	#unsubscribe: (() => void) | null = null;
	#permissionFlushQueued = false;
	readonly #seen = new Map<string, string>();
	readonly #permissions = new Map<
		string,
		{ chatId: string; row: TransientFeedRow; announced: boolean }
	>();
	constructor(
		private readonly ws: WsPushEvents,
		private readonly delivery: Pick<BrowserNotificationDeliveryPort, 'show' | 'close'>,
		private readonly deps: {
			enabled(): boolean;
			isFocused(): boolean;
			isChatProcessing(chatId: string): boolean;
			allowsNotifications(chatId: string): boolean;
		},
	) {}

	start(): void {
		if (this.#unsubscribe) return;
		const unsubscribe = [
			this.ws.onMessageType('agent-run-finished', (message) => this.#receive(message)),
			this.ws.onMessageType('chat-transient-feed-mutation', (message) => this.#receive(message)),
			this.ws.onMessageType('chat-session-deleted', (message) => this.#receive(message)),
			this.ws.onMessageType('chat-transcript-replaced', (message) => this.#receive(message)),
		];
		this.#unsubscribe = () => unsubscribe.forEach((cleanup) => cleanup());
	}

	#receive(
		message:
			| AgentRunFinishedMessage
			| ChatTransientFeedMutationMessage
			| ChatSessionDeletedWsMessage
			| ChatTranscriptReplacedMessage,
	): void {
		if (message.type === 'agent-run-finished') {
			if (
				message.outcome !== 'finished' ||
				!message.turnId ||
				(message.exitCode !== undefined && message.exitCode !== 0) ||
				this.deps.isChatProcessing(message.chatId)
			)
				return;
			this.#notify(
				`completion:${message.chatId}:${message.turnId}`,
				message.chatId,
				m.browser_notification_completed(),
			);
		} else if (message.type === 'chat-transient-feed-mutation') {
			const prefix = `permission:${message.serverInstanceId}:${message.chatId}:`;
			const mutation = message.mutation;
			if (mutation.kind === 'upsert') {
				const key = prefix + mutation.row.permissionOccurrenceId;
				this.#permissions.set(key, {
					chatId: message.chatId,
					row: mutation.row,
					announced: this.#permissions.get(key)?.announced ?? false,
				});
				this.#queuePermissionFlush();
			}
			if (mutation.kind === 'remove')
				this.#closePermission(prefix + mutation.permissionOccurrenceId);
			if (mutation.kind === 'clear-run') {
				for (const [key, entry] of this.#permissions)
					if (entry.chatId === message.chatId && entry.row.runId === mutation.runId)
						this.#closePermission(key);
			}
		} else if (
			message.type === 'chat-session-deleted' ||
			message.type === 'chat-transcript-replaced'
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

	#queuePermissionFlush(): void {
		if (this.#permissionFlushQueued) return;
		this.#permissionFlushQueued = true;
		queueMicrotask(() => {
			this.#permissionFlushQueued = false;
			this.#announcePermissions();
		});
	}

	#announcePermissions(): void {
		while (this.#permissions.size > 256)
			this.#closePermission(this.#permissions.keys().next().value!);
		for (const [key, entry] of this.#permissions) {
			if (entry.announced) continue;
			entry.announced = true;
			const { chatId, row } = entry;
			const question = row.message.requestedTool.type === 'ask-user-question-tool-use';
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
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.clearPermissions();
		this.#seen.clear();
	}
}

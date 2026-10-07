import { createDrainCursor, type DrainHandle, type WsMessageLog } from '$lib/ws/drain';
import {
	AgentRunFinishedMessage,
	ChatTransientFeedMutationMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import type { TransientFeedRow } from '$shared/chat-transient-feed';
import type { BrowserNotificationDeliveryPort } from '$lib/notifications/browser-notifications.js';
import * as m from '$lib/paraglide/messages.js';

export class BrowserNotificationsRouter {
	#handle: DrainHandle | null = null;
	readonly #seen = new Map<string, string>();
	constructor(
		private readonly ws: WsMessageLog,
		private readonly delivery: Pick<BrowserNotificationDeliveryPort, 'show'>,
		private readonly deps: {
			enabled(): boolean;
			isFocused(): boolean;
			hasChat(chatId: string): boolean;
		},
	) {}

	start(): void {
		if (!this.#handle) this.#handle = createDrainCursor(this.ws);
	}

	tick(): void {
		const permissions = new Map<string, { chatId: string; row: TransientFeedRow }>();
		for (const { data } of this.#handle?.drain() ?? []) {
			if (data.type !== 'agent-run-finished' && data.type !== 'chat-transient-feed-mutation')
				continue;
			const message = parseServerWsMessage(data);
			if (message instanceof AgentRunFinishedMessage) {
				if (
					message.outcome !== 'finished' ||
					!message.turnId ||
					(message.exitCode !== undefined && message.exitCode !== 0)
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
				if (mutation.kind === 'upsert')
					permissions.set(prefix + mutation.row.permissionOccurrenceId, {
						chatId: message.chatId,
						row: mutation.row,
					});
				if (mutation.kind === 'remove')
					permissions.delete(prefix + mutation.permissionOccurrenceId);
				if (mutation.kind === 'clear-run') {
					for (const [key, entry] of permissions)
						if (entry.chatId === message.chatId && entry.row.runId === mutation.runId)
							permissions.delete(key);
				}
			}
		}
		for (const [key, { chatId, row }] of permissions) {
			const question =
				row.message.requestedTool.type === 'ask-user-question-tool-use' ||
				row.message.requestedTool.type === 'cursor-ask-question-tool-use';
			this.#notify(
				key,
				chatId,
				question ? m.browser_notification_answer() : m.browser_notification_permission(),
			);
		}
		for (const [key, chatId] of this.#seen) if (!this.deps.hasChat(chatId)) this.#seen.delete(key);
	}

	#notify(key: string, chatId: string, title: string): void {
		if (this.#seen.has(key)) return;
		this.#seen.set(key, chatId);
		while (this.#seen.size > 256) this.#seen.delete(this.#seen.keys().next().value!);
		if (this.deps.enabled() && !this.deps.isFocused() && this.deps.hasChat(chatId))
			this.delivery.show(title, chatId, key);
	}

	destroy(): void {
		this.#handle?.cleanup();
		this.#handle = null;
		this.#seen.clear();
	}
}

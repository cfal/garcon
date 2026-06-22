import type { NotificationsStore } from '$lib/stores/notifications.svelte';
import * as m from '$lib/paraglide/messages.js';
import type { WsConnectionStatus } from './connection.svelte';

const WS_CONNECTION_NOTICE_GRACE_MS = 5_000;
const WS_CONNECTION_RETRY_NOTICE_ATTEMPT = 2;

export const WS_CONNECTION_NOTIFICATION_KEY = 'websocket-connection';

interface TimerApi {
	setTimeout(handler: () => void, timeout: number): number;
	clearTimeout(id: number): void;
}

interface WsConnectionNotificationPresenterOptions {
	notifications: NotificationsStore;
	timers?: TimerApi;
}

export class WsConnectionNotificationPresenter {
	#notifications: NotificationsStore;
	#timers: TimerApi;
	#timer: number | null = null;
	#shownEpisodeId: number | null = null;
	#dismissedEpisodeId: number | null = null;
	#hadUserVisibleOutage = false;

	constructor(options: WsConnectionNotificationPresenterOptions) {
		this.#notifications = options.notifications;
		this.#timers =
			options.timers ?? {
				setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
				clearTimeout: (id) => window.clearTimeout(id),
			};
	}

	observe(status: WsConnectionStatus): () => void {
		this.#clearTimer();

		if (
			this.#shownEpisodeId === status.episodeId &&
			!this.#notifications.hasKey(WS_CONNECTION_NOTIFICATION_KEY)
		) {
			this.#dismissedEpisodeId = status.episodeId;
		}

		if (status.phase === 'connected') {
			const shouldShowRecovery = this.#hadUserVisibleOutage;
			this.#resetOutageNotification();
			if (shouldShowRecovery) this.#notifications.info(m.notifications_ws_reconnected());
			return () => {};
		}

		if (status.phase === 'destroyed' || status.phase === 'idle') {
			this.#resetOutageNotification();
			return () => {};
		}

		if (this.#dismissedEpisodeId === status.episodeId) return () => {};

		if (status.phase === 'offline') {
			this.#showPersistent(m.notifications_ws_offline(), status.episodeId);
			return () => {};
		}

		if (status.reconnectAttempt >= WS_CONNECTION_RETRY_NOTICE_ATTEMPT) {
			this.#showPersistent(this.#messageFor(status), status.episodeId);
			return () => {};
		}

		this.#timer = this.#timers.setTimeout(() => {
			this.#showPersistent(this.#messageFor(status), status.episodeId);
			this.#timer = null;
		}, WS_CONNECTION_NOTICE_GRACE_MS);

		return () => this.#clearTimer();
	}

	#messageFor(status: WsConnectionStatus): string {
		if (status.lastConnectedAt === null) return m.notifications_ws_connecting_failed();
		return m.notifications_ws_reconnecting();
	}

	#showPersistent(message: string, episodeId: number): void {
		this.#notifications.error(message, {
			key: WS_CONNECTION_NOTIFICATION_KEY,
			timeoutMs: null,
		});
		this.#shownEpisodeId = episodeId;
		this.#hadUserVisibleOutage = true;
	}

	#resetOutageNotification(): void {
		this.#clearTimer();
		this.#notifications.dismissKey(WS_CONNECTION_NOTIFICATION_KEY);
		this.#shownEpisodeId = null;
		this.#dismissedEpisodeId = null;
		this.#hadUserVisibleOutage = false;
	}

	#clearTimer(): void {
		if (this.#timer === null) return;
		this.#timers.clearTimeout(this.#timer);
		this.#timer = null;
	}
}

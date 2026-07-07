import type { BrowserNotificationDisplayMode } from '$shared/ws-requests';
import type { BrowserNotificationsStore } from '$lib/stores/browser-notifications.svelte';
import { detectBrowserNotificationDisplayMode } from '$lib/notifications/browser-subscription';
import type { WsConnection } from '$lib/ws/connection.svelte';

const PRESENCE_INTERVAL_MS = 30_000;

export class BrowserNotificationPresenceCoordinator {
	#ws: WsConnection;
	#notifications: BrowserNotificationsStore;
	#getSelectedChatId: () => string | null;
	#timer: ReturnType<typeof setInterval> | null = null;
	#started = false;

	constructor({
		ws,
		notifications,
		getSelectedChatId,
	}: {
		ws: WsConnection;
		notifications: BrowserNotificationsStore;
		getSelectedChatId: () => string | null;
	}) {
		this.#ws = ws;
		this.#notifications = notifications;
		this.#getSelectedChatId = getSelectedChatId;
	}

	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		window.addEventListener('focus', this.#send);
		window.addEventListener('blur', this.#send);
		document.addEventListener('visibilitychange', this.#send);
		this.#timer = setInterval(this.#send, PRESENCE_INTERVAL_MS);
		this.sendNow();
	}

	destroy(): void {
		if (!this.#started || typeof window === 'undefined') return;
		window.removeEventListener('focus', this.#send);
		window.removeEventListener('blur', this.#send);
		document.removeEventListener('visibilitychange', this.#send);
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = null;
		this.#started = false;
	}

	sendNow(): void {
		this.#send();
	}

	#send = (): void => {
		if (typeof document === 'undefined') return;
		const displayMode: BrowserNotificationDisplayMode = detectBrowserNotificationDisplayMode();
		this.#ws.sendMessage({
			type: 'browser-notification-presence',
			clientId: this.#notifications.clientId,
			endpointHash: this.#notifications.endpointHash,
			selectedChatId: this.#getSelectedChatId(),
			visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
			hasFocus: document.hasFocus(),
			displayMode,
			sentAt: Date.now(),
		});
	};
}

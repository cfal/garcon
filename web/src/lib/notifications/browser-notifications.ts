export type BrowserNotificationPermission = NotificationPermission | 'unsupported';

export function browserNotificationPermission(): BrowserNotificationPermission {
	return typeof Notification === 'undefined' || !globalThis.isSecureContext
		? 'unsupported'
		: Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
	if (browserNotificationPermission() === 'unsupported') return 'unsupported';
	try {
		return await Notification.requestPermission();
	} catch {
		return 'unsupported';
	}
}

export interface BrowserNotificationDeliveryPort {
	show(title: string, chatId: string, tag: string): void;
	destroy(): void;
}

export class BrowserNotificationService implements BrowserNotificationDeliveryPort {
	#destroyed = false;
	readonly #notifications = new Set<Notification>();
	readonly #tags = new Set<string>();
	constructor(
		private readonly deps: {
			enabled(): boolean;
			hasChat(chatId: string): boolean;
			isFocused(): boolean;
			openChat(chatId: string): Promise<void>;
		},
	) {}

	#open(chatId: string): void {
		if (this.#destroyed || !this.deps.hasChat(chatId)) return;
		window.focus();
		void this.deps.openChat(chatId).catch(() => {});
	}

	show(title: string, chatId: string, tag: string): void {
		void this.#deliver(title, chatId, tag).catch(() => {});
	}

	async #deliver(title: string, chatId: string, tag: string): Promise<void> {
		if (!this.#canDeliver(chatId)) return;
		const registration = await navigator.serviceWorker?.getRegistration();
		if (!this.#canDeliver(chatId)) return;
		if (registration?.active && registration.showNotification) {
			await registration.showNotification(title, { tag, data: { chatId } });
			this.#tags.add(tag);
			while (this.#tags.size > 20) {
				const oldest = this.#tags.values().next().value!;
				this.#tags.delete(oldest);
				for (const notification of await registration.getNotifications({ tag: oldest }))
					notification.close();
			}
			if (!this.#canDeliver(chatId)) {
				this.#tags.delete(tag);
				for (const notification of await registration.getNotifications({ tag }))
					notification.close();
			}
			return;
		}
		const notification = new Notification(title, { tag });
		this.#notifications.add(notification);
		notification.onclick = () => {
			notification.close();
			this.#open(chatId);
		};
		notification.onclose = () => this.#notifications.delete(notification);
		while (this.#notifications.size > 20) {
			const oldest = this.#notifications.values().next().value!;
			oldest.close();
			this.#notifications.delete(oldest);
		}
	}

	#canDeliver(chatId: string): boolean {
		return (
			!this.#destroyed &&
			!this.deps.isFocused() &&
			this.deps.enabled() &&
			this.deps.hasChat(chatId) &&
			browserNotificationPermission() === 'granted'
		);
	}

	async #closeWorkerNotifications(): Promise<void> {
		const tags = new Set(this.#tags);
		this.#tags.clear();
		const registration = await navigator.serviceWorker?.getRegistration();
		for (const notification of (await registration?.getNotifications()) ?? []) {
			if (tags.has(notification.tag)) notification.close();
		}
	}

	destroy(): void {
		this.#destroyed = true;
		for (const notification of this.#notifications) notification.close();
		this.#notifications.clear();
		void this.#closeWorkerNotifications().catch(() => {});
	}
}

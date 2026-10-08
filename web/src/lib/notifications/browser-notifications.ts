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
	close(tag: string): void;
	destroy(): void;
}

interface NotificationDelivery {
	cancelled: boolean;
	workerStarted: boolean;
	notification?: Notification;
}

export class BrowserNotificationService implements BrowserNotificationDeliveryPort {
	#destroyed = false;
	readonly #deliveries = new Map<string, NotificationDelivery>();
	#coordinator: BrowserNotificationCoordinator | null = null;
	constructor(
		private readonly deps: {
			enabled(): boolean;
			isFocused(): boolean;
			openChat(chatId: string): Promise<void>;
		},
	) {}

	start(): void {
		if (!this.#destroyed)
			this.#coordinator ??= new BrowserNotificationCoordinator({
				isFocused: this.deps.isFocused,
				eligible: () => this.deps.enabled() && browserNotificationPermission() === 'granted',
			});
	}

	#open(chatId: string): void {
		if (this.#destroyed) return;
		window.focus();
		void this.deps.openChat(chatId).catch(() => {});
	}

	show(title: string, chatId: string, tag: string): void {
		if (this.#destroyed || this.#deliveries.has(tag)) return;
		const delivery: NotificationDelivery = { cancelled: false, workerStarted: false };
		this.#deliveries.set(tag, delivery);
		while (this.#deliveries.size > 20) this.#closeOwned(this.#deliveries.keys().next().value!);
		void this.#deliver(title, chatId, tag, delivery)
			.catch(() => {
				if (delivery.workerStarted) this.close(tag);
			})
			.finally(() => {
				if (
					!delivery.workerStarted &&
					!delivery.notification &&
					this.#deliveries.get(tag) === delivery
				)
					this.#deliveries.delete(tag);
			});
	}

	async #deliver(
		title: string,
		chatId: string,
		tag: string,
		delivery: NotificationDelivery,
	): Promise<void> {
		if (!this.#canDeliver(delivery)) return;
		const registration = await navigator.serviceWorker?.getRegistration();
		if (!this.#canDeliver(delivery)) return;
		const publish = async () => {
			if (!this.#canDeliver(delivery)) return;
			if (registration?.active && registration.showNotification) {
				delivery.workerStarted = true;
				await registration.showNotification(title, { tag, data: { chatId } });
				if (!this.#canDeliver(delivery)) await this.#closeWorkerTag(tag, registration);
			} else {
				const notification = new Notification(title, { tag });
				delivery.notification = notification;
				notification.onclick = () => {
					notification.close();
					this.#open(chatId);
				};
				notification.onclose = () => {
					if (this.#deliveries.get(tag) === delivery) this.#deliveries.delete(tag);
				};
			}
		};
		if (this.#coordinator) await this.#coordinator.run(tag, publish);
		else await publish();
	}

	#canDeliver(delivery: { cancelled: boolean }): boolean {
		return (
			!this.#destroyed &&
			!delivery.cancelled &&
			!this.deps.isFocused() &&
			this.deps.enabled() &&
			browserNotificationPermission() === 'granted'
		);
	}

	async #closeWorkerTag(tag: string, registration?: ServiceWorkerRegistration): Promise<void> {
		registration ??= await navigator.serviceWorker?.getRegistration();
		for (const notification of (await registration?.getNotifications({ tag })) ?? [])
			notification.close();
	}

	close(tag: string): void {
		this.#cancel(tag);
		void this.#closeWorkerTag(tag).catch(() => {});
	}

	#cancel(tag: string): NotificationDelivery | undefined {
		const delivery = this.#deliveries.get(tag);
		if (delivery) {
			delivery.cancelled = true;
			delivery.notification?.close();
			this.#deliveries.delete(tag);
		}
		return delivery;
	}

	#closeOwned(tag: string): void {
		if (this.#cancel(tag)?.workerStarted) void this.#closeWorkerTag(tag).catch(() => {});
	}

	destroy(): void {
		this.#destroyed = true;
		this.#coordinator?.destroy();
		for (const tag of this.#deliveries.keys()) this.#closeOwned(tag);
	}
}
import { BrowserNotificationCoordinator } from './browser-notification-coordinator.js';

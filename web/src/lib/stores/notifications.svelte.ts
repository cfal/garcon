export type NotificationTone = 'info' | 'error';

export interface AppNotification {
	id: string;
	tone: NotificationTone;
	message: string;
	createdAt: number;
	expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_VISIBLE_NOTIFICATIONS = 5;

export class NotificationsStore {
	#items = $state<AppNotification[]>([]);
	#nextId = 0;

	get items(): readonly AppNotification[] {
		return this.#items;
	}

	info(message: string): string {
		return this.#push('info', message);
	}

	error(message: string): string {
		return this.#push('error', message);
	}

	dismiss(id: string): void {
		this.#items = this.#items.filter((item) => item.id !== id);
	}

	clear(): void {
		this.#items = [];
	}

	#push(tone: NotificationTone, message: string): string {
		const now = Date.now();
		const id = `notification-${now}-${this.#nextId++}`;
		const item: AppNotification = {
			id,
			tone,
			message,
			createdAt: now,
			expiresAt: now + DEFAULT_TIMEOUT_MS,
		};
		this.#items = [...this.#items, item].slice(-MAX_VISIBLE_NOTIFICATIONS);
		return id;
	}
}

export function createNotificationsStore(): NotificationsStore {
	return new NotificationsStore();
}

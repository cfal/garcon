export type NotificationTone = 'info' | 'error';

export interface AppNotification {
	id: string;
	key?: string;
	tone: NotificationTone;
	message: string;
	createdAt: number;
	updatedAt: number;
	expiresAt: number | null;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_VISIBLE_NOTIFICATIONS = 5;

export interface NotificationOptions {
	key?: string;
	timeoutMs?: number | null;
}

export class NotificationsStore {
	#items = $state<AppNotification[]>([]);
	#nextId = 0;

	get items(): readonly AppNotification[] {
		return this.#items;
	}

	info(message: string, options: NotificationOptions = {}): string {
		return this.#push('info', message, options);
	}

	error(message: string, options: NotificationOptions = {}): string {
		return this.#push('error', message, options);
	}

	dismiss(id: string): void {
		this.#items = this.#items.filter((item) => item.id !== id);
	}

	dismissKey(key: string): void {
		this.#items = this.#items.filter((item) => item.key !== key);
	}

	hasKey(key: string): boolean {
		return this.#items.some((item) => item.key === key);
	}

	clear(): void {
		this.#items = [];
	}

	#push(tone: NotificationTone, message: string, options: NotificationOptions): string {
		const now = Date.now();
		const expiresAt =
			options.timeoutMs === null ? null : now + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		if (options.key) {
			const existing = this.#items.find((item) => item.key === options.key);
			if (existing) {
				this.#items = this.#items.map((item) =>
					item.key === options.key
						? { ...item, tone, message, updatedAt: now, expiresAt }
						: item,
				);
				return existing.id;
			}
		}

		const id = `notification-${now}-${this.#nextId++}`;
		const item: AppNotification = {
			id,
			...(options.key ? { key: options.key } : {}),
			tone,
			message,
			createdAt: now,
			updatedAt: now,
			expiresAt,
		};
		this.#items = this.#trimVisible([...this.#items, item]);
		return id;
	}

	#trimVisible(items: AppNotification[]): AppNotification[] {
		let next = items;
		while (next.length > MAX_VISIBLE_NOTIFICATIONS) {
			const removableIndex = next.findIndex((item) => item.expiresAt !== null);
			const index = removableIndex >= 0 ? removableIndex : 0;
			next = [...next.slice(0, index), ...next.slice(index + 1)];
		}
		return next;
	}
}

export function createNotificationsStore(): NotificationsStore {
	return new NotificationsStore();
}

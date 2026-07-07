export const GARCON_NOTIFICATION_MESSAGE_TYPE = 'garcon-notification-open';
const DEFAULT_NOTIFICATION_ICON = '/icon-192.png';

interface DeclarativePushPayload {
	web_push?: number;
	notification?: {
		title?: unknown;
		body?: unknown;
		navigate?: unknown;
		tag?: unknown;
		silent?: unknown;
		app_badge?: unknown;
		data?: unknown;
	};
}

export interface ParsedPushNotification {
	title: string;
	options: NotificationOptions;
	badgeCount: number | null;
	navigatePath: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function sameOriginPath(value: unknown, origin: string): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value, origin);
		if (url.origin !== origin) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}

function badgeCount(value: unknown): number | null {
	const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(raw) || raw < 0) return null;
	return Math.floor(raw);
}

export function parsePushPayload(rawPayload: string, origin: string): ParsedPushNotification | null {
	if (!rawPayload.trim()) return null;
	let parsed: DeclarativePushPayload;
	try {
		parsed = JSON.parse(rawPayload) as DeclarativePushPayload;
	} catch {
		return null;
	}
	const notification = asRecord(parsed.notification);
	if (!notification) return null;
	const title = typeof notification.title === 'string' && notification.title.trim()
		? notification.title.trim()
		: 'Garcon';
	const navigatePath = sameOriginPath(notification.navigate, origin);
	if (!navigatePath) return null;
	const data = asRecord(notification.data) ?? {};
	const options: NotificationOptions = {
		body: typeof notification.body === 'string' ? notification.body : '',
		tag: typeof notification.tag === 'string' ? notification.tag : undefined,
		silent: notification.silent === true,
		icon: DEFAULT_NOTIFICATION_ICON,
		badge: DEFAULT_NOTIFICATION_ICON,
		data: {
			...data,
			url: navigatePath,
		},
	};
	return {
		title,
		options,
		badgeCount: badgeCount(notification.app_badge),
		navigatePath,
	};
}

export function notificationNavigationPath(data: unknown, origin: string): string | null {
	const raw = asRecord(data);
	if (!raw) return null;
	return sameOriginPath(raw.url, origin);
}

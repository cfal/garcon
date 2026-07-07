import type { BrowserNotificationDisplayMode } from '$shared/ws-requests';

export type BrowserNotificationSupportReason =
	| 'checking'
	| 'supported'
	| 'unsupported-server'
	| 'insecure-context'
	| 'missing-notification-api'
	| 'missing-service-worker'
	| 'ios-not-installed'
	| 'missing-push-manager';

export interface BrowserNotificationSupport {
	supported: boolean;
	reason: BrowserNotificationSupportReason;
}

export type BrowserNotificationSetupPhase =
	| 'support'
	| 'permission'
	| 'service-worker'
	| 'vapid-key'
	| 'push-subscribe'
	| 'server-upsert';

export interface BrowserNotificationSetupDiagnostics {
	phase: BrowserNotificationSetupPhase;
	support: BrowserNotificationSupport;
	permission: NotificationPermission;
	displayMode: BrowserNotificationDisplayMode;
	origin: string | null;
	protocol: string | null;
	hostname: string | null;
	platform: string;
	userAgent: string;
	isLikelyChromium: boolean;
	isAppleMobilePlatform: boolean;
	serviceWorkerScope?: string | null;
	serviceWorkerActiveState?: ServiceWorkerState | null;
	applicationServerKeyBytes?: number | null;
}

export type BrowserPushApplicationServerKey = Uint8Array<ArrayBuffer>;

export const DEFAULT_BROWSER_NOTIFICATION_SUPPORT: BrowserNotificationSupport = {
	supported: false,
	reason: 'checking',
};

const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_PUBLIC_KEY_PREFIX = 4;

export class BrowserNotificationSetupError extends Error {
	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message, options);
		this.name = 'BrowserNotificationSetupError';
	}
}

function decodeBase64Url(value: string): BrowserPushApplicationServerKey {
	const trimmed = value.trim();
	if (!trimmed) throw new Error('empty key');
	const padding = '='.repeat((4 - (trimmed.length % 4)) % 4);
	const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/');
	const raw = atob(base64);
	const output = new Uint8Array(raw.length) as BrowserPushApplicationServerKey;
	for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
	return output;
}

export function decodeBrowserPushPublicKey(value: string): BrowserPushApplicationServerKey {
	try {
		const bytes = decodeBase64Url(value);
		if (bytes.byteLength !== VAPID_PUBLIC_KEY_BYTES || bytes[0] !== VAPID_PUBLIC_KEY_PREFIX) {
			throw new Error(`decoded ${bytes.byteLength} bytes`);
		}
		return bytes;
	} catch (error) {
		throw new BrowserNotificationSetupError(
			'Server returned an invalid browser notification public key. Restart Garcon to regenerate push keys.',
			{ cause: error },
		);
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return left.every((value, index) => value === right[index]);
}

export function pushSubscriptionMatchesApplicationServerKey(
	subscription: PushSubscription,
	applicationServerKey: BrowserPushApplicationServerKey,
): boolean | null {
	const existingKey = subscription.options?.applicationServerKey;
	if (!existingKey) return null;
	return bytesEqual(new Uint8Array(existingKey), applicationServerKey);
}

export async function getOrCreateBrowserPushSubscription(
	registration: ServiceWorkerRegistration,
	applicationServerKey: BrowserPushApplicationServerKey,
): Promise<PushSubscription> {
	const existing = await registration.pushManager.getSubscription();
	if (!existing) {
		return registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});
	}

	const matchesApplicationServerKey = pushSubscriptionMatchesApplicationServerKey(
		existing,
		applicationServerKey,
	);
	if (matchesApplicationServerKey !== false) return existing;

	console.info(
		'[browser-notifications] Existing push subscription uses an old VAPID key; replacing it.',
	);
	const removed = await existing.unsubscribe();
	if (!removed) {
		throw new BrowserNotificationSetupError(
			'Existing browser notification subscription could not be replaced. Clear this site permission and try again.',
		);
	}

	return registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey,
	});
}

export function detectBrowserNotificationDisplayMode(): BrowserNotificationDisplayMode {
	if (typeof window === 'undefined') return 'unknown';
	if (window.matchMedia?.('(display-mode: standalone)').matches) return 'standalone';
	const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
	if (navigatorWithStandalone.standalone === true) return 'standalone';
	return 'browser';
}

export function browserNotificationPlatformLabel(): string {
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
	return nav.userAgentData?.platform ?? navigator.platform ?? '';
}

function isLocalHttpHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	);
}

export function isBrowserPushAllowedOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol === 'https:') return true;
		return url.protocol === 'http:' && isLocalHttpHost(url.hostname);
	} catch {
		return false;
	}
}

export function browserNotificationLocationDiagnostics(): Pick<
	BrowserNotificationSetupDiagnostics,
	'origin' | 'protocol' | 'hostname' | 'userAgent' | 'isLikelyChromium'
> {
	if (typeof window === 'undefined') {
		return {
			origin: null,
			protocol: null,
			hostname: null,
			userAgent: '',
			isLikelyChromium: false,
		};
	}
	const userAgent = navigator.userAgent ?? '';
	return {
		origin: window.location.origin,
		protocol: window.location.protocol,
		hostname: window.location.hostname,
		userAgent,
		isLikelyChromium: /(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent),
	};
}

export function isAppleMobileBrowserPlatform(): boolean {
	if (typeof navigator === 'undefined') return false;
	const nav = navigator as Navigator & { maxTouchPoints?: number };
	const platform = navigator.platform ?? '';
	const userAgent = navigator.userAgent ?? '';
	return (
		/iPad|iPhone|iPod/.test(userAgent) ||
		(platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
	);
}

export function detectBrowserNotificationSupport(
	serverKeyAvailable: boolean,
): BrowserNotificationSupport {
	if (!serverKeyAvailable) return { supported: false, reason: 'unsupported-server' };
	if (typeof window === 'undefined') return DEFAULT_BROWSER_NOTIFICATION_SUPPORT;
	if (!window.isSecureContext) return { supported: false, reason: 'insecure-context' };
	if (!isBrowserPushAllowedOrigin(window.location.href)) {
		return { supported: false, reason: 'insecure-context' };
	}
	if (!('Notification' in window)) {
		return { supported: false, reason: 'missing-notification-api' };
	}
	if (!('serviceWorker' in navigator)) {
		return { supported: false, reason: 'missing-service-worker' };
	}
	if (
		isAppleMobileBrowserPlatform() &&
		detectBrowserNotificationDisplayMode() !== 'standalone'
	) {
		return { supported: false, reason: 'ios-not-installed' };
	}
	if (!('PushManager' in window)) {
		return { supported: false, reason: 'missing-push-manager' };
	}
	return { supported: true, reason: 'supported' };
}

function rawErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function browserNotificationSetupErrorMessage(
	error: unknown,
	diagnostics?: Pick<BrowserNotificationSetupDiagnostics, 'origin' | 'protocol' | 'hostname'>,
): string {
	if (error instanceof BrowserNotificationSetupError) return error.message;

	const message = rawErrorMessage(error);
	if (/push service error|push service not available|could not connect to push server/i.test(message)) {
		if (
			diagnostics?.protocol === 'http:' &&
			diagnostics.hostname &&
			!isLocalHttpHost(diagnostics.hostname)
		) {
			return `Browser push service registration failed: ${message}. Current origin is ${diagnostics.origin}; serve Garcon over trusted HTTPS for Web Push.`;
		}
		return `Browser push service registration failed: ${message}. Check this browser's push-message service setting, network/VPN/firewall, and on iPhone or iPad use the installed Home Screen app.`;
	}
	if (/different applicationServerKey|sender id mismatch/i.test(message)) {
		return 'Existing browser notification subscription used an old server key. Clear this site permission and try again.';
	}
	if (/permission denied|notallowed/i.test(message)) {
		return 'Browser notification permission was denied.';
	}
	return message || 'Browser notification setup failed';
}

function errorSummary(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			cause: error.cause instanceof Error ? error.cause.message : undefined,
		};
	}
	return { message: String(error) };
}

export function logBrowserNotificationSetupError(
	error: unknown,
	diagnostics: BrowserNotificationSetupDiagnostics,
): void {
	console.error('[browser-notifications] Browser notification setup failed', {
		...diagnostics,
		error: errorSummary(error),
	});
}

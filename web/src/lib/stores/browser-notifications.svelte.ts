import type { RemoteSettingsSnapshot } from '$shared/settings';
import {
	deleteBrowserPushSubscription,
	getBrowserPushVapidPublicKey,
	sendBrowserNotificationTest,
	upsertBrowserPushSubscription,
	type BrowserPushSubscriptionPayload,
} from '$lib/api/browser-notifications.js';
import {
	DEFAULT_BROWSER_NOTIFICATION_SUPPORT,
	browserNotificationLocationDiagnostics,
	browserNotificationPlatformLabel,
	browserNotificationSetupErrorMessage,
	decodeBrowserPushPublicKey,
	detectBrowserNotificationDisplayMode,
	detectBrowserNotificationSupport,
	getOrCreateBrowserPushSubscription,
	isAppleMobileBrowserPlatform,
	logBrowserNotificationSetupError,
	type BrowserNotificationSetupPhase,
	type BrowserNotificationSupport,
	type BrowserNotificationSupportReason,
} from '$lib/notifications/browser-subscription';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export type { BrowserNotificationSupport, BrowserNotificationSupportReason };
export { detectBrowserNotificationDisplayMode };

interface BrowserNotificationsStoreDeps {
	applyRemoteSnapshot(snapshot: RemoteSettingsSnapshot): void;
}

function randomHexId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ensureClientId(): string {
	const existing = getLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationClientId);
	if (existing) return existing;
	const next = randomHexId();
	setLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationClientId, next);
	return next;
}

function subscriptionPayload(subscription: PushSubscription): BrowserPushSubscriptionPayload {
	const json = subscription.toJSON() as BrowserPushSubscriptionPayload;
	return {
		endpoint: subscription.endpoint,
		expirationTime: json.expirationTime ?? null,
		keys: {
			p256dh: json.keys?.p256dh,
			auth: json.keys?.auth,
		},
	};
}

export class BrowserNotificationsStore {
	permission = $state<NotificationPermission>('default');
	support = $state<BrowserNotificationSupport>(DEFAULT_BROWSER_NOTIFICATION_SUPPORT);
	endpointHash = $state<string | null>(
		getLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationEndpointHash),
	);
	isBusy = $state(false);
	lastError = $state<string | null>(null);
	lastTestResult = $state<{ ok: boolean; message: string } | null>(null);

	#deps: BrowserNotificationsStoreDeps;
	#clientId = '';

	constructor(deps: BrowserNotificationsStoreDeps) {
		this.#deps = deps;
	}

	get clientId(): string {
		if (!this.#clientId) this.#clientId = ensureClientId();
		return this.#clientId;
	}

	get isPermissionGranted(): boolean {
		return this.permission === 'granted';
	}

	get isSubscribed(): boolean {
		return Boolean(this.endpointHash);
	}

	refreshSupport(serverKeyAvailable = true): BrowserNotificationSupport {
		const nextSupport = detectBrowserNotificationSupport(serverKeyAvailable);
		this.support = nextSupport;
		if (typeof Notification !== 'undefined') {
			this.permission = Notification.permission;
		}
		return nextSupport;
	}

	async refreshExistingSubscription(): Promise<void> {
		this.refreshSupport();
		if (!this.support.supported || this.permission !== 'granted') return;
		const registration = await navigator.serviceWorker.ready;
		const subscription = await registration.pushManager.getSubscription();
		if (subscription || this.endpointHash) return;
		removeLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationEndpointHash);
		this.endpointHash = null;
	}

	async enable(serverKeyAvailable = true): Promise<boolean> {
		this.lastError = null;
		this.lastTestResult = null;
		const support = this.refreshSupport(serverKeyAvailable);
		let phase: BrowserNotificationSetupPhase = 'support';
		let registration: ServiceWorkerRegistration | null = null;
		let applicationServerKey: Uint8Array | null = null;
		if (!support.supported) {
			this.lastError = support.reason;
			return false;
		}

		this.isBusy = true;
		try {
			phase = 'permission';
			let permission = Notification.permission;
			if (permission !== 'granted') {
				permission = await Notification.requestPermission();
			}
			this.permission = permission;
			if (permission !== 'granted') {
				this.lastError = 'permission-denied';
				return false;
			}

			phase = 'service-worker';
			registration = await navigator.serviceWorker.ready;
			phase = 'vapid-key';
			const publicKey = await getBrowserPushVapidPublicKey();
			applicationServerKey = decodeBrowserPushPublicKey(publicKey);
			phase = 'push-subscribe';
			const subscription = await getOrCreateBrowserPushSubscription(
				registration,
				applicationServerKey,
			);

			phase = 'server-upsert';
			const response = await upsertBrowserPushSubscription({
				subscription: subscriptionPayload(subscription),
				clientId: this.clientId,
				displayMode: detectBrowserNotificationDisplayMode(),
				platform: browserNotificationPlatformLabel(),
			});
			if (response.endpointHash) {
				this.endpointHash = response.endpointHash;
				setLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationEndpointHash, response.endpointHash);
			}
			this.#deps.applyRemoteSnapshot(response.settings);
			return true;
		} catch (error) {
			const diagnostics = {
				phase,
				support,
				permission: this.permission,
				displayMode: detectBrowserNotificationDisplayMode(),
				...browserNotificationLocationDiagnostics(),
				platform: browserNotificationPlatformLabel(),
				isAppleMobilePlatform: isAppleMobileBrowserPlatform(),
				serviceWorkerScope: registration?.scope ?? null,
				serviceWorkerActiveState: registration?.active?.state ?? null,
				applicationServerKeyBytes: applicationServerKey?.byteLength ?? null,
			};
			logBrowserNotificationSetupError(error, diagnostics);
			this.lastError = browserNotificationSetupErrorMessage(error, diagnostics);
			return false;
		} finally {
			this.isBusy = false;
		}
	}

	async disable(): Promise<boolean> {
		this.lastError = null;
		this.lastTestResult = null;
		this.isBusy = true;
		try {
			let endpoint: string | null = null;
			if ('serviceWorker' in navigator) {
				const registration = await navigator.serviceWorker.ready;
				const subscription = await registration.pushManager.getSubscription();
				if (subscription) {
					endpoint = subscription.endpoint;
					await subscription.unsubscribe();
				}
			}
			const response = await deleteBrowserPushSubscription({
				endpointHash: this.endpointHash,
				endpoint,
			});
			removeLocalStorageItem(LOCAL_STORAGE_KEYS.browserNotificationEndpointHash);
			this.endpointHash = null;
			this.#deps.applyRemoteSnapshot(response.settings);
			return true;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : 'Browser notification disable failed';
			return false;
		} finally {
			this.isBusy = false;
		}
	}

	async sendTest(): Promise<boolean> {
		this.lastError = null;
		this.lastTestResult = null;
		this.isBusy = true;
		try {
			const response = await sendBrowserNotificationTest();
			const ok = response.success && response.sent > 0;
			this.lastTestResult = {
				ok,
				message: ok ? 'sent' : 'failed',
			};
			return ok;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : 'Browser notification test failed';
			this.lastTestResult = { ok: false, message: this.lastError };
			return false;
		} finally {
			this.isBusy = false;
		}
	}
}

export function createBrowserNotificationsStore(
	deps: BrowserNotificationsStoreDeps,
): BrowserNotificationsStore {
	return new BrowserNotificationsStore(deps);
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import {
	BrowserNotificationsStore,
} from '../browser-notifications.svelte';
import {
	browserNotificationSetupErrorMessage,
	decodeBrowserPushPublicKey,
	detectBrowserNotificationSupport,
	isBrowserPushAllowedOrigin,
} from '$lib/notifications/browser-subscription';
import {
	getBrowserPushVapidPublicKey,
	upsertBrowserPushSubscription,
} from '$lib/api/browser-notifications.js';

vi.mock('$lib/api/browser-notifications.js', () => ({
	deleteBrowserPushSubscription: vi.fn(),
	getBrowserPushVapidPublicKey: vi.fn(),
	sendBrowserNotificationTest: vi.fn(),
	upsertBrowserPushSubscription: vi.fn(),
}));

const mockedGetBrowserPushVapidPublicKey = vi.mocked(getBrowserPushVapidPublicKey);
const mockedUpsertBrowserPushSubscription = vi.mocked(upsertBrowserPushSubscription);

const navigatorDescriptors = new Map(
	['serviceWorker', 'platform', 'userAgent', 'maxTouchPoints', 'standalone'].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(navigator, key),
	]),
);
const windowDescriptors = new Map(
	['isSecureContext', 'Notification', 'PushManager', 'matchMedia'].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(window, key),
	]),
);

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function makeSnapshot(): RemoteSettingsSnapshot {
	return {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
		browserNotifications: {
			vapidPublicKeyAvailable: true,
			subscriptionCount: 1,
		},
	};
}

function base64Url(bytes: Uint8Array): string {
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeVapidKeyBytes(seed = 1): Uint8Array {
	const bytes = new Uint8Array(65);
	bytes[0] = 4;
	for (let i = 1; i < bytes.length; i += 1) bytes[i] = (seed + i) % 255;
	return bytes;
}

function makeSubscription(endpoint: string, applicationServerKey: Uint8Array): PushSubscription {
	return {
		endpoint,
		expirationTime: null,
		options: {
			userVisibleOnly: true,
			applicationServerKey: applicationServerKey.buffer.slice(0),
		},
		toJSON: () => ({
			endpoint,
			expirationTime: null,
			keys: {
				p256dh: `${endpoint}-p256dh`,
				auth: `${endpoint}-auth`,
			},
		}),
		unsubscribe: vi.fn(async () => true),
		getKey: vi.fn(),
	} as unknown as PushSubscription;
}

function makeRegistration({
	existing,
	created,
}: {
	existing: PushSubscription | null;
	created: PushSubscription;
}): ServiceWorkerRegistration {
	return {
		scope: 'https://garcon.test/',
		active: { state: 'activated' },
		pushManager: {
			getSubscription: vi.fn(async () => existing),
			subscribe: vi.fn(async () => created),
		},
	} as unknown as ServiceWorkerRegistration;
}

function installBrowserGlobals(
	registration: ServiceWorkerRegistration,
	permission: NotificationPermission = 'granted',
): void {
	const notification = {
		get permission() {
			return permission;
		},
		requestPermission: vi.fn(async () => permission),
	};
	vi.stubGlobal('Notification', notification);
	vi.stubGlobal('PushManager', class PushManager {});
	Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
	Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
	Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		value: vi.fn(() => ({ matches: false })),
	});
	Object.defineProperty(navigator, 'serviceWorker', {
		configurable: true,
		value: { ready: Promise.resolve(registration) },
	});
	Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
	Object.defineProperty(navigator, 'userAgent', {
		configurable: true,
		value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
	});
	Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
}

describe('browser notification subscription helpers', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		for (const [key, descriptor] of navigatorDescriptors) restoreProperty(navigator, key, descriptor);
		for (const [key, descriptor] of windowDescriptors) restoreProperty(window, key, descriptor);
	});

	it('decodes and validates VAPID public keys before subscribing', () => {
		const bytes = makeVapidKeyBytes();
		const decoded = decodeBrowserPushPublicKey(base64Url(bytes));

		expect(decoded).toEqual(bytes);
		expect(() => decodeBrowserPushPublicKey(base64Url(new Uint8Array([1, 2, 3])))).toThrow(
			/invalid browser notification public key/i,
		);
	});

	it('treats iOS and iPadOS browser tabs as needing Home Screen install', () => {
		installBrowserGlobals(makeRegistration({
			existing: null,
			created: makeSubscription('https://push.example/new', makeVapidKeyBytes()),
		}));
		Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
		Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });

		expect(detectBrowserNotificationSupport(true)).toEqual({
			supported: false,
			reason: 'ios-not-installed',
		});
	});

	it('only allows HTTPS and local HTTP origins for push registration', () => {
		expect(isBrowserPushAllowedOrigin('https://garcon.example.test/')).toBe(true);
		expect(isBrowserPushAllowedOrigin('http://localhost:5173/')).toBe(true);
		expect(isBrowserPushAllowedOrigin('http://127.0.0.1:5173/')).toBe(true);
		expect(isBrowserPushAllowedOrigin('http://garcon.ccvm.com/')).toBe(false);
	});

	it('explains browser push-service registration failures', () => {
		const error = new DOMException('Registration failed - push service error', 'AbortError');

		expect(browserNotificationSetupErrorMessage(error)).toContain(
			'Browser push service registration failed',
		);
	});

	it('points non-local HTTP push-service failures at HTTPS setup', () => {
		const error = new DOMException('Registration failed - push service error', 'AbortError');

		expect(
			browserNotificationSetupErrorMessage(error, {
				origin: 'http://garcon.ccvm.com',
				protocol: 'http:',
				hostname: 'garcon.ccvm.com',
			}),
		).toContain('serve Garcon over trusted HTTPS');
	});
});

describe('BrowserNotificationsStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
		mockedGetBrowserPushVapidPublicKey.mockResolvedValue(base64Url(makeVapidKeyBytes()));
		mockedUpsertBrowserPushSubscription.mockResolvedValue({
			success: true,
			endpointHash: 'endpoint-hash-new',
			settings: makeSnapshot(),
		});
	});

	afterEach(() => {
		localStorage.clear();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		for (const [key, descriptor] of navigatorDescriptors) restoreProperty(navigator, key, descriptor);
		for (const [key, descriptor] of windowDescriptors) restoreProperty(window, key, descriptor);
	});

	it('replaces an existing subscription that uses an old VAPID key', async () => {
		const currentKey = makeVapidKeyBytes(1);
		const oldKey = makeVapidKeyBytes(40);
		mockedGetBrowserPushVapidPublicKey.mockResolvedValue(base64Url(currentKey));
		const existing = makeSubscription('https://push.example/old', oldKey);
		const created = makeSubscription('https://push.example/new', currentKey);
		const registration = makeRegistration({ existing, created });
		installBrowserGlobals(registration);
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const store = new BrowserNotificationsStore({ applyRemoteSnapshot: vi.fn() });

		await expect(store.enable(true)).resolves.toBe(true);

		expect(existing.unsubscribe).toHaveBeenCalled();
		expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
			userVisibleOnly: true,
			applicationServerKey: currentKey,
		});
		expect(mockedUpsertBrowserPushSubscription).toHaveBeenCalledWith(
			expect.objectContaining({
				subscription: expect.objectContaining({ endpoint: 'https://push.example/new' }),
			}),
		);
		expect(store.endpointHash).toBe('endpoint-hash-new');
	});

	it('logs push-service registration failures and skips the server upsert', async () => {
		const currentKey = makeVapidKeyBytes(1);
		mockedGetBrowserPushVapidPublicKey.mockResolvedValue(base64Url(currentKey));
		const registration = makeRegistration({
			existing: null,
			created: makeSubscription('https://push.example/new', currentKey),
		});
		vi.mocked(registration.pushManager.subscribe).mockRejectedValue(
			new DOMException('Registration failed - push service error', 'AbortError'),
		);
		installBrowserGlobals(registration);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const store = new BrowserNotificationsStore({ applyRemoteSnapshot: vi.fn() });

		await expect(store.enable(true)).resolves.toBe(false);

		expect(mockedUpsertBrowserPushSubscription).not.toHaveBeenCalled();
		expect(store.lastError).toContain('Browser push service registration failed');
		expect(consoleError).toHaveBeenCalledWith(
			'[browser-notifications] Browser notification setup failed',
			expect.objectContaining({
				phase: 'push-subscribe',
				origin: expect.any(String),
				protocol: expect.any(String),
				applicationServerKeyBytes: 65,
				error: expect.objectContaining({
					name: 'AbortError',
					message: 'Registration failed - push service error',
				}),
			}),
		);
	});
});

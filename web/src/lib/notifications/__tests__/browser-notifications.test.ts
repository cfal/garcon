import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BrowserNotificationService,
	requestBrowserNotificationPermission,
} from '../browser-notifications.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser notification delivery', () => {
	it('leaves a same-tag replacement from another tab alone during local cleanup', async () => {
		const published: { tag: string; data: unknown; close: ReturnType<typeof vi.fn> }[] = [];
		const registration = {
			active: {},
			showNotification: async (_title: string, options: NotificationOptions) => {
				published.push({ tag: options.tag!, data: options.data, close: vi.fn() });
			},
			getNotifications: vi.fn(async () => published.slice(-1)),
		};
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
		const deps = { enabled: () => true, isFocused: () => false, openChat: vi.fn() };
		const first = new BrowserNotificationService(deps);
		const peer = new BrowserNotificationService(deps);
		try {
			first.show('Permission', 'chat', 'same-tag');
			await vi.waitFor(() => expect(published).toHaveLength(1));
			peer.show('Permission', 'chat', 'same-tag');
			await vi.waitFor(() => expect(published).toHaveLength(2));
			first.closeOwned('same-tag');
			await vi.waitFor(() => expect(registration.getNotifications).toHaveBeenCalled());
			expect(published[1].close).not.toHaveBeenCalled();
			first.close('same-tag');
			await vi.waitFor(() => expect(published[1].close).toHaveBeenCalledOnce());
		} finally {
			first.destroy();
			peer.destroy();
		}
	});
	it('distinguishes releasing a local delivery from globally resolving a permission', async () => {
		const close = vi.fn();
		const getNotifications = vi.fn(async () => [{ close }]);
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ getNotifications }) } });
		const service = new BrowserNotificationService({ enabled: () => true, isFocused: () => false, openChat: vi.fn() });
		service.closeOwned('peer-permission');
		await Promise.resolve();
		expect(getNotifications).not.toHaveBeenCalled();
		service.close('peer-permission');
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		service.destroy();
	});
	it('retracts a resolved permission even when worker delivery finishes after close', async () => {
		let release!: () => void;
		const close = vi.fn();
		let published: { tag?: string; data: unknown; close: typeof close } | undefined;
		const registration = {
			active: {},
			showNotification: async (_title: string, options: NotificationOptions) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				published = { tag: options.tag, data: options.data, close };
			},
			getNotifications: vi.fn(async ({ tag }: GetNotificationOptions) =>
				published && published.tag === tag ? [published] : [],
			),
		};
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
		const service = new BrowserNotificationService({
			enabled: () => true,
			isFocused: () => false,
			openChat: vi.fn(),
		});
		service.show('Generic permission', 'captured', 'permission');
		await vi.waitFor(() => expect(release).toBeDefined());
		service.close('permission');
		await vi.waitFor(() =>
			expect(registration.getNotifications).toHaveBeenCalledExactlyOnceWith({ tag: 'permission' }),
		);
		expect(close).not.toHaveBeenCalled();
		release();
		await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
		service.destroy();
	});
	it('rechecks focus after registration resolves', async () => {
		let focused = false;
		let release!: (value: undefined) => void;
		const construct = vi.fn();
		class DesktopNotification {
			static permission = 'granted';
			constructor() {
				construct();
			}
		}
		vi.stubGlobal('Notification', DesktopNotification);
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', {
			serviceWorker: {
				getRegistration: () =>
					new Promise<undefined>((resolve) => {
						release = resolve;
					}),
			},
		});
		const service = new BrowserNotificationService({
			enabled: () => true,
			isFocused: () => focused,
			openChat: vi.fn(),
		});
		service.show('Generic', 'captured', 'tag');
		focused = true;
		release(undefined);
		await Promise.resolve();
		await Promise.resolve();
		expect(construct).not.toHaveBeenCalled();
		service.destroy();
	});

	it('closes each late service worker delivery after destruction', async () => {
		const releases: (() => void)[] = [];
		const notices: { tag: string; data: unknown; close: ReturnType<typeof vi.fn> }[] = [];
		const registration = {
			active: {},
			showNotification: async (_title: string, options: NotificationOptions) => {
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				notices.push({ tag: options.tag!, data: options.data, close: vi.fn() });
			},
			getNotifications: async (options?: { tag?: string }) =>
				notices.filter((notice) => !options?.tag || notice.tag === options.tag),
		};
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('isSecureContext', true);
		vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
		const service = new BrowserNotificationService({
			enabled: () => true,
			isFocused: () => false,
			openChat: vi.fn(),
		});
		service.show('Generic A', 'captured', 'a');
		service.show('Generic B', 'captured', 'b');
		await vi.waitFor(() => expect(releases).toHaveLength(2));
		service.destroy();
		releases[0]!();
		releases[1]!();
		await vi.waitFor(() => {
			expect(notices).toHaveLength(2);
			expect(notices.every((notice) => notice.close.mock.calls.length > 0)).toBe(true);
		});
	});
	it('does not request permission during delivery and captures click navigation', async () => {
		const requestPermission = vi.fn();
		const close = vi.fn();
		const captured: { click: (() => void) | null } = { click: null };
		class DesktopNotification {
			static permission = 'granted';
			static requestPermission = requestPermission;
			close = close;
			set onclick(value: () => void) {
				captured.click = value;
			}
		}
		vi.stubGlobal('Notification', DesktopNotification);
		vi.stubGlobal('isSecureContext', true);
		const openChat = vi.fn(async () => {});
		const service = new BrowserNotificationService({
			enabled: () => true,
			isFocused: () => false,
			openChat,
		});
		service.show('Generic completion', 'captured', 'tag');
		await Promise.resolve();
		await Promise.resolve();
		expect(requestPermission).not.toHaveBeenCalled();
		expect(captured.click).not.toBeNull();
		captured.click!();
		expect(openChat).toHaveBeenCalledWith('captured');
		service.destroy();
		expect(close).toHaveBeenCalled();
	});
	it('requests permission only through the explicit enable operation and handles unsupported browsers', async () => {
		vi.stubGlobal('Notification', undefined);
		expect(await requestBrowserNotificationPermission()).toBe('unsupported');
		const requestPermission = vi.fn(async () => 'denied');
		vi.stubGlobal('Notification', { permission: 'default', requestPermission });
		vi.stubGlobal('isSecureContext', true);
		expect(await requestBrowserNotificationPermission()).toBe('denied');
		expect(requestPermission).toHaveBeenCalledOnce();
	});
});

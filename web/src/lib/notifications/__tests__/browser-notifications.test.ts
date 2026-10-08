import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	BrowserNotificationService,
	requestBrowserNotificationPermission,
} from '../browser-notifications.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser notification delivery', () => {
	it('retracts a resolved permission even when worker delivery finishes after close', async () => {
		let release!: () => void;
		const close = vi.fn();
		const registration = {
			active: {},
			showNotification: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			getNotifications: async (options?: { tag?: string }) =>
				options?.tag === 'permission' ? [{ close }] : [],
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
		release();
		await vi.waitFor(() => expect(close).toHaveBeenCalled());
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
		const notices: { tag: string; close: ReturnType<typeof vi.fn> }[] = [];
		const registration = {
			active: {},
			showNotification: async (_title: string, options: NotificationOptions) => {
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				notices.push({ tag: options.tag!, close: vi.fn() });
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

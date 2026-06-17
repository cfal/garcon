import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsStore } from '$lib/stores/notifications.svelte';
import {
	WS_CONNECTION_NOTIFICATION_KEY,
	WsConnectionNotificationPresenter,
} from '../connection-notifications';
import type { WsConnectionStatus } from '../connection.svelte';

function status(overrides: Partial<WsConnectionStatus>): WsConnectionStatus {
	return {
		phase: 'connected',
		reason: null,
		episodeId: 0,
		reconnectAttempt: 0,
		nextRetryAt: null,
		lastConnectedAt: 1_000,
		lastDisconnectedAt: null,
		...overrides,
	};
}

describe('WsConnectionNotificationPresenter', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('does not notify immediately on initial connection', () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		const cleanup = presenter.observe(
			status({
				phase: 'connecting',
				reason: 'initial-connect',
				lastConnectedAt: null,
			}),
		);

		expect(notifications.items).toEqual([]);

		cleanup();
	});

	it('shows an initial connection error after the grace window', () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'connecting',
				reason: 'initial-connect',
				lastConnectedAt: null,
			}),
		);

		vi.advanceTimersByTime(4_999);
		expect(notifications.items).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(notifications.items).toHaveLength(1);
		expect(notifications.items[0]).toMatchObject({
			key: WS_CONNECTION_NOTIFICATION_KEY,
			tone: 'error',
			message: 'Unable to connect to live updates. Retrying...',
			expiresAt: null,
		});
	});

	it('does not notify for reconnects shorter than the grace window', () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		const cleanup = presenter.observe(
			status({
				phase: 'reconnecting',
				reason: 'heartbeat-timeout',
				episodeId: 1,
				lastDisconnectedAt: 2_000,
			}),
		);

		vi.advanceTimersByTime(4_999);
		cleanup();
		presenter.observe(status({ phase: 'connected', episodeId: 1 }));
		vi.advanceTimersByTime(1);

		expect(notifications.items).toEqual([]);
	});

	it('shows reconnecting after the grace window', () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'reconnecting',
				reason: 'heartbeat-timeout',
				episodeId: 1,
				lastDisconnectedAt: 2_000,
			}),
		);

		vi.advanceTimersByTime(5_000);

		expect(notifications.items[0]).toMatchObject({
			key: WS_CONNECTION_NOTIFICATION_KEY,
			tone: 'error',
			message: 'Connection lost. Reconnecting...',
			expiresAt: null,
		});
	});

	it('shows offline immediately and clears on reconnect', () => {
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'offline',
				reason: 'browser-offline',
				episodeId: 1,
				lastDisconnectedAt: 2_000,
			}),
		);

		expect(notifications.items[0]).toMatchObject({
			key: WS_CONNECTION_NOTIFICATION_KEY,
			tone: 'error',
			message: 'You appear to be offline. Garcon will reconnect when your network returns.',
			expiresAt: null,
		});

		presenter.observe(status({ phase: 'connected', episodeId: 1 }));

		expect(notifications.hasKey(WS_CONNECTION_NOTIFICATION_KEY)).toBe(false);
		expect(notifications.items.map((item) => item.message)).toContain('Reconnected.');
	});

	it('shows immediately after the retry threshold', () => {
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'reconnecting',
				reason: 'socket-close',
				episodeId: 1,
				reconnectAttempt: 2,
				lastDisconnectedAt: 2_000,
			}),
		);

		expect(notifications.items[0]).toMatchObject({
			key: WS_CONNECTION_NOTIFICATION_KEY,
			message: 'Connection lost. Reconnecting...',
		});
	});

	it('does not re-add a dismissed notification in the same episode', () => {
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'offline',
				reason: 'browser-offline',
				episodeId: 1,
				lastDisconnectedAt: 2_000,
			}),
		);
		notifications.dismissKey(WS_CONNECTION_NOTIFICATION_KEY);

		presenter.observe(
			status({
				phase: 'reconnecting',
				reason: 'socket-close',
				episodeId: 1,
				reconnectAttempt: 3,
				lastDisconnectedAt: 2_000,
			}),
		);

		expect(notifications.hasKey(WS_CONNECTION_NOTIFICATION_KEY)).toBe(false);
	});

	it('re-adds notifications for a later outage episode', () => {
		const notifications = new NotificationsStore();
		const presenter = new WsConnectionNotificationPresenter({ notifications });

		presenter.observe(
			status({
				phase: 'offline',
				reason: 'browser-offline',
				episodeId: 1,
				lastDisconnectedAt: 2_000,
			}),
		);
		notifications.dismissKey(WS_CONNECTION_NOTIFICATION_KEY);
		presenter.observe(status({ phase: 'connected', episodeId: 1 }));

		presenter.observe(
			status({
				phase: 'offline',
				reason: 'browser-offline',
				episodeId: 2,
				lastDisconnectedAt: 3_000,
			}),
		);

		expect(notifications.hasKey(WS_CONNECTION_NOTIFICATION_KEY)).toBe(true);
	});
});

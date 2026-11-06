import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import { installNativeConnectionNotification } from '../connection-notification.js';

function fixture(connected = false) {
	const listeners = new Set<(connected: boolean) => void>();
	const connection = {
		isConnected: connected,
		onConnectionChange: vi.fn((listener: (connected: boolean) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies Pick<WsConnection, 'isConnected' | 'onConnectionChange'>;
	const notifications = { info: vi.fn(() => 'notification') };
	return {
		connection,
		notifications,
		emit(value: boolean) {
			connection.isConnected = value;
			for (const listener of listeners) listener(value);
		},
	};
}

afterEach(() => {
	delete window.__GARCON_NATIVE__;
});

describe('native connection notification', () => {
	it('does not subscribe or notify in an ordinary browser', () => {
		const { connection, notifications, emit } = fixture(true);
		const dispose = installNativeConnectionNotification(
			connection,
			notifications,
			new URL('https://server.test/'),
		);
		emit(true);
		expect(connection.onConnectionChange).not.toHaveBeenCalled();
		expect(notifications.info).not.toHaveBeenCalled();
		dispose();
	});

	it('waits for the first connection and does not repeat on reconnect', () => {
		window.__GARCON_NATIVE__ = { version: 1, requestServerChooser: vi.fn() };
		const { connection, notifications, emit } = fixture();
		const dispose = installNativeConnectionNotification(
			connection,
			notifications,
			new URL('https://server.test:8443/garcon/'),
		);
		emit(false);
		expect(notifications.info).not.toHaveBeenCalled();
		emit(true);
		expect(notifications.info).toHaveBeenCalledWith('Connected to server.test:8443/garcon', {
			timeoutMs: 3_000,
		});
		emit(false);
		emit(true);
		expect(notifications.info).toHaveBeenCalledTimes(1);
		dispose();
	});

	it('announces an already connected page without exposing credentials or query data', () => {
		window.__GARCON_NATIVE__ = { version: 1, requestServerChooser: vi.fn() };
		const { connection, notifications } = fixture(true);
		const dispose = installNativeConnectionNotification(
			connection,
			notifications,
			new URL('https://user:secret@server.test/?token=private#private'),
		);
		expect(notifications.info).toHaveBeenCalledWith('Connected to server.test', {
			timeoutMs: 3_000,
		});
		dispose();
	});

	it('unsubscribes when the root is unmounted before connecting', () => {
		window.__GARCON_NATIVE__ = { version: 1, requestServerChooser: vi.fn() };
		const { connection, notifications, emit } = fixture();
		const dispose = installNativeConnectionNotification(
			connection,
			notifications,
			new URL('https://server.test/'),
		);
		dispose();
		emit(true);
		expect(notifications.info).not.toHaveBeenCalled();
	});
});

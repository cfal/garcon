import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { WsConnection } from '$lib/ws/connection.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { getNativeServerChooser } from './server-chooser.js';

export function installNativeConnectionNotification(
	connection: Pick<WsConnection, 'isConnected' | 'onConnectionChange'>,
	notifications: Pick<NotificationsStore, 'info'>,
	serverUrl: URL,
): () => void {
	if (!getNativeServerChooser()) return () => {};
	let announced = false;
	const server = serverUrl.host + serverUrl.pathname.replace(/\/$/, '');
	const announce = (connected: boolean) => {
		if (!connected || announced) return;
		announced = true;
		notifications.info(m.native_connected_to_server({ server }), { timeoutMs: 3_000 });
	};
	const unsubscribe = connection.onConnectionChange(announce);
	announce(connection.isConnected);
	return unsubscribe;
}

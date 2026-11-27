import { untrack } from 'svelte';
import type { WsConnectionStatus } from './connection.svelte.js';

// Runs onConnect only when lastConnectedAt changes, ignoring non-reconnect connectionStatus replacements.
export function createWsReconnectEffect(
	getConnectionStatus: () => Pick<WsConnectionStatus, 'lastConnectedAt'>,
	onConnect: (connectedAt: number) => void | (() => void),
): void {
	const lastConnectedAt = $derived(getConnectionStatus().lastConnectedAt);
	$effect(() => {
		if (!lastConnectedAt) return;
		return untrack(() => onConnect(lastConnectedAt));
	});
}

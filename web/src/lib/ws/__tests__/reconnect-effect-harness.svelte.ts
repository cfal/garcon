import { flushSync } from 'svelte';
import { createWsReconnectEffect } from '../reconnect-effect.svelte.js';
import type { WsConnectionStatus } from '../connection.svelte.js';

export function mountReconnectEffectHarness(
	onConnect: (connectedAt: number) => void | (() => void),
) {
	let status = $state<Pick<WsConnectionStatus, 'lastConnectedAt'>>({ lastConnectedAt: null });
	const cleanup = $effect.root(() => {
		createWsReconnectEffect(() => status, onConnect);
	});
	flushSync();
	return {
		setStatus(next: Pick<WsConnectionStatus, 'lastConnectedAt'>) {
			status = next;
			flushSync();
		},
		destroy() {
			cleanup();
		},
	};
}

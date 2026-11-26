import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';

export interface RefreshableCatalog {
	refreshIfLoaded(): Promise<void>;
}

// Refreshes loaded catalogs whenever the WebSocket connection becomes connected.
export function bindCatalogReconnect(
	ws: Pick<PrimaryWsConnectionPort, 'isConnected' | 'onConnectionChange'>,
	catalogs: readonly RefreshableCatalog[],
): () => void {
	const refreshAll = (): void => {
		for (const catalog of catalogs) {
			void catalog.refreshIfLoaded();
		}
	};
	if (ws.isConnected) refreshAll();
	return ws.onConnectionChange((connected) => {
		if (connected) refreshAll();
	});
}

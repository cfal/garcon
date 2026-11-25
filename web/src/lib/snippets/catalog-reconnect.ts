import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';

export interface ReconnectReconcilableCatalog {
	reconcileAfterReconnect(): Promise<void>;
}

// Reconciles loaded catalogs on every WebSocket connected transition, ignoring
// same-socket status updates and independent of wall-clock timestamp resolution.
export function bindCatalogReconnect(
	ws: Pick<PrimaryWsConnectionPort, 'isConnected' | 'onConnectionChange'>,
	catalogs: readonly ReconnectReconcilableCatalog[],
): () => void {
	const reconcile = (): void => {
		for (const catalog of catalogs) {
			void catalog.reconcileAfterReconnect();
		}
	};
	if (ws.isConnected) reconcile();
	return ws.onConnectionChange((connected) => {
		if (connected) reconcile();
	});
}

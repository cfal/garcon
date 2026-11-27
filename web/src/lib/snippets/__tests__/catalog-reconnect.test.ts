import { describe, expect, it, vi } from 'vitest';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { bindCatalogReconnect, type RefreshableCatalog } from '$lib/snippets/catalog-reconnect.js';
import type { SnippetsSnapshot } from '$shared/snippets';
import type { PreamblesSnapshot } from '$shared/preambles';

function createFakeWsPort(initialConnected = false) {
	let connected = initialConnected;
	const listeners = new Set<(connected: boolean) => void>();
	const port: Pick<PrimaryWsConnectionPort, 'isConnected' | 'onConnectionChange'> & {
		setConnected(next: boolean): void;
	} = {
		get isConnected() {
			return connected;
		},
		onConnectionChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setConnected(next) {
			if (connected === next) return;
			connected = next;
			for (const listener of [...listeners]) {
				listener(connected);
			}
		},
	};
	return port;
}

describe('bindCatalogReconnect', () => {
	it('refreshes catalogs on connected transitions only and stops after unsubscribe', () => {
		const ws = createFakeWsPort(false);
		const preambles: RefreshableCatalog = { refreshIfLoaded: vi.fn(async () => {}) };
		const snippets: RefreshableCatalog = { refreshIfLoaded: vi.fn(async () => {}) };

		const unbind = bindCatalogReconnect(ws, [preambles, snippets]);
		expect(preambles.refreshIfLoaded).not.toHaveBeenCalled();
		expect(snippets.refreshIfLoaded).not.toHaveBeenCalled();

		ws.setConnected(true);
		expect(preambles.refreshIfLoaded).toHaveBeenCalledTimes(1);
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(1);

		ws.setConnected(false);
		expect(preambles.refreshIfLoaded).toHaveBeenCalledTimes(1);
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(1);

		ws.setConnected(true);
		expect(preambles.refreshIfLoaded).toHaveBeenCalledTimes(2);
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(2);

		unbind();
		ws.setConnected(false);
		ws.setConnected(true);
		expect(preambles.refreshIfLoaded).toHaveBeenCalledTimes(2);
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(2);
	});

	it('refreshes immediately once when bound while already connected', () => {
		const ws = createFakeWsPort(true);
		const preambles: RefreshableCatalog = { refreshIfLoaded: vi.fn(async () => {}) };
		const snippets: RefreshableCatalog = { refreshIfLoaded: vi.fn(async () => {}) };

		const unbind = bindCatalogReconnect(ws, [preambles, snippets]);
		expect(preambles.refreshIfLoaded).toHaveBeenCalledTimes(1);
		expect(snippets.refreshIfLoaded).toHaveBeenCalledTimes(1);
		unbind();
	});

	it('does not load idle stores and synchronously clears freshness on loaded stores while reconnect GETs run', async () => {
		const ws = createFakeWsPort(false);
		const deferredSnippets = Promise.withResolvers<SnippetsSnapshot>();
		const deferredPreambles = Promise.withResolvers<PreamblesSnapshot>();
		const getIdle = vi.fn<() => Promise<SnippetsSnapshot>>();
		const snippets = new SnippetsStore({
			get: vi.fn<() => Promise<SnippetsSnapshot>>().mockReturnValueOnce(deferredSnippets.promise),
		});
		const preambles = new PreamblesStore({
			get: vi.fn<() => Promise<PreamblesSnapshot>>().mockReturnValueOnce(deferredPreambles.promise),
		});
		const idleSnippets = new SnippetsStore({ get: getIdle });
		snippets.applySnapshot({ revision: 3, snippets: [] });
		preambles.applySnapshot({ revision: 3, preambles: [] });

		const unbind = bindCatalogReconnect(ws, [preambles, snippets, idleSnippets]);
		try {
			expect(snippets.hasFreshSnapshot).toBe(true);
			expect(preambles.hasFreshSnapshot).toBe(true);

			ws.setConnected(true);
			expect(getIdle).not.toHaveBeenCalled();
			expect(snippets.hasFreshSnapshot).toBe(false);
			expect(preambles.hasFreshSnapshot).toBe(false);

			deferredSnippets.resolve({ revision: 4, snippets: [] });
			deferredPreambles.resolve({ revision: 4, preambles: [] });
			await vi.waitFor(() => {
				expect(snippets.hasFreshSnapshot).toBe(true);
				expect(preambles.hasFreshSnapshot).toBe(true);
			});
			expect(snippets.snapshot?.revision).toBe(4);
			expect(preambles.snapshot?.revision).toBe(4);
		} finally {
			unbind();
		}
	});
});

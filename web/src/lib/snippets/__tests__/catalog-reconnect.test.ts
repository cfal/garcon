import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsConnection } from '$lib/ws/connection.svelte.js';
import { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import { bindCatalogReconnect } from '$lib/snippets/catalog-reconnect.js';
import type { SnippetsSnapshot } from '$shared/snippets';
import type { PreamblesSnapshot } from '$shared/preambles';

vi.mock('$lib/api/client', () => ({
	getAuthToken: vi.fn(() => 'stored-token'),
}));

let mockSockets: MockWebSocket[] = [];

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readonly protocols: string | string[] | undefined;
	readyState = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
	});

	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
		mockSockets.push(this);
	}

	open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event('open'));
	}

	closeFromServer(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.(new CloseEvent('close'));
	}
}

function snippetsSnapshot(revision: number, ids: string[]): SnippetsSnapshot {
	return {
		revision,
		snippets: ids.map((id) => ({
			id,
			shortName: `snippet-${id}`,
			template: `Template ${id}`,
			defaultArguments: '',
			createdAt: '2029-01-01T00:00:00.000Z',
			updatedAt: '2029-01-01T00:00:00.000Z',
		})),
	};
}

function preamblesSnapshot(revision: number, ids: string[]): PreamblesSnapshot {
	return {
		revision,
		preambles: ids.map((id) => ({
			id,
			enabled: true,
			title: `Preamble ${id}`,
			content: `Content ${id}`,
			scope: { type: 'global' },
			agentIds: [],
			tagFilter: { mode: 'any', tags: [] },
			createdAt: '2029-01-01T00:00:00.000Z',
			updatedAt: '2029-01-01T00:00:00.000Z',
		})),
	};
}

describe('bindCatalogReconnect', () => {
	beforeEach(() => {
		mockSockets = [];
		vi.useFakeTimers();
		vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('reconciles on every connected transition even with identical Date.now() and ignores stability resets', async () => {
		const frozenNow = 1_700_000_000_000;
		vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

		const ws = new WsConnection();
		const removal = Promise.withResolvers<{ success: true; snapshot: SnippetsSnapshot }>();
		const remove = vi.fn(() => removal.promise);
		const getSnippets = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snippetsSnapshot(3, ['a', 'b']))
			.mockResolvedValueOnce(snippetsSnapshot(4, ['a']));
		const getPreambles = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(preamblesSnapshot(3, ['p1']))
			.mockResolvedValueOnce(preamblesSnapshot(4, ['p1']));
		const snippets = new SnippetsStore({ get: getSnippets, remove });
		const preambles = new PreamblesStore({ get: getPreambles });
		snippets.applySnapshot(snippetsSnapshot(3, ['a', 'b']));
		preambles.applySnapshot(preamblesSnapshot(3, ['p1']));

		const unbind = bindCatalogReconnect(ws, [preambles, snippets]);
		try {
			ws.connect('token', false);
			expect(mockSockets).toHaveLength(1);
			mockSockets[0]!.open();
			await vi.waitFor(() => {
				expect(getSnippets).toHaveBeenCalledTimes(1);
				expect(getPreambles).toHaveBeenCalledTimes(1);
				expect(snippets.hasFreshSnapshot).toBe(true);
				expect(preambles.hasFreshSnapshot).toBe(true);
			});

			// Stability timer resets reconnectAttempt on the same socket without firing onConnectionChange.
			const removing = snippets.remove('b');
			expect(remove).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(getSnippets).toHaveBeenCalledTimes(1);
			expect(getPreambles).toHaveBeenCalledTimes(1);

			removal.resolve({ success: true, snapshot: snippetsSnapshot(4, ['a']) });
			expect(await removing).toEqual(snippetsSnapshot(4, ['a']));
			expect(getSnippets).toHaveBeenCalledTimes(1);
			expect(snippets.snapshot).toEqual(snippetsSnapshot(4, ['a']));
			expect(snippets.hasFreshSnapshot).toBe(true);

			// Disconnect and reconnect while Date.now() returns the exact same timestamp.
			mockSockets[0]!.closeFromServer();
			expect(ws.isConnected).toBe(false);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(mockSockets.length).toBeGreaterThanOrEqual(2);
			mockSockets.at(-1)!.open();
			expect(ws.connectionStatus.lastConnectedAt).toBe(frozenNow);

			await vi.waitFor(() => {
				expect(getSnippets).toHaveBeenCalledTimes(2);
				expect(getPreambles).toHaveBeenCalledTimes(2);
				expect(snippets.hasFreshSnapshot).toBe(true);
				expect(preambles.hasFreshSnapshot).toBe(true);
			});

			// Unbinding stops reconciling subsequent reconnects.
			unbind();
			mockSockets.at(-1)!.closeFromServer();
			await vi.advanceTimersByTimeAsync(5_000);
			mockSockets.at(-1)!.open();
			await Promise.resolve();
			expect(getSnippets).toHaveBeenCalledTimes(2);
			expect(getPreambles).toHaveBeenCalledTimes(2);
		} finally {
			unbind();
			ws.disconnect();
		}
	});

	it('reconciles immediately once when bound after the WebSocket is already connected', async () => {
		const ws = new WsConnection();
		const getSnippets = vi
			.fn<() => Promise<SnippetsSnapshot>>()
			.mockResolvedValueOnce(snippetsSnapshot(1, ['restored']));
		const getPreambles = vi
			.fn<() => Promise<PreamblesSnapshot>>()
			.mockResolvedValueOnce(preamblesSnapshot(1, ['restored-p1']));
		const snippets = new SnippetsStore({ get: getSnippets });
		const preambles = new PreamblesStore({ get: getPreambles });
		snippets.applySnapshot(snippetsSnapshot(3, ['old']));
		preambles.applySnapshot(preamblesSnapshot(3, ['old-p1']));

		ws.connect('token', false);
		mockSockets[0]!.open();
		expect(ws.isConnected).toBe(true);

		const unbind = bindCatalogReconnect(ws, [preambles, snippets]);
		try {
			await vi.waitFor(() => {
				expect(getSnippets).toHaveBeenCalledTimes(1);
				expect(getPreambles).toHaveBeenCalledTimes(1);
				expect(snippets.snapshot).toEqual(snippetsSnapshot(1, ['restored']));
				expect(preambles.snapshot).toEqual(preamblesSnapshot(1, ['restored-p1']));
			});
		} finally {
			unbind();
			ws.disconnect();
		}
	});
});

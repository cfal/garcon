import { describe, expect, it, vi } from 'vitest';
import * as events from '$shared/ws-events';
import { WsConnection } from '$lib/ws/connection.svelte';
import { localExecutor } from '$lib/executors/__tests__/fixtures';
import { ApiProvidersRouter } from '../api-providers-router';
import { ChatBoardsRouter } from '../chat-boards-router';
import { ExecutorsRouter } from '../executors-router';
import { PreamblesRouter } from '../preambles-router';
import { RemoteSettingsRouter } from '../remote-settings-router';
import { ScheduledPromptsRouter } from '../scheduled-prompts-router';
import { SnippetsRouter } from '../snippets-router';
import { TicketsRouter } from '../tickets-router';
import { TranscriptSearchStatusController } from '../transcript-search-status-controller';

describe('root catalog routers', () => {
	it('validates only owned frames while retaining independent cursors and handler delivery', () => {
		const ws = new WsConnection();
		const parsed = vi.spyOn(events, 'parseServerWsMessage');
		const providers = { invalidate: vi.fn() };
		const boards = { publish: vi.fn() };
		const executors = { applySnapshot: vi.fn() };
		const preambles = { refreshIfLoaded: vi.fn() };
		const selections = { publish: vi.fn() };
		const settings = { applySnapshot: vi.fn() };
		const prompts = { refreshIfLoaded: vi.fn() };
		const snippets = { refreshIfLoaded: vi.fn() };
		const tickets = { publish: vi.fn() };
		const onStatus = vi.fn();
		const routers = [
			new ApiProvidersRouter(ws, providers),
			new ChatBoardsRouter(ws, boards),
			new ExecutorsRouter(ws, executors),
			new PreamblesRouter(ws, preambles, selections),
			new RemoteSettingsRouter(ws, settings),
			new ScheduledPromptsRouter(ws, prompts),
			new SnippetsRouter(ws, snippets),
			new TicketsRouter(ws, tickets),
			new TranscriptSearchStatusController(ws, onStatus),
		];
		const owned = [
			{ type: 'api-providers-invalidated' },
			{ type: 'chat-boards-invalidated', revision: 7, reason: 'reordered' },
			{ type: 'executors-changed', executors: [localExecutor] },
			{ type: 'preambles-invalidated', reason: 'updated' },
			{ type: 'chat-preambles-invalidated', chatId: '1700000000000001', revision: 3 },
			{ type: 'scheduled-prompts-invalidated', reason: 'executed' },
			{ type: 'snippets-invalidated', reason: 'updated' },
			{ type: 'tickets-invalidated', revision: 4 },
			{ type: 'tickets-invalidated', revision: -1 },
			{ type: 'settings-changed', settings: {} },
			{ type: 'transcript-search-status', status: {} },
		];
		try {
			for (const router of routers) router.start();
			ws.messages.push(...[
				{ type: 'chat-messages', chatId: '1700000000000001', messages: [] },
				...owned,
				{ type: 'unknown-event' },
			].map((data) => ({ data, timestamp: 0 })));
			for (const router of routers) { router.tick(); router.tick(); }
			expect(parsed).toHaveBeenCalledTimes(owned.length);
			expect(parsed.mock.calls.map(([data]) => data)).not.toContainEqual(expect.objectContaining({ type: 'chat-messages' }));
			expect(providers.invalidate).toHaveBeenCalledOnce();
			expect(boards.publish).toHaveBeenCalledExactlyOnceWith({ kind: 'catalog', revision: 7, reason: 'reordered' });
			expect(executors.applySnapshot).toHaveBeenCalledExactlyOnceWith([localExecutor]);
			expect(preambles.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(selections.publish).toHaveBeenCalledExactlyOnceWith({ kind: 'selection', chatId: '1700000000000001', revision: 3 });
			expect(prompts.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(snippets.refreshIfLoaded).toHaveBeenCalledOnce();
			expect(tickets.publish).toHaveBeenCalledExactlyOnceWith({ kind: 'collection', revision: 4 });
			expect(settings.applySnapshot).not.toHaveBeenCalled();
			expect(onStatus).not.toHaveBeenCalled();
			for (const router of routers) router.destroy();
			ws.messages.push({ data: { type: 'snippets-invalidated', reason: 'updated' }, timestamp: 1 });
			for (const router of routers) router.tick();
			expect(snippets.refreshIfLoaded).toHaveBeenCalledOnce();
		} finally {
			for (const router of routers) router.destroy();
			ws.disconnect();
			parsed.mockRestore();
		}
	});
});

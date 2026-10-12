import { afterEach, expect, it, vi } from 'vitest';
import { ConversationClearController } from '../conversation-clear-controller.svelte.js';

afterEach(() => vi.unstubAllGlobals());

it('captures a panel target without reading global selection or clearing any draft', async () => {
	const requests: unknown[] = [];
	vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return Response.json({ success: true, chatId: '1780000000000002', transcriptViewId: 'replacement' });
	}));
	const deps = {
		chatState: {
			getKnownHeadForChat: vi.fn(() => ({ transcriptViewId: 'other-panel', lastOrdinal: 99 })),
			appendLocalNoticeForChat: vi.fn(), recoverViewReplacement: vi.fn(async () => {}),
		},
		composerState: { draftRevision: vi.fn(() => 1), clearAfterSubmit: vi.fn() },
		sessions: { quietRefreshChats: vi.fn(async () => {}) },
	} satisfies ConstructorParameters<typeof ConversationClearController>[0];
	const controller = new ConversationClearController(deps);
	const head = { transcriptViewId: 'panel-view', lastOrdinal: 12 };
	controller.requestBeforeMessage('1780000000000002', head, 7);
	head.transcriptViewId = 'newer-view';
	head.lastOrdinal = 14;
	expect(controller.targetKind).toBe('before-message');
	await controller.confirm();
	await controller.confirm();
	expect(requests).toEqual([{ chatId: '1780000000000002', transcriptViewId: 'panel-view', lastOrdinal: 12,
		target: { kind: 'before-message', ordinal: 7 } }]);
	expect(deps.chatState.getKnownHeadForChat).not.toHaveBeenCalled();
	expect(deps.composerState.draftRevision).not.toHaveBeenCalled();
	expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
	expect(deps.chatState.recoverViewReplacement).toHaveBeenCalledWith('1780000000000002', 'panel-view');
});

it.each([400, 403, 409])('disarms a malformed HTTP %s reply and reconciles without retrying Clear', async status => {
	const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
		if (init?.method === 'POST') return new Response('{', { status });
		throw new TypeError('Synthetic offline reconciliation');
	});
	vi.stubGlobal('fetch', fetchMock);
	const deps = {
		chatState: {
			getKnownHeadForChat: () => ({ transcriptViewId: 'view-1', lastOrdinal: 3 }),
			appendLocalNoticeForChat: vi.fn(),
			recoverViewReplacement: vi.fn(async () => {}),
		},
		composerState: { draftRevision: () => 1, clearAfterSubmit: vi.fn() },
		sessions: { quietRefreshChats: vi.fn(async () => {}) },
	} satisfies ConstructorParameters<typeof ConversationClearController>[0];
	const controller = new ConversationClearController(deps);
	controller.request('1780000000000001', true);
	await controller.confirm();
	await controller.confirm();
	expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
		['/api/v1/chats/clear', 'POST'],
		['/api/v1/chats/snapshot?chatId=1780000000000001&limit=1', 'GET'],
	]);
	expect(controller.isOpen).toBe(false);
	expect(controller.error).toBeNull();
	expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
	expect(deps.chatState.recoverViewReplacement).not.toHaveBeenCalled();
	expect(deps.chatState.appendLocalNoticeForChat).toHaveBeenCalledWith(
		'1780000000000001', 'error', expect.stringContaining('Clear could not be confirmed'),
	);
});

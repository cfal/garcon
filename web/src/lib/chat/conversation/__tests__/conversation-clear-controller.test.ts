import { afterEach, expect, it, vi } from 'vitest';
import { ConversationClearController } from '../conversation-clear-controller.svelte.js';

afterEach(() => vi.unstubAllGlobals());

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

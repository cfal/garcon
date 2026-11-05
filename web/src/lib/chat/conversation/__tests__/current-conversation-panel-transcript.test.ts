import { afterEach, expect, it, vi } from 'vitest';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import { displayOpen, displayRow, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { clearChat } from '$lib/api/chat-clear.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { ConversationPanelRegistry, type ConversationPanelDescriptor } from '../conversation-panel-registry.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import { ConversationClearController } from '../conversation-clear-controller.svelte.js';

vi.mock('$lib/api/chat-clear.js', () => ({ clearChat: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function presentation(windowId: `window-${string}`, chatId = 'chat-1'): ConversationPanelDescriptor {
	return { surfaceId: `chat-view:${windowId}`, chatId, presentation: windowId, windowId, snapshotAdmission: 'admitted' };
}
function fixture() {
	const api = mockDisplayApi([displayRow(1)]);
	api.replace([displayRow(10)], displayOpen('chat-2', 'other-view', 10));
	let selectedChatId = 'chat-1';
	const registry = new ConversationPanelRegistry({ bodies: new DisplayBodyStore(), overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => new ConversationLifecycleState(), remove: () => {} },
		getSelectedChatId: () => selectedChatId, getComposerAnchorSurfaceId: () => 'chat-view:window-left',
	});
	const selected = new CurrentConversationPanelTranscript({ panels: registry, getSelectedChatId: () => selectedChatId });
	selected.activateChat(selectedChatId);
	cleanups.push(() => { selected.destroy(); registry.destroy(); });
	return { api, registry, selected, select(chatId: string) { selectedChatId = chatId; selected.activateChat(chatId); } };
}

it('opens canonical metadata before mount without fetching a second body window', async () => {
	const { api, registry, selected } = fixture();
	expect(await selected.loadMessages('chat-1', { purpose: 'activation' })).toEqual([]);
	expect(selected.getCursor()).toEqual({ transcriptViewId: 'view-1', lastOrdinal: 1 });
	expect(selected.openSnapshot).toBe(registry.openSnapshot('chat-1'));
	expect(api.window).not.toHaveBeenCalled();
	expect(api.bodies).not.toHaveBeenCalled();
	expect(api.open.mock.calls[0][0].reason).toBe('activate');
});

it.each([1, 2])('publishes an activation admitted before mount to %i new panels', async count => {
	const { api, registry, selected } = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	api.open.mockReturnValueOnce(held.promise);
	const opening = selected.loadMessages('chat-1', { purpose: 'activation' });
	await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
	registry.reconcile(['window-left', 'window-right'].slice(0, count).map(id => presentation(id as `window-${string}`)));
	held.resolve(displayOpen('chat-1', 'view-1', 1));
	expect(await opening).toEqual([displayRow(1).message]);
	for (const panel of registry.panelsForChat('chat-1')) expect(panel.transcript.entries).toEqual([displayRow(1)]);
	expect(api.open).toHaveBeenCalledOnce();
});

it.each([0, 1, 2])('recovers Clear without WS delivery across %i panels and a stale open', async count => {
	const { api, registry, selected } = fixture();
	registry.reconcile(['window-left', 'window-right'].slice(0, count).map(id => presentation(id as `window-${string}`)));
	await selected.loadMessages('chat-1');
	selected.upsertOptimisticUserInput({ chatId: 'chat-1', clientMessageId: 'input-1', content: 'Synthetic pending input', createdAt: '', delivery: 'pending' });
	selected.appendLocalNoticeForChat('chat-1', 'error', 'Synthetic old error');
	const old = Promise.withResolvers<DisplayOpenResponse>();
	api.open.mockReturnValueOnce(old.promise);
	const oldLoad = selected.loadMessages('chat-1');
	await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
	api.replace([], displayOpen('chat-1', 'cleared-view', 0));
	vi.mocked(clearChat).mockResolvedValue({ success: true, chatId: 'chat-1', transcriptViewId: 'cleared-view' });
	const sessions = { quietRefreshChats: vi.fn(async () => {}) };
	const controller = new ConversationClearController({ chatState: selected, sessions,
		composerState: { draftRevision: () => 1, clearAfterSubmit: vi.fn() } });
	controller.request('chat-1', true);
	await controller.confirm();
	old.resolve(displayOpen('chat-1', 'view-1', 2));
	await oldLoad;
	expect(selected.transcriptViewId).toBe('cleared-view');
	expect(selected.chatMessages).toEqual([]);
	expect(registry.overlayFor('chat-1')?.optimisticInputs).toEqual([]);
	expect(selected.displayRows).toEqual([]);
	expect(sessions.quietRefreshChats).toHaveBeenCalledOnce();
	expect(controller.isOpen).toBe(false);
});

it('preserves a newer admitted view and its overlays after a delayed Clear acknowledgement', async () => {
	const { api, registry, selected } = fixture();
	registry.reconcile([presentation('window-left')]);
	api.replace([displayRow(5)], displayOpen('chat-1', 'newer-view', 5));
	await selected.loadMessages('chat-1');
	selected.upsertOptimisticUserInput({ chatId: 'chat-1', clientMessageId: 'input-1', content: 'Newer input', createdAt: '', delivery: 'pending' });
	api.open.mockClear();
	await selected.recoverViewReplacement('chat-1', 'view-1');
	expect(api.open).not.toHaveBeenCalled();
	expect(selected.transcriptViewId).toBe('newer-view');
	expect(selected.displayMessages.some(message => message.type === 'user-message' && message.content === 'Newer input')).toBe(true);
});

it('publishes only to the captured chat after selection changes', async () => {
	const { api, registry, selected, select } = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	api.open.mockReturnValueOnce(held.promise);
	const opening = selected.loadMessages('chat-1');
	await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
	select('chat-2');
	registry.reconcile([presentation('window-left', 'chat-2'), presentation('window-right')]);
	await registry.loadChatSnapshot('chat-2');
	held.resolve(displayOpen('chat-1', 'view-1', 1));
	expect(await opening).toEqual([displayRow(1).message]);
	expect(registry.panel('chat-view:window-right')!.transcript.entries).toEqual([displayRow(1)]);
	expect(selected.transcriptViewId).toBe('other-view');
	expect(selected.entries).toEqual([displayRow(10)]);
});

it('does not resurrect retired instance metadata when a held open finishes', async () => {
	const { api, registry, selected } = fixture();
	await selected.loadMessages('chat-1');
	const held = Promise.withResolvers<DisplayOpenResponse>();
	api.open.mockReturnValueOnce(held.promise);
	const opening = selected.loadMessages('chat-1');
	await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
	registry.resetServerInstance('instance-2');
	expect(selected.openSnapshot).toBeNull();
	expect(selected.transcriptViewId).toBe('');
	held.resolve(displayOpen('chat-1', 'view-1', 2));
	await opening;
	expect(selected.openSnapshot).toBeNull();
	expect(api.window).not.toHaveBeenCalled();
});

it('keeps a failed replacement empty through revisit, then retries the canonical open', async () => {
	const { api, registry, selected, select } = fixture();
	registry.reconcile([presentation('window-left')]);
	await selected.loadMessages('chat-1');
	api.open.mockRejectedValueOnce(new Error('Synthetic recovery failure'));
	await expect(selected.recoverViewReplacement('chat-1', 'view-1')).rejects.toThrow('Synthetic recovery failure');
	expect(registry.openSnapshot('chat-1')).toBeNull();
	expect(selected.chatMessages).toEqual([]);
	select('chat-2'); registry.reconcile([presentation('window-left', 'chat-2')]);
	await selected.loadMessages('chat-2');
	api.replace([], displayOpen('chat-1', 'cleared-view', 0));
	select('chat-1'); registry.reconcile([presentation('window-left')]);
	expect(selected.chatMessages).toEqual([]);
	await selected.loadMessages('chat-1');
	expect(selected.transcriptViewId).toBe('cleared-view');
});

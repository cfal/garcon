import { seedTranscript } from '$lib/chat/transcript/__tests__/transcript-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	reloadChatFromNative,
	type ChatReloadOptions,
	type ChatReloadPort,
} from '$lib/chat/conversation/reload-chat.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationPanelRegistry } from '../conversation-panel-registry.svelte.js';
import { ConversationLifecycleState } from '../conversation-lifecycle-state.svelte.js';
import { CurrentConversationPanelTranscript } from '../current-conversation-panel-transcript.js';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import { getChatMessages, getCombinedChatMessages } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import type { TranscriptAnchorPage } from '$shared/transcript-anchor-page';
import { AssistantMessage, ExitPlanModeToolUseMessage } from '$shared/chat-types';
import { isUnavailableChatHistoryResponse, type ChatHistoryResponse, type CompleteChatHistoryResponse } from '$shared/chat-view';
import type { WsRequestProgress } from '$lib/ws/connection.svelte.js';
import { WsRequestError } from '$lib/ws/ws-request-error.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
	getCombinedChatMessages: vi.fn(),
}));

const TS = '2024-01-01T00:00:00.000Z';
const cleanups: (() => void)[] = [];

function fixture({ combineMessages = false, duplicate = false, hydrated = false, maxHiddenEntries = 25, deferredSnapshot = false,
	conversationUi = new ConversationUiState() } = {}) {
	if (hydrated) {
		const persisted = new ChatTranscriptCache({ limit: 100 });
		persisted.replaceFromPage('chat-1', { ...emptyPage('generation-1'), lastOrdinal: 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Hydrated row') }] });
		persisted.flush();
	}
	const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries });
	const lifecycle = new ConversationLifecycleState();
	const panels = new ConversationPanelRegistry({
		cache, overlays: new ConversationTranscriptOverlayStore(),
		onTranscriptViewReplaced: (chatId, previousViewId) => conversationUi.retirePlanModeForView(chatId, previousViewId),
		lifecycle: { forChat: () => lifecycle, remove: () => {} },
		getComposerAnchorSurfaceId: () => 'chat-view:window-main', getSelectedChatId: () => 'chat-1',
		combineMessages,
	});
	panels.reconcile((duplicate ? ['main', 'peer'] : ['main']).map(id => ({
		chatId: 'chat-1', surfaceId: `chat-view:window-${id}`, windowId: `window-${id}`,
		presentation: `window-${id}`, snapshotAdmission: deferredSnapshot ? 'deferred' : 'admitted',
	})));
	cleanups.push(() => { panels.destroy(); cache.flush(); });
	return { panels, chat: panels.panel('chat-view:window-main')!.transcript };
}

function emptyPage(viewId: string): CompleteChatHistoryResponse {
	return { chatId: 'chat-1', transcriptViewId: viewId, lastOrdinal: 0,
		pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
		messages: [], historyState: { kind: 'complete' }, limit: 50, resendCandidates: [] };
}

function wsWithResponse(response: Record<string, unknown> | Promise<Record<string, unknown>>) {
	const requests: WsRequestProgress[] = [];
	const ws = {
		sendProgressRequest: vi.fn((_message: object, progress: WsRequestProgress) => {
			requests.push(progress);
			return { clientRequestId: 'req-1', response: Promise.resolve(response) };
		}),
		sendMessage: vi.fn(() => true),
	} satisfies ChatReloadPort;
	return Object.assign(ws, { progress: () => requests[0]! });
}

function options(overrides: Partial<ChatReloadOptions> = {}): ChatReloadOptions {
	return { signal: new AbortController().signal, onProgress: vi.fn(), ...overrides };
}

describe('reloadChatFromNative', () => {
	afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
		vi.mocked(getCombinedChatMessages).mockReset();
	});

	it.each([false, true])('confirms the current view after a delayed retired commit (read already pending=%s)', async pending => {
		const { panels, chat } = fixture({ hydrated: true });
		panels.captureNativeReload('chat-1').apply(emptyPage('generation-2'));
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		if (pending) vi.mocked(getChatMessages).mockReturnValueOnce(held.promise);
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-2'));
		const loading = pending ? panels.loadChatSnapshot('chat-1') : null;
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 2, lastOrdinal: 2,
			messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'Retired row') }], resendCandidates: [], noticeRevision: 0 });
		const recovery = loading ?? panels.loadChatSnapshot('chat-1');
		held.resolve(emptyPage('generation-2'));
		expect(await recovery).toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(pending ? 2 : 1);
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 0, stale: false });
		expect(chat.transcriptCache.needsSnapshotRecovery('chat-1')).toBe(false);
	});

	it.each([false, true])('does not certify a fallback snapshot behind a same-view cache append (evicted=%s)', async evicted => {
		const { panels, chat } = fixture({ hydrated: true, maxHiddenEntries: evicted ? 0 : 25 });
		const page = { ...emptyPage('generation-2'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'First row') }] };
		panels.captureNativeReload('chat-1').apply(page);
		panels.reconcile([]);
		chat.transcriptCache.setMountedChatIds(['chat-1']);
		chat.transcriptCache.replaceFromPage('chat-1', page);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 2, lastOrdinal: 2,
			messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'Retired row') }], resendCandidates: [], noticeRevision: 0 });
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		const full = { ...page, lastOrdinal: 2, pageNewestOrdinal: 2,
			messages: [...page.messages, { ordinal: 2, message: new AssistantMessage(TS, 'Second row') }] };
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue(full);
		const loading = fallback.loadMessages('chat-1');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 2, lastOrdinal: 2,
			messages: full.messages.slice(1), resendCandidates: [], noticeRevision: 0 });
		if (evicted) {
			chat.transcriptCache.setMountedChatIds([]);
			expect(chat.transcriptCache.get('chat-1')).toBeNull();
			chat.transcriptCache.setMountedChatIds(['chat-1']);
		}
		held.resolve(page);
		await loading;
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false });
		expect(chat.transcriptCache.get('chat-1')?.messages.map(entry => entry.ordinal)).toEqual([1, 2]);
		fallback.activateChat(null);
	});

	it('bounds recovery when both fallback attempts leave a live gap', async () => {
		const { panels, chat } = fixture({ hydrated: true });
		const pages = [1, 3, 5].map(lastOrdinal => ({ ...emptyPage('generation-2'), lastOrdinal, pageOldestOrdinal: 1,
			pageNewestOrdinal: lastOrdinal, messages: Array.from({ length: lastOrdinal }, (_, index) => ({ ordinal: index + 1,
				message: new AssistantMessage(TS, `Row ${index + 1}`) })) }));
		panels.captureNativeReload('chat-1').apply(pages[0]);
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		chat.transcriptCache.applyMessages('chat-1', 'generation-1', { firstOrdinal: 2, lastOrdinal: 2, messages: pages[1].messages.slice(1) });
		const reads = [Promise.withResolvers<CompleteChatHistoryResponse>(), Promise.withResolvers<CompleteChatHistoryResponse>()];
		vi.mocked(getChatMessages).mockReturnValueOnce(reads[0].promise).mockReturnValueOnce(reads[1].promise);
		const loading = fallback.loadMessages('chat-1');
		for (const [index, read] of reads.entries()) {
			await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(index + 1));
			panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: pages[index + 1].lastOrdinal,
				lastOrdinal: pages[index + 1].lastOrdinal, messages: pages[index + 1].messages.slice(-1), resendCandidates: [], noticeRevision: 0 });
			read.resolve(pages[index]);
		}
		await expect(loading).resolves.toBeDefined();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 3, stale: true });
		expect(chat.transcriptCache.get('chat-1')?.messages.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
		expect(chat.transcriptCache.needsSnapshotRecovery('chat-1')).toBe(true);
		fallback.activateChat(null);
	});

	it('retires the accepted predecessor plan even when the transient feed is a placeholder', async () => {
		const conversationUi = new ConversationUiState();
		const { panels } = fixture({ hydrated: true, conversationUi });
		conversationUi.beginPlanModeForChat('chat-1', 'default', 'generation-1');
		conversationUi.updatePendingPermissionsForChat('chat-1', [{ permissionOccurrenceId: 'old-plan',
			requestedTool: new ExitPlanModeToolUseMessage(TS, 'old-plan', 'Synthetic plan'),
			transcript: { transcriptViewId: 'generation-1', afterOrdinal: 1 } }]);
		conversationUi.setTransientFeedFromSnapshot({ chatId: 'chat-1', transcriptViewId: 'pending:epoch',
			serverInstanceId: 'server', transientRevision: 0, rows: [] });
		panels.handleViewReplacement('chat-1', 'generation-3', 'generation-2');
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-3'));
		await panels.loadChatSnapshot('chat-1');
		expect(conversationUi.pendingPermissionsFor('chat-1')).toEqual([]);
		expect(conversationUi.previousPermissionModeFor('chat-1')).toBeNull();
	});

	it.each(['fallback', 'registry'] as const)('repairs a confirmed lower same-view head with foreign debt through the %s', async host => {
		const { panels, chat } = fixture({ combineMessages: true, hydrated: true });
		const transcript = host === 'registry' ? chat : new ActiveTranscriptState(chat.transcriptCache, null, { combineMessages: true });
		seedTranscript(transcript, 'chat-1', 'generation-1', [1, 2].map(ordinal => ({ ordinal,
			message: new AssistantMessage(TS, `Row ${ordinal}`) })), {
			lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2, nextBeforeOrdinal: null, hasMore: false,
		});
		chat.transcriptCache.applyMessages('chat-1', 'retired', { firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Retired row') }] });
		vi.mocked(getCombinedChatMessages).mockResolvedValue({ chatId: 'chat-1', transcriptViewId: 'generation-1',
			historyState: { kind: 'complete' }, direction: 'backward', watermarkOrdinal: 1, lastOrdinal: 1,
			startOrdinal: 1, endOrdinal: 2, anchorsRemaining: 99, pageStatus: 'exhausted', resendCandidates: [],
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Retained row') }] });
		if (host === 'registry') await panels.loadChatSnapshot('chat-1');
		else await transcript.loadMessages('chat-1');
		expect(transcript.entries.map(entry => entry.ordinal)).toEqual([1]);
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 1, stale: false });
		expect(chat.transcriptCache.needsSnapshotRecovery('chat-1')).toBe(false);
		expect(chat.transcriptCache.snapshotRecoveryFloor('chat-1', 'generation-1')).toBe(0);
	});

	it.each(['no pending read', 'refresh in progress'] as const)('retains the missed frontier when Reload takes over with %s', async phase => {
		const full = { ...emptyPage('generation-2'), lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2,
			messages: [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `Row ${ordinal}`) })) };
		const { panels, chat } = fixture({ hydrated: true });
		const reload = panels.captureNativeReload('chat-1');
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		const first = Promise.withResolvers<CompleteChatHistoryResponse>();
		const recovery = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(first.promise).mockReturnValueOnce(recovery.promise).mockResolvedValue(full);
		const loading = phase === 'refresh in progress' ? panels.loadChatSnapshot('chat-1') : null;
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 2, lastOrdinal: 2,
			messages: full.messages.slice(1), resendCandidates: [], noticeRevision: 0 });
		const old = loading ?? panels.loadChatSnapshot('chat-1');
		if (loading) {
			first.resolve(emptyPage('generation-1'));
			await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
		}
		reload.apply({ ...full, lastOrdinal: 1, pageNewestOrdinal: 1, messages: full.messages.slice(0, 1) });
		expect(chat.transcriptCache.readAppliedCursor('chat-1')?.stale).toBe(true);
		first.resolve(full);
		recovery.resolve(full);
		await old;
		await vi.waitFor(() => expect(chat.transcriptCache.readAppliedCursor('chat-1'))
			.toMatchObject({ transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false }));
	});

	it.each(['generation-2', 'generation-3'])('shares missed-frontier recovery for %s between fallback and mounted panels', async missedView => {
		const { panels, chat } = fixture({ hydrated: true });
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		const fresh = Promise.withResolvers<CompleteChatHistoryResponse>();
		const retired = Promise.withResolvers<CompleteChatHistoryResponse>();
		const full = { ...emptyPage(missedView), lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2,
			messages: [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `Row ${ordinal}`) })) };
		vi.mocked(getChatMessages).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(retired.promise).mockResolvedValue(full);
		const fallbackLoad = fallback.loadMessages('chat-1');
		chat.transcriptCache.markStale('chat-1');
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		const old = panels.loadChatSnapshot('chat-1');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: missedView, firstOrdinal: 2, lastOrdinal: 2,
			messages: full.messages.slice(1), resendCandidates: [], noticeRevision: 0 });
		fresh.resolve({ ...full, transcriptViewId: 'generation-2', lastOrdinal: 1, pageNewestOrdinal: 1, messages: full.messages.slice(0, 1) });
		retired.resolve(full);
		await fallbackLoad;
		expect(await old).toBe(true);
		await vi.waitFor(() => expect(chat.transcriptCache.readAppliedCursor('chat-1'))
			.toMatchObject({ transcriptViewId: missedView, lastOrdinal: 2, stale: false }));
		expect(panels.panel('chat-view:window-main')!.transcript.entries.map(entry => entry.ordinal)).toEqual([1, 2]);
		fallback.activateChat(null);
	});

	it('joins the pending replacement when old-view paging reports a stale view', async () => {
		const { panels, chat } = fixture({ hydrated: true, combineMessages: true });
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		const held = Promise.withResolvers<TranscriptAnchorPage>();
		vi.mocked(getCombinedChatMessages).mockReturnValueOnce(held.promise)
			.mockRejectedValueOnce(new ApiError(409, 'Synthetic stale view', 'STALE_TRANSCRIPT_VIEW'));
		const loading = panels.loadChatSnapshot('chat-1', { purpose: 'activation' });
		chat.nextBeforeOrdinal = 2;
		chat.hasEarlierMessages = true;
		const paging = chat.loadEarlierPage('chat-1');
		await vi.waitFor(() => expect(getCombinedChatMessages).toHaveBeenCalledTimes(2));
		await Promise.resolve();
		await Promise.resolve();
		held.resolve({ historyState: { kind: 'complete' }, chatId: 'chat-1', transcriptViewId: 'generation-2',
			direction: 'backward', watermarkOrdinal: 1, lastOrdinal: 1, startOrdinal: 1, endOrdinal: 2,
			anchorsRemaining: 99, pageStatus: 'exhausted', resendCandidates: [],
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Replacement row') }] });
		expect(await loading).toBe(true);
		await paging;
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
		expect(getCombinedChatMessages).toHaveBeenCalledTimes(2);
	});

	it('does not replace a newer pending destination with a delayed predecessor event', async () => {
		const { panels, chat } = fixture({ hydrated: true });
		panels.handleViewReplacement('chat-1', 'generation-3', 'generation-1');
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue(emptyPage('generation-3'));
		const loading = panels.loadChatSnapshot('chat-1');
		panels.appendLocalNotice('chat-1', 'warning', 'Current destination notice');
		expect(panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1')).toBe(false);
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Current destination notice']);
		held.resolve(emptyPage('generation-3'));
		expect(await loading).toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.transcriptViewId).toBe('generation-3');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Current destination notice']);
	});

	it.each(['removed', 'invalidated'] as const)('carries cold first-view refresh debt past a %s loader', async interruption => {
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		const complete = { ...emptyPage('generation-1'), lastOrdinal: 3, pageOldestOrdinal: 1, pageNewestOrdinal: 3,
			messages: [1, 2, 3].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `Row ${ordinal}`) })) };
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue(complete);
		const { panels, chat } = fixture({ duplicate: true });
		const loading = panels.loadChatSnapshot('chat-1');
		for (const ordinal of [1, 3]) panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1',
			firstOrdinal: ordinal, lastOrdinal: ordinal, messages: [{ ordinal, message: new AssistantMessage(TS, `Row ${ordinal}`) }],
			resendCandidates: [], noticeRevision: 0 });
		if (interruption === 'removed') panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-peer',
			windowId: 'window-peer', presentation: 'window-peer', snapshotAdmission: 'admitted' }]);
		else panels.invalidateChatSnapshot('chat-1');
		held.resolve({ ...complete, lastOrdinal: 1, pageNewestOrdinal: 1, messages: complete.messages.slice(0, 1) });
		expect(await loading).toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(panels.panel('chat-view:window-peer')!.transcript.entries.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ lastOrdinal: 3, stale: false });
	});

	it('transfers owed ledger recovery when a Reload reply takes over its snapshot', async () => {
		const { panels, chat } = fixture({ hydrated: true });
		const reload = panels.captureNativeReload('chat-1');
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		const full = { ...emptyPage('generation-2'), lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2,
			messages: [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `Row ${ordinal}`) })) };
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue(full);
		const old = panels.loadChatSnapshot('chat-1');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 2, lastOrdinal: 2,
			messages: full.messages.slice(1), resendCandidates: [], noticeRevision: 0 });
		reload.apply({ ...full, lastOrdinal: 1, pageNewestOrdinal: 1, messages: full.messages.slice(0, 1) });
		held.resolve(full);
		await old;
		await Promise.resolve();
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		await vi.waitFor(() => expect(chat.transcriptCache.readAppliedCursor('chat-1'))
			.toMatchObject({ transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false }));
	});

	it.each([false, true])('fences old-view commits before overlay publication (cold=%s)', cold => {
		const { panels, chat } = fixture({ hydrated: !cold, deferredSnapshot: true });
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		panels.appendLocalNotice('chat-1', 'warning', 'Replacement notice');
		expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Old row') }], resendCandidates: [],
			noticeRevision: panels.noticeRevisionFor('chat-1') }).kind).toBe('chat-recovery-required');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Replacement notice']);
		if (cold) expect(chat.transcriptCache.get('chat-1')).toBeNull();
	});

	it('resets chained announcements before notices for their final destination arrive', async () => {
		const { panels } = fixture({ hydrated: true });
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		panels.handleViewReplacement('chat-1', 'generation-3', 'generation-2');
		panels.appendLocalNotice('chat-1', 'warning', 'Final-view notice');
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-3'));
		expect(await panels.loadChatSnapshot('chat-1')).toBe(true);
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Final-view notice']);
	});

	it('does not recheck an already pending destination when its transient feed repeats it', async () => {
		const { panels } = fixture({ hydrated: true });
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue(emptyPage('generation-2'));
		const loading = panels.loadChatSnapshot('chat-1');
		expect(panels.handleViewReplacement('chat-1', 'generation-2', 'generation-2')).toBe(false);
		held.resolve(emptyPage('generation-2'));
		expect(await loading).toBe(true);
		expect(getChatMessages).toHaveBeenCalledOnce();
	});

	it('fences Reload after teardown when an unknown replacement was already pending', () => {
		const { panels, chat } = fixture({ hydrated: true });
		panels.handleViewReplacement('chat-1');
		const reload = panels.captureNativeReload('chat-1');
		panels.destroy();
		reload.apply(emptyPage('generation-2'));
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-1');
	});

	it('retries a failed admitted revalidation on the next activation', async () => {
		const { panels, chat } = fixture({ hydrated: true, deferredSnapshot: true });
		vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(emptyPage('generation-1'));
		const descriptor = { chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' } as const;
		panels.reconcile([descriptor]);
		await expect(panels.loadChatSnapshot('chat-1')).rejects.toThrow('Offline');
		await vi.waitFor(() => expect(chat.transcriptCache.readAppliedCursor('chat-1')?.stale).toBe(true));
		panels.reconcile([]);
		panels.reconcile([descriptor]);
		await panels.loadChatSnapshot('chat-1');
		expect(getChatMessages).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])('retains refresh debt for the installed replacement (announced=%s)', async announced => {
		const { panels, chat } = fixture({ hydrated: true });
		if (announced) panels.handleViewReplacement('chat-1', 'generation-2');
		const held = Promise.withResolvers<CompleteChatHistoryResponse>();
		const page = { ...emptyPage('generation-2'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'First row') }] };
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue({ ...page,
			lastOrdinal: 2, pageNewestOrdinal: 2,
			messages: [...page.messages, { ordinal: 2, message: new AssistantMessage(TS, 'Final row') }] });
		const loading = panels.loadChatSnapshot('chat-1');
		expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2',
			firstOrdinal: 2, lastOrdinal: 2, messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'Final row') }],
			resendCandidates: [], noticeRevision: 0 }).kind).toBe('chat-recovery-required');
		const recovery = panels.loadChatSnapshot('chat-1');
		held.resolve(page);
		expect(await loading).toBe(true);
		expect(await recovery).toBe(true);
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false });
	});

	it.each(['degraded', 'rejected'] as const)('projects the first live base after a cold read is %s', async outcome => {
		const held = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise);
		const { panels, chat } = fixture();
		const loading = panels.loadChatSnapshot('chat-1');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Live row') }], resendCandidates: [], noticeRevision: 0 });
		if (outcome === 'rejected') held.reject(new Error('Unavailable read'));
		else held.resolve({ chatId: 'chat-1', messages: [], historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		expect(await loading).toBe(false);
		expect(chat.transcriptViewId).toBe('generation-1');
		expect(chat.chatMessages).toEqual([expect.objectContaining({ content: 'Live row' })]);
		expect(chat.loadStatus).toBe('loaded');
	});

	it.each(['degraded', 'rejected'] as const)('repairs a first live base with a gap after a cold read is %s', async outcome => {
		const held = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise).mockResolvedValue({ ...emptyPage('generation-1'),
			lastOrdinal: 3, pageOldestOrdinal: 1, pageNewestOrdinal: 3,
			messages: [1, 2, 3].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `Live row ${ordinal}`) })) });
		const { panels, chat } = fixture();
		const loading = panels.loadChatSnapshot('chat-1');
		for (const ordinal of [1, 3]) panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1',
			firstOrdinal: ordinal, lastOrdinal: ordinal, messages: [{ ordinal, message: new AssistantMessage(TS, `Live row ${ordinal}`) }],
			resendCandidates: [], noticeRevision: 0 });
		if (outcome === 'rejected') held.reject(new Error('Unavailable read'));
		else held.resolve({ chatId: 'chat-1', messages: [], historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		expect(await loading).toBe(true);
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.entries.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-1', lastOrdinal: 3, stale: false });
	});

	it('does not let cross-tab hydration supersede a cold authoritative read', async () => {
		const held = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(held.promise);
		const { panels, chat } = fixture();
		const loading = panels.loadChatSnapshot('chat-1');
		const otherTab = new ChatTranscriptCache({ limit: 100 });
		otherTab.replaceFromPage('chat-1', { ...emptyPage('generation-1'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Stored old row') }] });
		otherTab.flush();
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Current row') }], resendCandidates: [], noticeRevision: 0 });
		held.resolve({ ...emptyPage('generation-2'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Current row') }] });
		expect(await loading).toBe(true);
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.loadStatus).toBe('loaded');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
	});

	it('rechecks a delayed announcement without retiring the accepted view or its overlays', async () => {
		const { panels, chat } = fixture({ hydrated: true });
		chat.setFromPage('chat-1', emptyPage('generation-3'), chat.beginSnapshotLoad());
		panels.appendLocalNotice('chat-1', 'warning', 'Current notice');
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-3'));
		expect(await panels.loadChatSnapshot('chat-1')).toBe(true);
		panels.handleViewReplacement('chat-1', 'generation-3', 'generation-2');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-3', stale: false });
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Current notice']);
	});

	it.each((['earlier', 'later'] as const).flatMap(direction => [
		...(['complete', 'degraded', 'rejected'] as const).map(outcome => ({ direction, outcome, combineMessages: false })),
		{ direction, outcome: 'complete' as const, combineMessages: true },
	]))('fences $direction paging at the final application await ($outcome, combined=$combineMessages)', async ({ direction, outcome, combineMessages }) => {
		const { chat } = fixture({ hydrated: true, combineMessages });
		chat.nextBeforeOrdinal = 2;
		chat.hasEarlierMessages = true;
		chat.lastOrdinal = 2;
		chat.hasLaterMessages = true;
		const ordinal = direction === 'earlier' ? 1 : 2;
		vi.mocked(getCombinedChatMessages).mockImplementation(async request => ({ chatId: 'chat-1',
			transcriptViewId: 'generation-1', historyState: { kind: 'complete' }, direction: request.direction,
			lastOrdinal: 2, watermarkOrdinal: 2, startOrdinal: ordinal, endOrdinal: ordinal + 1,
			anchorsRemaining: request.anchorsRemaining - 1, pageStatus: 'exhausted',
			messages: [{ ordinal, message: new AssistantMessage(TS, 'Old page') }], resendCandidates: [] }));
		if (outcome === 'rejected') vi.mocked(getChatMessages).mockRejectedValueOnce(new Error('Old page failed'));
		else vi.mocked(getChatMessages).mockResolvedValueOnce(outcome === 'degraded'
			? { chatId: 'chat-1', messages: [], historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } }
			: { ...emptyPage('generation-1'), lastOrdinal: 2, pageOldestOrdinal: ordinal, pageNewestOrdinal: ordinal,
				limit: direction === 'later' ? 1 : 50,
				nextBeforeOrdinal: ordinal > 1 ? ordinal : null, hasMore: ordinal > 1,
				messages: [{ ordinal, message: new AssistantMessage(TS, 'Old page') }] });
		const result = await chat[direction === 'earlier' ? 'loadEarlierPage' : 'loadLaterPage']('chat-1', { applicationGate: () => {
			queueMicrotask(() => queueMicrotask(() => chat.setFromPage('chat-1', emptyPage('generation-2'), chat.beginSnapshotLoad())));
			return Promise.resolve('apply');
		} });
		expect(result).toBe(outcome === 'rejected' ? 'failed' : 'invalidated');
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.entries).toEqual([]);
		expect(chat.pageStates[direction].status).not.toBe('error');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
	});

	it.each(['resolve', 'reject', 'removed loader'] as const)('retires shared retries when a peer replaces their view (%s)', async finish => {
		const { panels, chat } = fixture({ hydrated: true, duplicate: true });
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise).mockResolvedValue({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		const loading = panels.loadChatSnapshot('chat-1');
		panels.invalidateChatSnapshot('chat-1');
		const peer = panels.panel('chat-view:window-peer')!.transcript;
		peer.setFromPage('chat-1', emptyPage('generation-2'), peer.beginSnapshotLoad());
		if (finish === 'removed loader') panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-peer',
			windowId: 'window-peer', presentation: 'window-peer', snapshotAdmission: 'admitted' }]);
		if (finish === 'reject') previous.reject(new Error('Retired read failed'));
		else previous.resolve(emptyPage('generation-1'));
		expect(await loading).toBe(false);
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
	});

	it.each(['different', 'matching', 'degraded', 'rejected'] as const)('fences a cold shared read after Reload and eviction (%s)', async outcome => {
		const { panels, chat } = fixture({ deferredSnapshot: true, maxHiddenEntries: 0 });
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		const previous = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise).mockResolvedValue({ ...emptyPage('generation-2'),
			lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2,
			messages: [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `New row ${ordinal}`) })) });
		const loading = fallback.loadMessages('chat-1');
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		panels.captureNativeReload('chat-1').apply({ ...emptyPage('generation-2'), lastOrdinal: 2, pageOldestOrdinal: 1, pageNewestOrdinal: 2,
			messages: [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `New row ${ordinal}`) })) });
		panels.appendLocalNotice('chat-1', 'warning', 'New notice');
		chat.transcriptCache.flush();
		panels.reconcile([]);
		if (outcome === 'rejected') previous.reject(new Error('Cold read failed'));
		else if (outcome === 'degraded') previous.resolve({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		else previous.resolve(emptyPage(outcome === 'matching' ? 'generation-2' : 'generation-1'));
		await loading;
		chat.transcriptCache.flush();
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		expect(chat.transcriptCache.listCursors()).toContainEqual({ chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 2 });
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New notice']);
		fallback.activateChat(null);
	});

	it('runs a queued activation after refresh-only invalidation', async () => {
		const { panels } = fixture({ hydrated: true });
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise)
			.mockImplementation(async request => ({ ...emptyPage('generation-1'), limit: request.limit ?? 50 }));
		const loading = panels.loadChatSnapshot('chat-1');
		const activation = panels.loadChatSnapshot('chat-1', { purpose: 'activation', minimumLimit: 100 });
		panels.invalidateChatSnapshot('chat-1');
		previous.resolve(emptyPage('generation-1'));
		expect(await loading).toBe(true);
		expect(await activation).toBe(true);
		expect(vi.mocked(getChatMessages).mock.calls.map(([request]) => request)).toEqual([
			{ chatId: 'chat-1', limit: 50 }, { chatId: 'chat-1', limit: 50 },
			{ chatId: 'chat-1', limit: 100, purpose: 'activation' },
		]);
	});

	it.each(['reply', 'unknown'] as const)('captures a new Reload from an evicted pending draft (%s)', async outcome => {
		const { panels, chat } = fixture({ hydrated: true, maxHiddenEntries: 0 });
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await panels.loadChatSnapshot('chat-1');
		panels.reconcile([]);
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		expect(panels.panel('chat-view:window-main')!.transcript.transcriptViewId).toBe('generation-2');
		const reload = panels.captureNativeReload('chat-1');
		if (outcome === 'reply') reload.apply(emptyPage('generation-3'));
		else {
			vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-3'));
			await reload.recoverUnknown();
		}
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-3', stale: false });
	});

	it.each([0, 1, 2, 3, 4])('keeps a replacement fresh across automatic restore rejection delivery (%s microtasks)', async turns => {
		const { panels, chat } = fixture({ hydrated: true });
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValue(previous.promise);
		chat.transcriptCache.markStale('chat-1');
		panels.reconcile([]);
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		const loading = panels.loadChatSnapshot('chat-1').catch(() => false);
		previous.reject(new Error('Old restore failed'));
		for (let turn = 0; turn < turns; turn++) await Promise.resolve();
		const current = panels.panel('chat-view:window-main')!.transcript;
		current.setFromPage('chat-1', emptyPage('generation-2'), current.beginSnapshotLoad());
		await loading;
		await Promise.resolve();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
		expect(current.loadError).toBeNull();
	});

	it('retires fallback paging before its degraded response can discard a replacement', async () => {
		const { panels, chat } = fixture({ hydrated: true, maxHiddenEntries: 0 });
		const fallback = new ActiveTranscriptState(chat.transcriptCache);
		fallback.activateChat('chat-1');
		fallback.nextBeforeOrdinal = 2;
		fallback.hasEarlierMessages = true;
		const previous = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise);
		const paging = fallback.loadEarlierPage('chat-1');
		chat.setFromPage('chat-1', emptyPage('generation-2'), chat.beginSnapshotLoad());
		panels.reconcile([]);
		previous.resolve({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		expect(await paging).toBe('invalidated');
		expect(chat.transcriptCache.hydrate('chat-1')?.transcriptViewId).toBe('generation-2');
		fallback.activateChat(null);
	});

	it('keeps older capped transcript pages reachable after a correlated reload', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 4,
			pageOldestOrdinal: 3,
			pageNewestOrdinal: 4,
			nextBeforeOrdinal: 3,
			hasMore: true,
			messages: [
				{
					ordinal: 3,
					message: { type: 'assistant-message', timestamp: TS, content: 'three' },
				},
				{
					ordinal: 4,
					message: { type: 'assistant-message', timestamp: TS, content: 'four' },
				},
			],
		});
		vi.mocked(getChatMessages).mockResolvedValue({
			historyState: { kind: 'complete' },
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 4,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 2,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
			resendCandidates: [],
			messages: [
				{ ordinal: 1, message: new AssistantMessage(TS, 'one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'two') },
			],
		});
		const { chat, panels } = fixture();

		await expect(reloadChatFromNative(ws, panels, 'chat-1', options())).resolves.toBe('reloaded');

		expect(ws.sendProgressRequest).toHaveBeenCalledWith(
			{ type: 'chat-reload', chatId: 'chat-1' },
			expect.objectContaining({ type: 'chat-reload-progress', idleTimeoutMs: 30_000 }),
		);
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 4 });
		expect(chat.hasEarlierMessages).toBe(true);
		expect(chat.nextBeforeOrdinal).toBe(3);
		expect(chat.chatMessages[0]).toBeInstanceOf(AssistantMessage);
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'three',
			'four',
		]);
		expect(chat.transcriptCache.get('chat-1')).toMatchObject({
			lastOrdinal: 4,
			nextBeforeOrdinal: 3,
		});

		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');

		expect(getChatMessages).toHaveBeenCalledWith({
			chatId: 'chat-1',
			limit: 50,
			beforeOrdinal: 3,
			transcriptViewId: 'generation-2',
		});
		expect(chat.chatMessages.map((message) => (message as AssistantMessage).content)).toEqual([
			'one',
			'two',
			'three',
			'four',
		]);
		expect(chat.hasEarlierMessages).toBe(false);
	});

	it('rejects unexpected reload responses', async () => {
		const ws = wsWithResponse({
			type: 'chat-subscribed',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			mode: 'delta',
			messages: [],
			lastOrdinal: 0,
		});

		await expect(
			reloadChatFromNative(ws, fixture().panels, 'chat-1', options()),
		).rejects.toThrow(
			'Unexpected chat reload response',
		);
	});

	it.each(['same', 'replaced', 'unavailable'] as const)('refreshes only the ledger after an uncertain Reload (%s)', async outcome => {
		vi.mocked(getChatMessages).mockResolvedValue({
			chatId: 'chat-1', transcriptViewId: 'generation-1',
			lastOrdinal: 0, messages: [], pageOldestOrdinal: 0, pageNewestOrdinal: 0,
			nextBeforeOrdinal: null, hasMore: false, limit: 50, resendCandidates: [], historyState: { kind: 'complete' },
		});
		const { chat, panels } = fixture();
		await panels.loadChatSnapshot('chat-1');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'old-input',
			content: 'Previous input', createdAt: TS, delivery: 'pending', placement: 'live-tail' });
		panels.appendLocalNotice('chat-1', 'warning', 'Previous notice');
		vi.mocked(getChatMessages).mockClear();
		if (outcome === 'unavailable') vi.mocked(getChatMessages).mockRejectedValue(new Error('Offline'));
		else vi.mocked(getChatMessages).mockResolvedValue({
			chatId: 'chat-1', transcriptViewId: outcome === 'same' ? 'generation-1' : 'generation-2',
			lastOrdinal: 0, messages: [], pageOldestOrdinal: 0, pageNewestOrdinal: 0,
			nextBeforeOrdinal: null, hasMore: false, limit: 50, resendCandidates: [], historyState: { kind: 'complete' },
		});
		const ws = wsWithResponse(Promise.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Outcome unknown', false)));
		await expect(reloadChatFromNative(ws, panels, 'chat-1', options())).rejects.toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN' });
		expect(getChatMessages).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', limit: 50 });
		expect(ws.sendProgressRequest).toHaveBeenCalledTimes(1);
		expect(chat.transcriptViewId).toBe(outcome === 'replaced' ? 'generation-2' : 'generation-1');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(outcome === 'replaced' ? [] : ['Previous notice']);
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(outcome === 'replaced' ? [] : ['old-input']);
		if (outcome === 'unavailable') expect(chat.loadStatus).toBe('error');
	});

	it.each([undefined, 'activation'] as const)('invalidates a pre-promotion snapshot before uncertain recovery (purpose=%s)', async purpose => {
		const page: CompleteChatHistoryResponse = {
			chatId: 'chat-1', transcriptViewId: 'generation-1', lastOrdinal: 0,
			pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
			messages: [], historyState: { kind: 'complete' }, limit: 50, resendCandidates: [],
		};
		vi.mocked(getChatMessages).mockResolvedValue(page);
		const { chat, panels } = fixture();
		await panels.loadChatSnapshot('chat-1');
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		const fresh = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(previous.promise)
			.mockReturnValueOnce(fresh.promise);
		const loading = panels.loadChatSnapshot('chat-1', { purpose });
		const ws = wsWithResponse(Promise.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Outcome unknown', false)));
		const reloading = reloadChatFromNative(ws, panels, 'chat-1', options()).catch(error => error);
		await Promise.resolve();
		previous.resolve({ ...page, lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Stale pre-promotion row') }] });
		await vi.waitFor(() => expect(getChatMessages).toHaveBeenCalledTimes(2));
		expect(chat.entries).toEqual([]);
		expect(chat.transcriptCache.get('chat-1')?.lastOrdinal).toBe(0);
		fresh.resolve({ ...page, transcriptViewId: 'generation-2' });
		await loading;
		expect(await reloading).toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN' });
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(getChatMessages).toHaveBeenLastCalledWith({ chatId: 'chat-1', limit: 50 });
		expect(ws.sendProgressRequest).toHaveBeenCalledOnce();
	});

	it('preserves new overlays between an explicit replacement and its snapshot in duplicate panels', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels } = fixture({ duplicate: true });
		await panels.loadChatSnapshot('chat-1');
		panels.appendLocalNotice('chat-1', 'warning', 'Old notice');
		panels.handleViewReplacement('chat-1');
		const pending = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(pending.promise);
		const loading = panels.loadChatSnapshot('chat-1');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'New input', createdAt: TS, delivery: 'pending' });
		panels.appendServerNotice('chat-1', 'warning', 'New notice');
		pending.resolve(emptyPage('generation-2'));
		await loading;
		for (const panel of panels.panelsForChat('chat-1')) {
			expect(panel.transcript.transcriptViewId).toBe('generation-2');
			expect(panel.transcript.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
		}
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New notice']);
	});

	it.each(['generation-1', 'generation-2'])('remembers overlay ownership through a degraded read before %s', async viewId => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'old-input',
			content: 'Old input', createdAt: TS, delivery: 'pending' });
		panels.appendLocalNotice('chat-1', 'warning', 'Old notice');
		vi.mocked(getChatMessages).mockResolvedValueOnce({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		await panels.loadChatSnapshot('chat-1');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toBeNull();
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage(viewId));
		await panels.loadChatSnapshot('chat-1');
		expect(chat.transcriptViewId).toBe(viewId);
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(viewId === 'generation-1' ? ['old-input'] : []);
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(viewId === 'generation-1' ? ['Old notice'] : []);
	});

	it.each([false, true])('adopts hydrated overlay ownership before the first snapshot (degraded=%s)', async degraded => {
		const { panels, chat } = fixture({ hydrated: true, duplicate: true });
		expect(chat.transcriptViewId).toBe('generation-1');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'old-input',
			content: 'Old input', createdAt: TS, delivery: 'pending' });
		panels.appendLocalNotice('chat-1', 'warning', 'Old notice');
		if (degraded) {
			vi.mocked(getChatMessages).mockResolvedValueOnce({ chatId: 'chat-1', messages: [],
				historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
			await panels.loadChatSnapshot('chat-1');
			expect(chat.transcriptCache.readAppliedCursor('chat-1')).toBeNull();
		}
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await panels.loadChatSnapshot('chat-1');
		for (const panel of panels.panelsForChat('chat-1')) {
			expect(panel.transcript.transcriptViewId).toBe('generation-2');
			expect(panel.transcript.optimisticUserInputs).toEqual([]);
		}
		expect(panels.overlayFor('chat-1')?.notices).toEqual([]);
	});

	it('preserves overlays on the first snapshot without a previously accepted view', async () => {
		const first = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(first.promise);
		const { panels, chat } = fixture();
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'New input', createdAt: TS, delivery: 'pending' });
		panels.appendLocalNotice('chat-1', 'warning', 'New notice');
		first.resolve(emptyPage('generation-1'));
		await panels.loadChatSnapshot('chat-1');
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New notice']);
	});

	it('does not reset new overlays when the correlated reply overtakes the broadcast snapshot', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels } = fixture({ duplicate: true });
		await panels.loadChatSnapshot('chat-1');
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options());
		panels.handleViewReplacement('chat-1', 'generation-2');
		const pending = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(pending.promise);
		const loading = panels.loadChatSnapshot('chat-1');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'New input', createdAt: TS, delivery: 'pending' });
		panels.appendServerNotice('chat-1', 'warning', 'New notice');
		response.resolve({ ...emptyPage('generation-2'), type: 'chat-reloaded', clientRequestId: 'req-1' });
		await reloading;
		pending.resolve(emptyPage('generation-2'));
		await loading;
		for (const panel of panels.panelsForChat('chat-1')) {
			expect(panel.transcript.transcriptViewId).toBe('generation-2');
			expect(panel.transcript.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
		}
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New notice']);
	});

	it('does not stale a newer validated view after a delayed unknown Reload reply', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options()).catch(error => error);
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-3'));
		await panels.loadChatSnapshot('chat-1');
		vi.mocked(getChatMessages).mockClear().mockResolvedValue({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		response.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Outcome unknown', false));
		expect(await reloading).toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN' });
		expect(getChatMessages).not.toHaveBeenCalled();
		expect(chat.transcriptViewId).toBe('generation-3');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-3', stale: false });
	});

	it('retires the old snapshot operation instead of refreshing a newer accepted view', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture({ duplicate: true });
		await panels.loadChatSnapshot('chat-1');
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		const recovery = Promise.withResolvers<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(previous.promise).mockReturnValueOnce(recovery.promise)
			.mockResolvedValue({ chatId: 'chat-1', messages: [],
				historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		const loading = panels.loadChatSnapshot('chat-1');
		const ws = wsWithResponse(Promise.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Unknown', false)));
		const reloading = reloadChatFromNative(ws, panels, 'chat-1', options()).catch(error => error);
		await Promise.resolve();
		const peer = panels.panel('chat-view:window-peer')!.transcript;
		peer.setFromPage('chat-1', emptyPage('generation-2'), peer.beginSnapshotLoad());
		previous.resolve(emptyPage('generation-1'));
		await loading;
		recovery.resolve({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		await reloading;
		expect(getChatMessages).toHaveBeenCalledTimes(2);
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
	});

	it('ignores a rejected automatic restore after uncertain recovery validates a newer view', async () => {
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise).mockResolvedValue(emptyPage('generation-2'));
		const { panels, chat } = fixture({ hydrated: true });
		chat.transcriptCache.markStale('chat-1');
		panels.reconcile([]);
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		const restore = panels.loadChatSnapshot('chat-1');
		const settledRestore = restore.catch(error => error);
		await panels.captureNativeReload('chat-1').recoverUnknown();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
		previous.reject(new Error('Retired restore failed'));
		expect(await settledRestore).toBe(false);
		await Promise.resolve();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
		expect(panels.panel('chat-view:window-main')!.transcript.loadError).toBeNull();
	});

	it('fences an independent fallback read across replacement and memory eviction', async () => {
		const { panels, chat } = fixture({ hydrated: true, maxHiddenEntries: 0 });
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(previous.promise).mockResolvedValue({
			...emptyPage('generation-2'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'New row') }],
		});
		const loading = fallback.loadMessages('chat-1');
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		await panels.loadChatSnapshot('chat-1');
		panels.appendLocalNotice('chat-1', 'warning', 'New view notice');
		chat.transcriptCache.flush();
		panels.reconcile([]);
		expect(chat.transcriptCache.get('chat-1')).toBeNull();
		previous.resolve(emptyPage('generation-1'));
		await loading;
		chat.transcriptCache.flush();
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New view notice']);
		expect(chat.transcriptCache.listCursors()).toContainEqual({ chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1 });
		fallback.activateChat(null);
	});

	it('does not launch a queued activation after its predecessor is retired by Reload', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(previous.promise).mockResolvedValue({
			chatId: 'chat-1', messages: [], historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true },
		});
		const ordinary = panels.loadChatSnapshot('chat-1');
		const activation = panels.loadChatSnapshot('chat-1', { purpose: 'activation' });
		panels.captureNativeReload('chat-1').apply(emptyPage('generation-2'));
		previous.reject(new Error('Retired read failed'));
		expect(await ordinary).toBe(false);
		expect(await activation).toBe(false);
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
	});

	it.each(['fallback', 'live base'] as const)('ignores a rejected raw restore after %s accepts a replacement', async source => {
		const { panels, chat } = fixture({ hydrated: true });
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		const fresh = Promise.withResolvers<CompleteChatHistoryResponse>();
		const previous = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(fresh.promise).mockReturnValueOnce(previous.promise);
		const freshLoading = fallback.loadMessages('chat-1');
		panels.handleViewReplacement('chat-1', 'generation-2', 'generation-1');
		chat.transcriptCache.markStale('chat-1');
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		const restore = panels.loadChatSnapshot('chat-1').catch(error => error);
		if (source === 'fallback') {
			panels.captureNativeReload('chat-1').apply(emptyPage('generation-2'));
			fresh.resolve(emptyPage('generation-1'));
			await freshLoading;
		} else {
			chat.transcriptCache.remove('chat-1');
			panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 1, lastOrdinal: 1,
				messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'New row') }], resendCandidates: [], noticeRevision: 0 });
		}
		previous.reject(new Error('Obsolete raw restore failed'));
		expect(await restore).toBe(false);
		await Promise.resolve();
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-2', stale: false });
		if (source === 'live base') {
			fresh.resolve(emptyPage('generation-1'));
			await freshLoading;
		}
		fallback.activateChat(null);
	});

	it.each(['reply', 'unknown'] as const)('accepts Reload %s after an unmounted fallback validates a new view', async outcome => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		panels.reconcile([]);
		const fallback = new CurrentConversationPanelTranscript({ panels, getSelectedChatId: () => 'chat-1' });
		fallback.activateChat('chat-1');
		panels.appendLocalNotice('chat-1', 'warning', 'Old view notice');
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await fallback.loadMessages('chat-1');
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		expect(panels.overlayFor('chat-1')?.notices).toEqual([]);
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		const reload = panels.captureNativeReload('chat-1');
		if (outcome === 'reply') reload.apply(emptyPage('generation-3'));
		else {
			vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-3'));
			await reload.recoverUnknown();
		}
		expect(panels.panel('chat-view:window-main')!.transcript.transcriptViewId).toBe('generation-3');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({ transcriptViewId: 'generation-3', stale: false });
		fallback.activateChat(null);
	});

	it.each(['reply', 'unknown'] as const)('accepts Reload %s after live commits establish the replacement view', async outcome => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		expect(panels.resetForViewReplacement('chat-1', 'generation-1', 'generation-2')).toBe(true);
		panels.appendLocalNotice('chat-1', 'warning', 'Replacement notice');
		expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Replacement row') }], resendCandidates: [], noticeRevision: 0 }).kind).toBe('applied');
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['Replacement notice']);
		const reload = panels.captureNativeReload('chat-1');
		if (outcome === 'reply') reload.apply(emptyPage('generation-3'));
		else {
			vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-3'));
			await reload.recoverUnknown();
		}
		expect(chat.transcriptViewId).toBe('generation-3');
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-3');
	});

	it('captures retained ownership for Reload after a degraded read removes the cache and panel view', async () => {
		const { panels, chat } = fixture({ deferredSnapshot: true });
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Live row') }], resendCandidates: [], noticeRevision: 0 });
		panels.appendLocalNotice('chat-1', 'warning', 'Old notice');
		vi.mocked(getChatMessages).mockResolvedValueOnce({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		await chat.loadMessages('chat-1');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toBeNull();
		expect(chat.transcriptViewId).toBe('');
		panels.captureNativeReload('chat-1').apply(emptyPage('generation-2'));
		expect(chat.transcriptViewId).toBe('generation-2');
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		expect(panels.overlayFor('chat-1')?.notices).toEqual([]);
	});

	it('does not recreate a deleted chat from a late successful Reload reply', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture();
		await panels.loadChatSnapshot('chat-1');
		const reload = panels.captureNativeReload('chat-1');
		panels.removeChat('chat-1');
		reload.apply(emptyPage('generation-2'));
		expect(chat.transcriptCache.get('chat-1')).toBeNull();
		expect(panels.overlayFor('chat-1')).toBeNull();
	});

	it('keeps an announced replacement reset through stale old-view recovery', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture({ duplicate: true });
		await panels.loadChatSnapshot('chat-1');
		panels.handleViewReplacement('chat-1', 'generation-2');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'New input', createdAt: TS, delivery: 'pending' });
		panels.appendServerNotice('chat-1', 'warning', 'New notice');
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Old view row') }], resendCandidates: [], noticeRevision: 0 });
		expect(panels.resetForViewReplacement('chat-1', 'generation-1')).toBe(true);
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await panels.loadChatSnapshot('chat-1');
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New notice']);
	});

	it('records the first live cache base before a degraded snapshot loses its cursor', async () => {
		const { panels, chat } = fixture({ deferredSnapshot: true });
		panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-1', firstOrdinal: 1, lastOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Live row') }], resendCandidates: [], noticeRevision: 0 });
		panels.appendLocalNotice('chat-1', 'warning', 'Old notice');
		vi.mocked(getChatMessages).mockResolvedValueOnce({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		await chat.loadMessages('chat-1');
		expect(chat.transcriptCache.readAppliedCursor('chat-1')).toBeNull();
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await chat.loadMessages('chat-1');
		expect(panels.overlayFor('chat-1')?.notices).toEqual([]);
	});

	it('preserves a newer persisted view after eviction and a late unknown Reload reply', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture({ maxHiddenEntries: 0 });
		await panels.loadChatSnapshot('chat-1');
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options()).catch(error => error);
		vi.mocked(getChatMessages).mockResolvedValueOnce({ ...emptyPage('generation-2'), lastOrdinal: 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: 1, messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'New row') }] });
		await panels.loadChatSnapshot('chat-1');
		chat.transcriptCache.flush();
		panels.reconcile([]);
		expect(chat.transcriptCache.get('chat-1')).toBeNull();
		response.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Unknown', false));
		await reloading;
		expect(chat.transcriptCache.listCursors()).toContainEqual({ chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1 });
	});

	it('ignores a duplicate replacement broadcast after an offscreen Reload reply and cache eviction', async () => {
		vi.mocked(getChatMessages).mockResolvedValue(emptyPage('generation-1'));
		const { panels, chat } = fixture({ maxHiddenEntries: 1 });
		await panels.loadChatSnapshot('chat-1');
		const reload = panels.captureNativeReload('chat-1');
		panels.reconcile([]);
		reload.apply({ ...emptyPage('generation-2'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'New row') }] });
		panels.appendServerNotice('chat-1', 'warning', 'New view notice');
		chat.transcriptCache.flush();
		chat.transcriptCache.replace('other', 'other-view', [], 0, null);
		expect(chat.transcriptCache.get('chat-1')).toBeNull();
		panels.handleViewReplacement('chat-1', 'generation-2');
		expect(panels.overlayFor('chat-1')?.notices.map(notice => notice.content)).toEqual(['New view notice']);
		expect(chat.transcriptCache.listCursors()).toContainEqual({ chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1 });
	});

	it('restores the newer pending draft and fences the earlier Reload after remount', async () => {
		const { panels, chat } = fixture({ hydrated: true, maxHiddenEntries: 0 });
		const reload = panels.captureNativeReload('chat-1');
		vi.mocked(getChatMessages).mockResolvedValueOnce({ ...emptyPage('generation-2'), lastOrdinal: 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: 1, messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'New row') }] });
		await panels.loadChatSnapshot('chat-1');
		panels.reconcile([]);
		panels.reconcile([{ chatId: 'chat-1', surfaceId: 'chat-view:window-main', windowId: 'window-main',
			presentation: 'window-main', snapshotAdmission: 'admitted' }]);
		expect(chat.transcriptCache.readAppliedCursor('chat-1')?.transcriptViewId).toBe('generation-2');
		expect(chat.transcriptCache.acceptedView('chat-1')).toBe('generation-2');
		vi.mocked(getChatMessages).mockClear().mockResolvedValue({ chatId: 'chat-1', messages: [],
			historyState: { kind: 'degraded', errorCode: 'HISTORY_LOAD_FAILED', retryable: true } });
		await reload.recoverUnknown();
		expect(getChatMessages).not.toHaveBeenCalled();
		chat.transcriptCache.flush();
		panels.reconcile([]);
		expect(chat.transcriptCache.listCursors()).toContainEqual({ chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1 });
	});

	it.each([true, false])('invalidates sibling old-view navigation before accepting a replacement (combined=%s)', async combineMessages => {
		vi.mocked(getCombinedChatMessages).mockImplementation(async request => {
			const page = await getChatMessages({ chatId: request.chatId });
			if (isUnavailableChatHistoryResponse(page)) return page;
			return { chatId: page.chatId, transcriptViewId: page.transcriptViewId, historyState: page.historyState,
				direction: request.direction, watermarkOrdinal: page.lastOrdinal, lastOrdinal: page.lastOrdinal,
				startOrdinal: 1, endOrdinal: page.lastOrdinal + 1, anchorsRemaining: request.anchorsRemaining - page.messages.length,
				pageStatus: 'exhausted', messages: page.messages, resendCandidates: [] };
		});
		const initial = { ...emptyPage('generation-1'), lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Old row') }] };
		vi.mocked(getChatMessages).mockResolvedValue(initial);
		const { panels, chat } = fixture({ combineMessages, duplicate: true });
		await panels.loadChatSnapshot('chat-1');
		const peer = panels.panel('chat-view:window-peer')!.transcript;
		peer.hasLaterMessages = true;
		const old = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValueOnce(old.promise);
		const navigation = peer.navigateToWindow('chat-1', 'latest');
		vi.mocked(getChatMessages).mockResolvedValueOnce(emptyPage('generation-2'));
		await panels.loadChatSnapshot('chat-1');
		expect(peer.transcriptViewId).toBe('generation-2');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'New input', createdAt: TS, delivery: 'pending' });
		old.resolve(initial);
		expect(await navigation).toBe('invalidated');
		for (const transcript of [chat, peer]) {
			expect(transcript.transcriptViewId).toBe('generation-2');
			expect(transcript.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
		}
		expect(chat.transcriptCache.readAppliedCursor('chat-1')?.transcriptViewId).toBe('generation-2');
	});

	it.each(['replacement', 'deletion', 'offscreen'] as const)('fences uncertain Reload recovery after %s', async change => {
		const page: CompleteChatHistoryResponse = {
			chatId: 'chat-1', transcriptViewId: 'generation-1', lastOrdinal: 0,
			pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
			messages: [], historyState: { kind: 'complete' }, limit: 50, resendCandidates: [],
		};
		vi.mocked(getChatMessages).mockResolvedValue(page);
		const { chat, panels } = fixture();
		await panels.loadChatSnapshot('chat-1');
		const recovery = Promise.withResolvers<CompleteChatHistoryResponse>();
		vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(recovery.promise);
		if (change === 'offscreen') panels.reconcile([]);
		const ws = wsWithResponse(Promise.reject(new WsRequestError('RELOAD_OUTCOME_UNKNOWN', 'Outcome unknown', false)));
		const reloading = reloadChatFromNative(ws, panels, 'chat-1', options()).catch(error => error);
		await Promise.resolve();
		if (change === 'offscreen') {
			expect(getChatMessages).not.toHaveBeenCalled();
			expect(chat.transcriptCache.readAppliedCursor('chat-1')?.stale).toBe(true);
		} else {
			expect(getChatMessages).toHaveBeenCalledOnce();
			if (change === 'deletion') panels.removeChat('chat-1');
			else {
				panels.handleViewReplacement('chat-1');
				vi.mocked(getChatMessages).mockResolvedValueOnce({ ...page, transcriptViewId: 'generation-3' });
				await panels.loadChatSnapshot('chat-1');
			}
			recovery.resolve({ ...page, transcriptViewId: 'generation-2' });
		}
		expect(await reloading).toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN' });
		expect(ws.sendProgressRequest).toHaveBeenCalledOnce();
		if (change === 'deletion') expect(chat.transcriptCache.get('chat-1')).toBeNull();
		if (change === 'replacement') expect(chat.transcriptViewId).toBe('generation-3');
	});

	it.each(['generation-2', 'generation-3'])('preserves newer inputs when %s is installed before the reload reply', async viewId => {
		const { chat, panels } = fixture();
		seedTranscript(chat, 'chat-1', 'generation-1', [], {
			lastOrdinal: 0, pageOldestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false,
		});
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options());
		panels.handleViewReplacement('chat-1');
		expect(chat.setFromPage('chat-1', {
			transcriptViewId: viewId, messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'newer') }],
			lastOrdinal: 1, pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
		}, chat.beginSnapshotLoad())).toBe('applied');
		panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
			content: 'new guidance', createdAt: TS, delivery: 'pending', placement: 'live-tail' });
		response.resolve({ type: 'chat-reloaded', clientRequestId: 'req-1', chatId: 'chat-1', transcriptViewId: 'generation-2',
			lastOrdinal: 0, pageOldestOrdinal: 0, pageNewestOrdinal: 0, nextBeforeOrdinal: null, hasMore: false, messages: [] });
		await expect(reloading).resolves.toBe('reloaded');
		expect(chat.getCursor()).toEqual({ transcriptViewId: viewId, lastOrdinal: 1 });
		expect(chat.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
	});

	it.each(['snapshot-first', 'reply-first', 'snapshot-failure'] as const)(
		'preserves both panels and new guidance across an overlapping reload snapshot (%s)', async completion => {
			const page: CompleteChatHistoryResponse = {
				chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 1,
				pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
				messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Native history') }],
				historyState: { kind: 'complete' }, limit: 50, resendCandidates: [],
			};
			vi.mocked(getChatMessages).mockResolvedValue({ ...page, transcriptViewId: 'generation-1',
				messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Previous history') }] });
			const { chat, panels } = fixture();
			await panels.loadChatSnapshot('chat-1');
			panels.reconcile((['main', 'peer'] as const).map(id => ({ chatId: 'chat-1', surfaceId: `chat-view:window-${id}`,
				windowId: `window-${id}`, presentation: `window-${id}`, snapshotAdmission: 'admitted' } as const)));
			await panels.loadChatSnapshot('chat-1');
			const response = Promise.withResolvers<Record<string, unknown>>();
			const reloading = reloadChatFromNative(wsWithResponse(response.promise), panels, 'chat-1', options());
			const history = Promise.withResolvers<CompleteChatHistoryResponse>();
			vi.mocked(getChatMessages).mockClear().mockReturnValueOnce(history.promise);
			panels.handleViewReplacement('chat-1');
			const loading = panels.loadChatSnapshot('chat-1');
			expect(getChatMessages).toHaveBeenCalledOnce();
			const reply = { ...page, type: 'chat-reloaded', clientRequestId: 'req-1' };
			if (completion === 'snapshot-first') {
				history.resolve(page);
				await expect(loading).resolves.toBe(true);
			} else {
				response.resolve(reply);
				await expect(reloading).resolves.toBe('reloaded');
			}
			expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-2',
				messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'New live output') }],
				firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
			}).kind).toBe('applied');
			panels.upsertOptimisticInput('chat-1', { chatId: 'chat-1', clientMessageId: 'new-input',
				content: 'New guidance', createdAt: TS, delivery: 'pending', placement: 'live-tail' });

			if (completion === 'snapshot-first') {
				response.resolve(reply);
				await expect(reloading).resolves.toBe('reloaded');
			} else if (completion === 'snapshot-failure') {
				history.reject(new Error('Obsolete snapshot failed'));
				await expect(loading).resolves.toBe(false);
			} else {
				history.resolve(page);
				await expect(loading).resolves.toBe(false);
			}
			expect(panels.panelsForChat('chat-1')).toHaveLength(2);
			for (const panel of panels.panelsForChat('chat-1')) {
				expect(panel.transcript.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 2 });
				expect(panel.transcript.chatMessages).toEqual([
					expect.objectContaining({ content: 'Native history' }),
					expect.objectContaining({ content: 'New live output' }),
				]);
				expect(panel.transcript.optimisticUserInputs.map(input => input.clientMessageId)).toEqual(['new-input']);
				expect(panel.transcript.isLoadingMessages).toBe(false);
				expect(panel.transcript.loadError).toBeNull();
			}
			expect(chat.transcriptCache.readAppliedCursor('chat-1')).toMatchObject({
				transcriptViewId: 'generation-2', lastOrdinal: 2, stale: false,
			});
			expect(getChatMessages).toHaveBeenCalledOnce();
		},
	);

	it('keeps the current transcript when replacement page metadata is malformed', async () => {
		const ws = wsWithResponse({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 2,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 2,
			nextBeforeOrdinal: null,
			hasMore: false,
			messages: [
				{
					ordinal: 2,
					message: { type: 'assistant-message', timestamp: TS, content: 'replacement' },
				},
			],
		});
		const { chat, panels } = fixture();
		seedTranscript(chat, 'chat-1', 'generation-1', [
			{ ordinal: 1, message: new AssistantMessage(TS, 'current') },
		], {
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});

		await expect(reloadChatFromNative(ws, panels, 'chat-1', options())).rejects.toThrow(
			'Unexpected chat reload response',
		);
		expect(chat.transcriptViewId).toBe('generation-1');
		expect(chat.chatMessages).toEqual([
			expect.objectContaining({ type: 'assistant-message', content: 'current' }),
		]);
	});

	it('forwards only well-formed progress for the reloading chat', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const onProgress = vi.fn();
		const reloading = reloadChatFromNative(
			ws,
			fixture().panels,
			'chat-1',
			options({ onProgress }),
		);

		const progress = ws.progress();
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			phase: 'reading',
			rows: 1200,
		});
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-2',
			phase: 'saving',
			rows: 5,
		});
		progress.onProgress({
			type: 'chat-reload-progress',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			phase: 'unknown',
			rows: 5,
		});
		response.reject(new Error('stop'));

		await expect(reloading).rejects.toThrow('stop');
		expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'reading', rows: 1200 });
	});

	it('asks the server to cancel and reports a cancelled reload without an error', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const cancellation = new AbortController();
		const { chat, panels } = fixture();
		const reloading = reloadChatFromNative(
			ws,
			panels,
			'chat-1',
			options({ signal: cancellation.signal }),
		);

		cancellation.abort();
		expect(ws.sendMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: 'chat-reload-cancel',
				chatId: 'chat-1',
				reloadRequestId: 'req-1',
			}),
		);
		response.reject(new WsRequestError('REQUEST_CANCELLED', 'Reload cancelled', true));

		await expect(reloading).resolves.toBe('cancelled');
		expect(chat.transcriptViewId).toBe('');
	});

	it('applies a reload that completed despite a late cancellation', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const cancellation = new AbortController();
		const { chat, panels } = fixture();
		const reloading = reloadChatFromNative(
			ws,
			panels,
			'chat-1',
			options({ signal: cancellation.signal }),
		);

		cancellation.abort();
		response.resolve({
			type: 'chat-reloaded',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
			messages: [
				{ ordinal: 1, message: { type: 'assistant-message', timestamp: TS, content: 'native' } },
			],
		});

		await expect(reloading).resolves.toBe('reloaded');
		expect(chat.transcriptViewId).toBe('generation-2');
	});
});

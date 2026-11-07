import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import { ChatDisplayStateUpdatedMessage, emptyResponseClassOrdinals } from '$shared/transcript-display-events';
import { displayCutsKey, displayProfileKey, type GroupDescriptor } from '$shared/transcript-display-contract';
import { transcriptDisplayApi } from '$lib/api/transcript-display.js';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { DisplayBodyStore } from '../display-body-store.js';
import { ConversationTranscriptOverlayStore } from '../conversation-transcript-overlay-store.svelte.js';
import { diagnosticDigest } from '../local-notice.js';
import * as apiClient from '$lib/api/client.js';
import { displayCertificate, displayOpen, displayRow, displayWindow, DISPLAY_TIME, mockDisplayApi } from './display-fixtures.js';

const transcripts: ActiveTranscriptState[] = [];
afterEach(() => { for (const transcript of transcripts.splice(0)) transcript.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(count = 3) {
	const rows = Array.from({ length: count }, (_, index) => displayRow(index + 1));
	const open = displayOpen('chat-1', 'view-1', count);
	const api = mockDisplayApi(rows, open);
	const overlays = new ConversationTranscriptOverlayStore();
	const transcript = new ActiveTranscriptState(new DisplayBodyStore(), overlays.forChat('chat-1'));
	transcripts.push(transcript);
	transcript.activateChat('chat-1');
	return { rows, open, api, overlays, transcript };
}
const input = (id: string, content = id) => ({ chatId: 'chat-1', clientMessageId: id, content, createdAt: DISPLAY_TIME, delivery: 'pending' as const });

describe('ActiveTranscriptState display authority', () => {
	it('[TLV5-L09.03-WEB-UNIT-01] opens a certified display window and activates only the initial open', async () => {
		const { transcript, api } = setup(1000);
		await transcript.loadMessages('chat-1', { purpose: 'activation' });
		expect(api.open).toHaveBeenCalledWith({ chatId: 'chat-1', reason: 'activate', outstandingClientMessageIds: [] }, expect.any(AbortSignal));
		expect(api.window).toHaveBeenCalledTimes(1);
		expect(transcript.entries).toHaveLength(50);
		expect(transcript.entries[0].ordinal).toBe(951);
		expect(transcript.loadedThroughOrdinal).toBe(1000);
		expect(transcript.getCursor()).toEqual({ transcriptViewId: 'view-1', lastOrdinal: 1000 });
		expect(transcript.hasEarlierMessages).toBe(true);
		expect(transcript.bodyStore.count).toBe(50);
		await transcript.controller.refresh();
		await transcript.loadEarlierPage('chat-1');
		expect(api.open).toHaveBeenCalledOnce();
	});

	it('[TLV5-L09.03-WEB-BACKGROUND-01][TLV5-L09.03-WEB-PREVIEW-01] non-activating rendered loads never request native activation', async () => {
		const { transcript, api } = setup(100);
		await transcript.loadMessages('chat-1');
		await transcript.loadEarlierPage('chat-1');
		await transcript.controller.refresh();
		expect(api.open).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', reason: 'reconnect', outstandingClientMessageIds: [] }, expect.any(AbortSignal));
	});

	it('does not confuse a source head with presentation or body receipt', async () => {
		const { transcript, api } = setup();
		await transcript.loadMessages('chat-1');
		transcript.observeHead('view-1', 40000, { ...emptyResponseClassOrdinals(), tool: 40000 });
		expect(transcript.lastOrdinal).toBe(40000);
		expect(transcript.loadedThroughOrdinal).toBe(3);
		expect(transcript.entries).toHaveLength(3);
		expect(transcript.hasLaterMessages).toBe(false);
		expect(transcript.isDisplayBehindHead).toBe(true);
		expect(api.bodies).toHaveBeenCalledTimes(1);
		expect(transcript.responseClassOrdinals.tool).toBe(40000);
		transcript.observeHead('old-view', 50000);
		expect(transcript.lastOrdinal).toBe(40000);
	});

	it('uses the same display API for non-combined mode and hidden-empty views', async () => {
		const { transcript, api } = setup(0);
		transcript.configureDisplay({ combine: false, showThinking: false, hiddenToolGroups: ['bash'] });
		await transcript.loadMessages('chat-1');
		expect(api.window.mock.calls[0][0].profile).toMatchObject({ combine: false, hiddenToolGroups: ['bash'] });
		expect(transcript.loadStatus).toBe('empty');
		expect(transcript.hasEarlierMessages).toBe(false);
		expect(transcript.hasLaterMessages).toBe(false);
		expect(api.bodies).not.toHaveBeenCalled();
	});

	it('orders announced rows canonically rather than by detail hydration order', async () => {
		const { transcript } = setup();
		await transcript.loadMessages('chat-1');
		transcript.display = { ...transcript.display, details: new Map([...transcript.display.details].reverse()) };
		expect(transcript.visibleRows.flatMap(row => row.kind === 'message' ? [row.ordinal] : [])).toEqual([1, 2, 3]);
	});

	it('resets response watermarks when an open first reveals a replacement view', async () => {
		const { transcript } = setup();
		await transcript.loadMessages('chat-1');
		transcript.observeHead('view-1', 1000, { ...emptyResponseClassOrdinals(), tool: 1000 });
		transcript.installOpen(displayOpen('chat-1', 'view-2', 3));
		expect(transcript.responseClassOrdinals).toEqual(emptyResponseClassOrdinals());
		transcript.observeHead('view-2', 4, { ...emptyResponseClassOrdinals(), tool: 4 });
		expect(transcript.responseClassOrdinals.tool).toBe(4);
	});

	it('keeps the old certified window while preparation lags', async () => {
		const { transcript, api } = setup();
		await transcript.loadMessages('chat-1');
		const prior = transcript.display.window;
		api.window.mockImplementationOnce(async request => ({ kind: 'lagging', serverInstanceId: 'instance-1', chatId: 'chat-1',
			transcriptViewId: 'view-1', policyRevision: 1, profileKey: displayProfileKey(request.profile), bashRevision: 'patterns',
			sourceHead: 20, preparedThrough: 3, errorCode: null, retryAfterMs: 1000 }));
		transcript.observeHead('view-1', 20);
		await transcript.controller.refresh();
		expect(transcript.display.window).toBe(prior);
		expect(transcript.display.phase).toBe('lagging');
		expect(transcript.entries).toHaveLength(3);
	});

	it.each(['earlier', 'later'] as const)('[TLV5-PAGE.06-WEB-UNIT-01] preserves a failed %s page until its directional retry succeeds', async direction => {
		vi.useFakeTimers();
		const { transcript, api } = setup(100);
		await transcript.loadMessages('chat-1');
		if (direction === 'later') await transcript.navigateToWindow('chat-1', 'initial');
		const load = () => direction === 'earlier' ? transcript.loadEarlierPage('chat-1') : transcript.loadLaterPage('chat-1');
		const before = api.window.mock.calls.length;
		api.window.mockRejectedValueOnce(new Error('read failed'));
		expect(await load()).toBe('failed');
		expect(transcript.pageStates[direction]).toEqual({ status: 'error', error: 'read failed' });
		expect(transcript.entries).toHaveLength(50);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.window).toHaveBeenCalledTimes(before + 1);
		const read = api.window.getMockImplementation()!;
		const held = Promise.withResolvers<void>();
		api.window.mockImplementationOnce(async (...args) => { await held.promise; return read(...args); });
		const retry = load();
		expect(transcript.pageStates[direction]).toEqual({ status: 'loading', error: 'read failed' });
		expect(transcript.loadError).toBe('read failed');
		expect(api.window.mock.calls.at(-1)![0].anchor.kind).toBe(direction === 'earlier' ? 'before' : 'after');
		held.resolve();
		expect(await retry).toBe('loaded');
		expect(transcript.pageStates[direction]).toEqual({ status: 'idle', error: null });
		expect(transcript.loadError).toBeNull();
	});

	it.each(['earlier', 'later'] as const)('classifies a %s profile-refresh redirect synchronously and respects its gate', async direction => {
		const { transcript } = setup(100);
		await transcript.loadMessages('chat-1');
		transcript.configureDisplay({ combine: false, showThinking: false, hiddenToolGroups: [] });
		const revision = transcript.feedMutationClock.dataRevision;
		const held = Promise.withResolvers<'apply'>(), entered = Promise.withResolvers<void>();
		const gate = () => { entered.resolve(); return held.promise; };
		const load = direction === 'earlier' ? transcript.loadEarlierPage('chat-1', { applicationGate: gate }) : transcript.loadLaterPage('chat-1', { applicationGate: gate });
		const received = await Promise.race([entered.promise.then(() => 'gated'), load.then(() => 'ungated')]);
		expect(received).toBe('gated');
		expect(transcript.feedMutationClock.dataRevision).toBe(revision);
		held.resolve('apply');
		expect(await load).toBe('loaded');
		expect(transcript.feedMutationClock.lastRevisionByKind[direction === 'earlier' ? 'history-earlier' : 'history-later']).toBeGreaterThan(revision);
	});

	it('does not assign member failure or recovery to a parent history edge', async () => {
		const { transcript, api, open } = setup(200);
		const group: GroupDescriptor = { kind: 'tool-group', firstMember: 1, lastMember: 200, count: 200,
			base: { afterBreaker: 0, beforeBreaker: 201, firstMember: 1, lastMember: 200, openAtWatermark: false },
			fragment: { after: 0, through: 200 }, totals: { commands: 200, fileReads: 0, fileEdits: 0, other: 0 }, categoryOrder: ['commands'] };
		api.window.mockResolvedValue(displayWindow([group], displayCertificate(open)));
		const members = vi.spyOn(transcriptDisplayApi, 'members').mockImplementation(async request => ({ certificate: request.certificate,
			base: request.base, fragment: request.fragment, ordinals: [101], earlier: { beforeOrdinal: 101, remaining: 100 }, later: null }));
		await transcript.loadMessages('chat-1');
		members.mockRejectedValueOnce(new Error('Member read failed'));
		const memberTarget = { group, anchor: { kind: 'after' as const, ordinal: 100 } };
		expect(await transcript.loadLaterPage('chat-1', { memberTarget })).toBe('failed');
		expect(transcript.pageStates.later).toEqual({ status: 'idle', error: null });
		expect(transcript.loadError).toBe('Member read failed');
		transcript.pageStates.later = { status: 'error', error: 'Parent read failed' };
		expect(await transcript.loadLaterPage('chat-1', { memberTarget })).toBe('loaded');
		expect(transcript.pageStates.later).toEqual({ status: 'error', error: 'Parent read failed' });
		expect(transcript.loadError).toBeNull();
	});

	it.each((['initial', 'latest'] as const).flatMap(target =>
		(['readiness', 'fallback', 'cancel'] as const).map(wake => ({ target, wake }))))('keeps $target navigation pending until $wake', async ({ target, wake }) => {
		vi.useFakeTimers();
		const { transcript, api } = setup(200);
		await transcript.loadMessages('chat-1');
		transcript.controller.setReadingAnchor(100, false);
		api.window.mockImplementationOnce(async request => ({ kind: 'lagging', serverInstanceId: 'instance-1', chatId: 'chat-1',
			transcriptViewId: 'view-1', policyRevision: 1, profileKey: displayProfileKey(request.profile),
			bashRevision: request.profile.bashRevision, sourceHead: 200, preparedThrough: 0, retryAfterMs: 1500, errorCode: null }));
		let settled = false;
		const navigation = transcript.navigateToWindow('chat-1', target).then(result => { settled = true; return result; });
		await vi.advanceTimersByTimeAsync(10);
		expect(settled).toBe(false);
		expect(transcript.controller.busy).toBe(true);
		if (target === 'initial') expect(api.window.mock.calls.at(-1)![0].requiredThrough).toBe(1);
		if (wake === 'cancel') transcript.invalidatePendingWindowNavigation();
		else if (wake === 'readiness') transcript.controller.ready();
		await vi.advanceTimersByTimeAsync(wake === 'fallback' ? 1500 : 1);
		expect(await navigation).toBe(wake === 'cancel' ? 'invalidated' : 'loaded');
		if (wake !== 'cancel') expect(transcript.entries[target === 'initial' ? 0 : transcript.entries.length - 1].ordinal).toBe(target === 'initial' ? 1 : 200);
	});

	it.each(['initial', 'latest'] as const)('supersedes held paging when navigating to %s', async target => {
		const { transcript, api } = setup(200);
		await transcript.loadMessages('chat-1');
		const read = api.window.getMockImplementation()!;
		const held = Promise.withResolvers<void>();
		api.window.mockImplementationOnce(async (...args) => { await held.promise; return read(...args); });
		const paging = transcript.loadEarlierPage('chat-1');
		expect(transcript.pageStates.earlier.status).toBe('loading');
		expect(await transcript.navigateToWindow('chat-1', target)).toBe('loaded');
		expect(api.window.mock.calls.at(-1)?.[0].anchor).toEqual(target === 'initial' ? { kind: 'around', ordinal: 1 } : { kind: 'newest' });
		expect(transcript.pageStates.earlier.status).toBe('idle');
		const window = transcript.display.window;
		held.resolve();
		expect(await paging).toBe('invalidated');
		expect(transcript.display.window).toBe(window);
		expect(transcript.isLoadingMessages).toBe(false);
	});

	it('supersedes a held initial navigation with latest without retaining its anchor', async () => {
		const { transcript, api } = setup(200);
		await transcript.loadMessages('chat-1');
		const read = api.window.getMockImplementation()!;
		const held = Promise.withResolvers<void>();
		api.window.mockImplementationOnce(async (...args) => { await held.promise; return read(...args); });
		const initial = transcript.navigateToWindow('chat-1', 'initial');
		try {
			expect(await transcript.navigateToWindow('chat-1', 'latest')).toBe('loaded');
			expect(api.window.mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'newest' });
			expect(transcript.entries.at(-1)?.ordinal).toBe(200);
		} finally { held.resolve(); }
		expect(await initial).toBe('invalidated');
		expect(transcript.entries.at(-1)?.ordinal).toBe(200);
	});

	it('fences a held old page status across view replacement and new paging', async () => {
		const { transcript, api, rows } = setup(100);
		await transcript.loadMessages('chat-1');
		const read = api.window.getMockImplementation()!;
		const old = Promise.withResolvers<void>(), next = Promise.withResolvers<void>();
		api.window.mockImplementationOnce(async (...args) => { await old.promise; return read(...args); });
		const oldPage = transcript.loadEarlierPage('chat-1');
		const replacement = displayOpen('chat-1', 'view-2', 100);
		api.replace(rows, replacement);
		transcript.installOpen(replacement);
		await transcript.controller.refresh();
		expect(transcript.pageStates.earlier.status).toBe('idle');
		api.window.mockImplementationOnce(async (...args) => { await next.promise; return read(...args); });
		const nextPage = transcript.loadEarlierPage('chat-1');
		old.resolve();
		expect(await oldPage).toBe('invalidated');
		expect(transcript.pageStates.earlier.status).toBe('loading');
		next.resolve();
		expect(await nextPage).toBe('loaded');
		expect(transcript.pageStates.earlier.status).toBe('idle');
	});

	it('[TLV5-UX.03-WEB-UNIT-01] keeps both edges when paging a detached certified interval', async () => {
		const { transcript } = setup(150);
		await transcript.loadMessages('chat-1');
		transcript.isUserScrolledUp = true;
		expect(await transcript.loadEarlierPage('chat-1')).toBe('loaded');
		expect(transcript.entries).toHaveLength(100);
		expect(transcript.entries.at(-1)?.ordinal).toBe(150);
		expect(transcript.isUserScrolledUp).toBe(true);
		expect(await transcript.loadEarlierPage('chat-1')).toBe('loaded');
		expect(transcript.entries[0].ordinal).toBe(1);
		expect(transcript.hasEarlierMessages).toBe(false);
	});

	it('[TLV5-UX.01-WEB-UNIT-01] maintains ascending unique certified rows through bidirectional paging', async () => {
		const { transcript } = setup(300);
		await transcript.loadMessages('chat-1');
		await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 150 }, new AbortController().signal, () => true);
		for (let index = 0; index < 2; index++) {
			expect(await transcript.loadEarlierPage('chat-1')).toBe('loaded');
			expect(await transcript.loadLaterPage('chat-1')).toBe('loaded');
			const ordinals = transcript.entries.map(entry => entry.ordinal);
			expect(ordinals).toEqual([...new Set(ordinals)].sort((a, b) => a - b));
			expect(transcript.loadedThroughOrdinal).toBe(300);
		}
		expect(transcript.entries.map(entry => entry.ordinal)).toEqual(Array.from({ length: 250 }, (_, index) => index + 25));
	});

	it('[TLV5-UX.17-WEB-UNIT-04] cold return releases expanded history and loads a bounded certified tail', async () => {
		const { transcript } = setup(200);
		await transcript.loadMessages('chat-1');
		await transcript.loadEarlierPage('chat-1');
		expect(transcript.entries).toHaveLength(100);
		transcript.activateChat('chat-2');
		expect(transcript.bodyStore.count).toBe(0);
		transcript.activateChat('chat-1');
		await transcript.loadMessages('chat-1');
		expect(transcript.entries.map(entry => entry.ordinal)).toEqual(Array.from({ length: 50 }, (_, index) => index + 151));
		expect(transcript.hasEarlierMessages).toBe(true);
	});

	it.each(['descending', 'duplicate', 'overlap', 'foreign-view', 'future-ordinal'] as const)(
		'[TLV5-PAGE.03-WEB-UNIT-01] rejects a %s display page before mutating the surface', async defect => {
		const { transcript, api } = setup(100);
		await transcript.loadMessages('chat-1');
		const prior = transcript.display.window!;
		const row = prior.items[0];
		const earlier = { ...prior, items: [{ ...row, ordinal: 49 }, { ...row, ordinal: 50 }],
			interval: { after: 0, through: 50 }, earlier: { kind: 'exhausted-through-watermark' },
			later: { kind: 'more', cursor: { certificate: prior.certificate, boundaryOrdinal: 50 } } };
		if (defect === 'descending') earlier.items.reverse();
		if (defect === 'duplicate') earlier.items[1].ordinal = 49;
		if (defect === 'overlap') { earlier.items[1].ordinal = 51; earlier.interval.through = 51; }
		if (defect === 'foreign-view') earlier.certificate = { ...earlier.certificate, transcriptViewId: 'foreign' };
		if (defect === 'future-ordinal') earlier.items[1].ordinal = 101;
		api.window.mockRestore();
		vi.spyOn(apiClient, 'apiPost').mockResolvedValue(earlier);
		expect(await transcript.loadEarlierPage('chat-1')).toBe('failed');
		expect(transcript.display.window).toBe(prior);
		expect(transcript.entries).toHaveLength(50);
	});

	it.each(['earlier', 'later'] as const)('stages a %s page until native-scroll settlement', async direction => {
		const { transcript, api } = setup(100);
		await transcript.loadMessages('chat-1');
		if (direction === 'later') await transcript.navigateToWindow('chat-1', 'initial');
		api.bodies.mockClear();
		const gate = Promise.withResolvers<'apply'>();
		const options = { applicationGate: () => gate.promise };
		const loading = direction === 'earlier' ? transcript.loadEarlierPage('chat-1', options) : transcript.loadLaterPage('chat-1', options);
		await vi.waitFor(() => expect(api.bodies).toHaveBeenCalledTimes(2));
		expect(transcript.entries).toHaveLength(50);
		gate.resolve('apply');
		expect(await loading).toBe('loaded');
		expect(transcript.entries).toHaveLength(100);
	});

	it('drops an obsolete page after chat identity changes', async () => {
		const { transcript, api } = setup(100);
		await transcript.loadMessages('chat-1');
		const held = Promise.withResolvers<Awaited<ReturnType<typeof api.window>>>();
		api.window.mockImplementationOnce(() => held.promise);
		const loading = transcript.loadEarlierPage('chat-1');
		const old = transcript.display.window!;
		transcript.activateChat('chat-2');
		held.resolve(old);
		expect(await loading).toBe('invalidated');
		expect(transcript.activeChatId).toBe('chat-2');
		expect(transcript.entries).toEqual([]);
		expect(transcript.bodyStore.count).toBe(0);
	});

	it.each(['success', 'failure'] as const)('ignores late activation %s after rapid chat switching', async outcome => {
		const { transcript, api, open } = setup();
		const held = Promise.withResolvers<typeof open>();
		api.open.mockImplementationOnce(() => held.promise);
		const loading = transcript.loadMessages('chat-1');
		transcript.activateChat('chat-2');
		if (outcome === 'success') held.resolve(open);
		else held.reject(new Error('Synthetic stale open failure'));
		expect(await loading).toEqual([]);
		expect(transcript.openSnapshot).toBeNull();
		expect(transcript.isLoadingMessages).toBe(false);
		expect(transcript.loadError).toBeNull();
		expect(api.window).not.toHaveBeenCalled();
	});

	it('rejects stale-view navigation without loading another window', async () => {
		const { transcript, api } = setup();
		await transcript.loadMessages('chat-1');
		expect(await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'old', ordinal: 1 }, new AbortController().signal, () => true)).toBe('view-changed');
		expect(api.resolve).not.toHaveBeenCalled();
	});

	it('resolves a canonical target instead of requesting a raw prefix', async () => {
		const { transcript, api } = setup(1000);
		await transcript.loadMessages('chat-1');
	expect(await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 500 }, new AbortController().signal, () => true)).toEqual({ kind: 'loaded', landedOrdinal: 500, revealDetail: false, targetMatched: true });
		expect(api.resolve.mock.calls[0][0].ordinal).toBe(500);
		expect(transcript.entries.some(row => row.ordinal === 500)).toBe(true);
		expect(transcript.entries).toHaveLength(50);
		expect(transcript.isUserScrolledUp).toBe(true);
	});

	it('defers permission cut changes until navigation has resolved', async () => {
		const { transcript, api } = setup(1000);
		await transcript.loadMessages('chat-1');
		const held = Promise.withResolvers<Awaited<ReturnType<typeof api.resolve>>>();
		api.resolve.mockReturnValueOnce(held.promise);
		const navigating = transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 500 }, new AbortController().signal, () => true);
		await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledOnce());
		transcript.configureDisplay({ combine: true, showThinking: true, hiddenToolGroups: [] }, [
			{ id: 'permission:p1', afterOrdinal: 499, anchorRule: 'eligible-row' },
		]);
		held.resolve({ kind: 'visible-row', ordinal: 500, landedOrdinal: 500 });
		expect(await navigating).toMatchObject({ kind: 'loaded', landedOrdinal: 500 });
		expect(transcript.controller.cuts).toEqual([{ id: 'permission:p1', afterOrdinal: 499, anchorRule: 'eligible-row' }]);
	});

	it('[TLV5-L02.03-WEB-UNIT-01] keeps repeated equal bodies as distinct canonical occurrences', async () => {
		const { transcript, api, open } = setup();
		api.replace([displayRow(1, new AssistantMessage(DISPLAY_TIME, 'same')), displayRow(2, new AssistantMessage(DISPLAY_TIME, 'same'))], { ...open, sourceHead: 2 });
		await transcript.loadMessages('chat-1');
		expect(transcript.renderModel.items.map(row => row.id)).toEqual(['view-1:1', 'view-1:2']);
	});

	it('captures fork identity from the selected source-owned body', async () => {
		const { transcript, api, open } = setup(1);
		api.replace([displayRow(1, new UserMessage(DISPLAY_TIME, 'prompt', undefined, { clientMessageId: 'input-1' }))], open);
		await transcript.loadMessages('chat-1');
		expect(transcript.forkSelection(1)).toEqual({ ordinal: 1, transcriptViewId: 'view-1', clientMessageId: 'input-1' });
		expect(transcript.forkSelection(999)).toBeNull();
	});

	it('releases all body leases on teardown', async () => {
		const { transcript } = setup();
		await transcript.loadMessages('chat-1');
		transcript.dispose();
		expect(transcript.bodyStore.count).toBe(0);
		expect(transcript.display.window).toBeNull();
	});
});

describe('surface-local overlays', () => {
	it('marks optimistic rows awaiting delivery only until the input is delivered', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		overlays.upsertOptimisticInput('chat-1', input('pending'), 3);
		expect(transcript.overlayRows).toContainEqual(expect.objectContaining({ id: 'optimistic:pending', awaitingDelivery: true }));
		overlays.markOptimisticInputDelivered('chat-1', 'pending');
		expect(transcript.overlayRows).toContainEqual(expect.objectContaining({ id: 'optimistic:pending', awaitingDelivery: false }));
	});
	it('keeps the latest Bash revision across notice and optimistic cut changes', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		transcript.displayReady(new ChatDisplayStateUpdatedMessage('instance-1', 'chat-1', 'view-1', 1, 'new-patterns', 3, 'available', null));
		overlays.appendLocalNotice('chat-1', 'info', 'Synthetic notice');
		transcript.applySharedOverlayMutation({ feedStructureChanged: true });
		expect(transcript.controller.profile?.bashRevision).toBe('new-patterns');
		overlays.upsertOptimisticInput('chat-1', input('new-input'), 3);
		transcript.applySharedOverlayMutation({ feedStructureChanged: true });
		expect(transcript.controller.profile?.bashRevision).toBe('new-patterns');
		expect(transcript.readinessRevision).toBe(1);
	});
	it('keeps a committed input through preparation and removes it only with its canonical replacement', async () => {
		const { transcript, api, overlays, open, rows } = setup();
		await transcript.loadMessages('chat-1');
		const optimistic = input('input-1');
		overlays.upsertOptimisticInput('chat-1', optimistic, 3);
		transcript.acknowledgeInput('view-1', optimistic, 4, 3);
		overlays.acknowledgeInput('chat-1', optimistic.clientMessageId, 4);
		expect(transcript.visibleOptimisticInputs).toHaveLength(1);
		expect(transcript.visibleOptimisticInputs[0].delivery).toBe('delivered');
		expect(transcript.controller.cuts).toEqual([{ id: 'optimistic:input-1', afterOrdinal: 3, anchorRule: 'raw-position' }]);
		api.replace([...rows, displayRow(4, new UserMessage(DISPLAY_TIME, optimistic.content, undefined, { clientMessageId: 'input-1' }))], { ...open, sourceHead: 4 });
		transcript.observeHead('view-1', 4);
		await transcript.controller.refresh();
		expect(transcript.visibleOptimisticInputs).toEqual([]);
		expect(transcript.entries.filter(row => row.message.type === 'user-message')).toHaveLength(1);
	});

	it('finishes navigation before removing the cut for an input represented by that navigation', async () => {
		vi.useFakeTimers();
		const { transcript, api, overlays, open, rows } = setup(100);
		await transcript.loadMessages('chat-1');
		await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 10 }, new AbortController().signal, () => true);
		const optimistic = input('input-1');
		overlays.upsertOptimisticInput('chat-1', optimistic, 100);
		transcript.acknowledgeInput('view-1', optimistic, 101, 100);
		overlays.acknowledgeInput('chat-1', optimistic.clientMessageId, 101);
		api.replace([...rows, displayRow(101, new UserMessage(DISPLAY_TIME, optimistic.content, undefined, { clientMessageId: 'input-1' }))], { ...open, sourceHead: 101 });
		transcript.observeHead('view-1', 101);
		api.resolve.mockClear();
		expect(await transcript.navigateToRow({ chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 101 }, new AbortController().signal, () => true))
			.toEqual({ kind: 'loaded', landedOrdinal: 101, revealDetail: false, targetMatched: true });
		expect(api.resolve).toHaveBeenCalledOnce();
		expect(transcript.visibleOptimisticInputs).toEqual([]);
		expect(transcript.controller.cuts).toEqual([]);
		await vi.advanceTimersByTimeAsync(300);
		expect(api.window.mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'around', ordinal: 101 });
		expect(transcript.entries.some(row => row.ordinal === 101)).toBe(true);
	});

	it('retains submission order and declared ordinal cuts despite timestamp skew', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		overlays.upsertOptimisticInput('chat-1', { ...input('first'), createdAt: '2030-01-01T00:00:00.000Z' }, 3);
		overlays.upsertOptimisticInput('chat-1', { ...input('second'), createdAt: '2020-01-01T00:00:00.000Z' }, 4);
		transcript.applySharedOverlayMutation({ feedStructureChanged: true });
		expect(transcript.visibleOptimisticInputs.map(row => row.clientMessageId)).toEqual(['first', 'second']);
		expect(transcript.controller.cuts.map(cut => cut.afterOrdinal)).toEqual([3, 4]);
	});

	it('keeps shared anchor advancement when a later acknowledgement arrives first', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		overlays.upsertOptimisticInput('chat-1', input('first'), 3);
		overlays.upsertOptimisticInput('chat-1', input('second'), 3);
		transcript.acknowledgeInput('view-1', input('second'), 5, 3);
		overlays.advanceOptimisticAnchors('chat-1', 'first', 4);
		transcript.applySharedOverlayMutation({ feedStructureChanged: true });
		expect(transcript.optimisticAfterOrdinals.get('second')).toBe(4);
		expect(transcript.controller.cuts.find(cut => cut.id === 'optimistic:second')?.afterOrdinal).toBe(4);
	});

	it('retains all controls and reports cut-budget overflow instead of dropping inputs', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		for (let index = 0; index < 33; index++) overlays.upsertOptimisticInput('chat-1', input(`input-${index}`), 3);
		transcript.applySharedOverlayMutation({ feedStructureChanged: true });
		expect(transcript.controller.cuts).toHaveLength(33);
		expect(transcript.visibleOptimisticInputs).toHaveLength(33);
		expect(transcript.display.phase).toBe('failed');
	});

	it('deduplicates only one exact diagnostic after its terminal watermark is certified', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		const digest = await diagnosticDigest('Synthetic failure');
		overlays.appendServerNotice('chat-1', 'error', 'Synthetic failure', { serverInstanceId: 'instance-1', transcriptViewId: 'view-1', ordinal: 5 });
		await vi.waitFor(() => expect(overlays.forChat('chat-1').notices[0].contentDigest).toBe(digest));
		const prior = transcript.display.window!;
		transcript.display = { ...transcript.display, window: { ...prior, publicTail: { ordinal: 3, contentDigest: digest, combinedDigest: null } } };
		expect(transcript.localNotices).toHaveLength(1);
		transcript.display = { ...transcript.display, window: { ...transcript.display.window!, certificate: { ...prior.certificate, watermark: 5 } } };
		expect(transcript.localNotices).toHaveLength(0);
		flushSync();
		transcript.display = { ...transcript.display, window: { ...transcript.display.window!, publicTail: { ordinal: 6, contentDigest: null, combinedDigest: null } } };
		expect(transcript.localNotices).toHaveLength(0);
	});

	it('does not use old-instance or old-view tail evidence to hide the only error', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		overlays.appendServerNotice('chat-1', 'error', 'Synthetic failure', { serverInstanceId: 'old-instance', transcriptViewId: 'view-1', ordinal: 1 });
		await vi.waitFor(() => expect(overlays.forChat('chat-1').notices[0].contentDigest).toBeDefined());
		const digest = await diagnosticDigest('Synthetic failure');
		transcript.display = { ...transcript.display, window: { ...transcript.display.window!, publicTail: { ordinal: 3, contentDigest: digest, combinedDigest: null } } };
		expect(transcript.localNotices).toHaveLength(1);
	});

	it('keeps local notices display-only and never puts them in source cursor or body storage', async () => {
		const { transcript, overlays } = setup();
		await transcript.loadMessages('chat-1');
		overlays.appendLocalNotice('chat-1', 'info', 'Local notice');
		expect(transcript.localNotices).toHaveLength(1);
		expect(transcript.getCursor().lastOrdinal).toBe(3);
		expect(transcript.entries).toHaveLength(3);
		expect(transcript.bodyStore.count).toBe(3);
		expect(transcript.controller.cuts).toEqual([]);
		expect(transcript.display.window?.certificate.cutsKey).toBe(displayCutsKey([]));
	});
});

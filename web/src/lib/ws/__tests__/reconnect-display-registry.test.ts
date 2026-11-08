import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { ConversationPanelRegistry } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { DisplayBodyStore } from '$lib/chat/transcript/display-body-store.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { displayOpen, displayRow, DISPLAY_TIME, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { ChatReconnectCoordinator, type ChatReconnectCoordinatorOptions, type ReconnectWsPort } from '../reconnect-coordinator.svelte.js';
import ReconnectCoordinatorTestHost from './ReconnectCoordinatorTestHost.svelte';

const registries: ConversationPanelRegistry[] = [];
afterEach(() => { cleanup(); registries.splice(0).forEach(registry => registry.destroy()); vi.restoreAllMocks(); });

function fixture() {
	const api = mockDisplayApi([displayRow(1)]);
	const lifecycle = new ConversationLifecycleState();
	lifecycle.setCurrentChatId('chat-1');
	const registry = new ConversationPanelRegistry({
		bodies: new DisplayBodyStore(), overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => lifecycle, remove: () => {} },
		getComposerAnchorSurfaceId: () => 'chat-view:window-left', getSelectedChatId: () => 'chat-1',
	});
	registries.push(registry);
	const ws = {
		isConnected: true,
		sendRequest: vi.fn<ReconnectWsPort['sendRequest']>().mockRejectedValue(new Error('Synthetic reconnect-state timeout')),
		addMessageConsumer: vi.fn<ReconnectWsPort['addMessageConsumer']>(() => () => {}),
	} satisfies ReconnectWsPort;
	const options = {
		ws, panels: registry, conversationUi: new ConversationUiState(),
		sessions: { selectedChatId: 'chat-1', quietRefreshChats: async () => {} },
		getExecutionControl: async () => ({ control: displayOpen().control }),
	} satisfies ChatReconnectCoordinatorOptions;
	registry.reconcile([{ surfaceId: 'chat-view:window-left', chatId: 'chat-1', windowId: 'window-left',
		presentation: 'window-left', snapshotAdmission: 'admitted' }]);
	return { api, registry, ws, options, panel: registry.panel('chat-view:window-left')! };
}

it('reopens after a new-instance pong cancels a held fallback open, without another reconnect', async () => {
	const f = fixture();
	await f.registry.loadChatSnapshot('chat-1');
	const held = Promise.withResolvers<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(held.promise);
	render(ReconnectCoordinatorTestHost, { options: f.options });
	try {
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
		f.api.replace([displayRow(1), displayRow(2)], displayOpen('chat-1', 'view-1', 2, 'instance-2'));
		const consumer = f.ws.addMessageConsumer.mock.calls[0][0];
		consumer({ type: 'ws-pong', clientRequestId: 'synthetic-ping', serverInstanceId: 'instance-2',
			sentAt: 1, serverTime: DISPLAY_TIME, processing: { outcome: 'snapshot', chats: [] } }, {});
		expect(f.api.open.mock.calls[1][1]?.aborted).toBe(true);
		await vi.waitFor(() => expect(f.panel.transcript.loadedThroughOrdinal).toBe(2));
		expect(f.panel.transcript.serverInstanceId).toBe('instance-2');
		expect(f.api.open).toHaveBeenCalledTimes(3);
	} finally { held.resolve(displayOpen('chat-1', 'view-1', 1)); }
});

it('keeps an independent cold HTTP open alive when the socket disconnects', async () => {
	const f = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(held.promise);
	const loading = f.registry.loadChatSnapshot('chat-1');
	const coordinator = new ChatReconnectCoordinator(f.options);
	try {
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
		await coordinator.handleConnectionState(false);
		expect(f.api.open.mock.calls[0][1]?.aborted).toBe(false);
		expect(f.panel.transcript.isLoadingMessages).toBe(true);
		held.resolve(displayOpen('chat-1', 'view-1', 1));
		expect(await loading).toBe(true);
		expect(f.panel.transcript.loadStatus).toBe('loaded');
	} finally { held.resolve(displayOpen('chat-1', 'view-1', 1)); await loading; coordinator.dispose(); }
});

it.each(['success', 'failure'] as const)('refreshes metadata after a pre-outage open settles with %s', async outcome => {
	const f = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(held.promise);
	const loading = f.registry.loadChatSnapshot('chat-1').catch(() => false);
	const coordinator = new ChatReconnectCoordinator(f.options);
	let reconnect: Promise<void> | undefined;
	try {
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
		await coordinator.handleConnectionState(false);
		expect(f.api.open.mock.calls[0][1]?.aborted).toBe(false);
		const fresh = { ...displayOpen('chat-1', 'view-1', 1), plan: { ...displayOpen().plan, revision: 2 } };
		f.api.open.mockResolvedValue(fresh);
		reconnect = coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.ws.sendRequest).toHaveBeenCalledOnce());
		if (outcome === 'success') held.resolve(displayOpen('chat-1', 'view-1', 1));
		else held.reject(new Error('Synthetic interrupted HTTP response'));
		await reconnect;
		expect(await loading).toBe(outcome === 'success');
		expect(f.api.open).toHaveBeenCalledTimes(2);
		expect(f.panel.transcript.openSnapshot?.plan.revision).toBe(2);
	} finally { held.resolve(displayOpen()); await loading; await reconnect; coordinator.dispose(); }
});

it('does not reopen a queued reconnect refresh after disposal', async () => {
	const f = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(held.promise);
	const loading = f.registry.loadChatSnapshot('chat-1');
	const coordinator = new ChatReconnectCoordinator(f.options);
	let reconnect: Promise<void> | undefined;
	try {
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
		await coordinator.handleConnectionState(false);
		reconnect = coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.ws.sendRequest).toHaveBeenCalledOnce());
		coordinator.dispose();
		held.resolve(displayOpen());
		await reconnect;
		expect(await loading).toBe(false);
		expect(f.api.open).toHaveBeenCalledOnce();
	} finally { held.resolve(displayOpen()); await loading; await reconnect; coordinator.dispose(); }
});

it('recovers reconnect metadata and a sibling before a native-scroll projection gate releases', async () => {
	const f = fixture();
	f.registry.reconcile([
		{ surfaceId: 'chat-view:window-left', chatId: 'chat-1', windowId: 'window-left', presentation: 'window-left', snapshotAdmission: 'admitted' },
		{ surfaceId: 'chat-view:window-right', chatId: 'chat-1', windowId: 'window-right', presentation: 'window-right', snapshotAdmission: 'admitted' },
	]);
	await f.registry.loadChatSnapshot('chat-1');
	const sibling = f.registry.panel('chat-view:window-right')!;
	const gate = Promise.withResolvers<'apply'>();
	const entered = vi.fn(() => gate.promise);
	f.panel.transcript.setDisplayApplicationGate(entered);
	f.api.replace([displayRow(1), displayRow(2)]);
	const loading = f.registry.loadChatSnapshot('chat-1');
	const coordinator = new ChatReconnectCoordinator(f.options);
	let reconnect: Promise<void> | undefined;
	try {
		await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(sibling.transcript.loadedThroughOrdinal).toBe(2));
		await coordinator.handleConnectionState(false);
		const fresh = displayOpen('chat-1', 'view-1', 3);
		f.api.replace([displayRow(1), displayRow(2), displayRow(3)], { ...fresh, plan: { ...fresh.plan, revision: 2 } });
		reconnect = coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(3));
		await vi.waitFor(() => expect(sibling.transcript.loadedThroughOrdinal).toBe(3));
		expect(f.panel.transcript.openSnapshot?.plan.revision).toBe(2);
		expect(f.panel.transcript.loadedThroughOrdinal).toBe(1);
		expect(entered).toHaveBeenCalledOnce();
		gate.resolve('apply');
		await reconnect;
		expect(await loading).toBe(true);
		await vi.waitFor(() => expect(f.panel.transcript.loadedThroughOrdinal).toBe(3));
	} finally { gate.resolve('apply'); await loading; await reconnect; coordinator.dispose(); }
});

it('keeps the original caller attached when activation supersedes its reconnect successor', async () => {
	const f = fixture();
	await f.registry.loadChatSnapshot('chat-1');
	const gate = Promise.withResolvers<'apply'>();
	const entered = vi.fn(() => gate.promise);
	f.panel.transcript.setDisplayApplicationGate(entered);
	const loading = f.registry.loadChatSnapshot('chat-1', { purpose: 'activation' });
	const held = Promise.withResolvers<DisplayOpenResponse>();
	let refresh: Promise<boolean> | undefined, activation: Promise<boolean> | undefined;
	try {
		await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
		f.api.open.mockReturnValueOnce(held.promise);
		refresh = f.registry.refreshChatSnapshot('chat-1');
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(3));
		activation = f.registry.loadChatSnapshot('chat-1', { purpose: 'activation' });
		held.resolve(displayOpen());
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(4));
		gate.resolve('apply');
		expect(await loading).toBe(true);
		expect(await refresh).toBe(true);
		expect(await activation).toBe(true);
	} finally { held.resolve(displayOpen()); gate.resolve('apply'); await loading; await refresh; await activation; }
});

it('never starts a refresh after the original open completion disposes the coordinator', async () => {
	const f = fixture();
	const held = Promise.withResolvers<DisplayOpenResponse>();
	f.api.open.mockReturnValueOnce(held.promise);
	const coordinator = new ChatReconnectCoordinator(f.options);
	const loading = f.registry.loadChatSnapshot('chat-1');
	let opensAtDisposal = 0;
	const disposed = loading.then(() => {
		opensAtDisposal = f.api.open.mock.calls.length;
		coordinator.dispose();
	});
	let reconnect: Promise<void> | undefined;
	try {
		await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
		await coordinator.handleConnectionState(false);
		reconnect = coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.ws.sendRequest).toHaveBeenCalledOnce());
		held.resolve(displayOpen());
		await disposed;
		await reconnect;
		expect(await loading).toBe(true);
		expect(opensAtDisposal).toBeGreaterThan(0);
		expect(f.api.open).toHaveBeenCalledTimes(opensAtDisposal);
	} finally { held.resolve(displayOpen()); await disposed; await reconnect; coordinator.dispose(); }
});

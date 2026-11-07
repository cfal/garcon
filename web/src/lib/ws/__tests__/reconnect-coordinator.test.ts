import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { ChatReconnectCoordinator, type ChatReconnectCoordinatorOptions, type ReconnectPanelRegistryPort, type ReconnectWsPort } from '../reconnect-coordinator.svelte.js';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import { ReconnectStateMessage, type ReconnectControlResult } from '$shared/ws-events';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { displayOpen } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import ReconnectCoordinatorTestHost from './ReconnectCoordinatorTestHost.svelte';

const TS = '2026-01-01T00:00:00.000Z';
function control(instance = 'instance-1', version = 1): ChatExecutionControlState {
	return { ...displayOpen('chat-1', 'view-1', 0, instance).control, version, updatedAt: TS };
}
function response(results: ReconnectControlResult[] = [{ chatId: 'chat-1', outcome: 'snapshot', control: control() }], instance = 'instance-1') {
	return { ...new ReconnectStateMessage({ outcome: 'snapshot', chats: [] }, results, instance, 'request-1') };
}
const coordinators: ChatReconnectCoordinator[] = [];
afterEach(() => { cleanup(); for (const coordinator of coordinators.splice(0)) coordinator.dispose(); vi.restoreAllMocks(); });

function fixture(controlIds: string[] = [], visible = ['chat-1']) {
	const conversationUi = new ConversationUiState();
	for (const chatId of controlIds) conversationUi.setExecutionControlFromRefresh(chatId, control());
	const setControl = vi.spyOn(conversationUi, 'setExecutionControlFromRefresh');
	const confirmInstance = vi.spyOn(conversationUi, 'confirmExecutionControlSocketInstance');
	const removeControl = vi.spyOn(conversationUi, 'removeExecutionControl');
	const disconnect = vi.spyOn(conversationUi, 'markExecutionControlSocketDisconnected');
	const removeConsumer = vi.fn();
	const ws = {
		isConnected: false,
		sendRequest: vi.fn<ReconnectWsPort['sendRequest']>(async () => response()),
		addMessageConsumer: vi.fn<ReconnectWsPort['addMessageConsumer']>(() => removeConsumer),
	} satisfies ReconnectWsPort;
	const panels = {
		visibleChatIds: () => visible,
		cancelRefreshes: vi.fn(), resetServerInstance: vi.fn(),
		loadChatSnapshot: vi.fn<ReconnectPanelRegistryPort['loadChatSnapshot']>(async () => true),
	} satisfies ReconnectPanelRegistryPort;
	const sessions = { selectedChatId: 'chat-1' as string | null, quietRefreshChats: vi.fn(async () => {}) };
	const getExecutionControl = vi.fn(async (_chatId: string) => ({ control: control() }));
	const options = { ws, panels, conversationUi, sessions, getExecutionControl } satisfies ChatReconnectCoordinatorOptions;
	const coordinator = new ChatReconnectCoordinator(options);
	coordinators.push(coordinator);
	return { ...options, options, coordinator, setControl, confirmInstance, removeControl, disconnect, removeConsumer };
}

describe('ChatReconnectCoordinator', () => {
	it('recovers visible display surfaces on first connection and reconnect without a raw subscription', async () => {
		const f = fixture([], ['chat-1', 'chat-2']);
		await f.coordinator.handleConnectionState(true);
		expect(f.ws.sendRequest).toHaveBeenCalledExactlyOnceWith({ type: 'reconnect-state-query', controlChatIds: ['chat-1'] });
		expect(f.setControl).toHaveBeenCalledWith('chat-1', control());
		expect(f.confirmInstance).toHaveBeenCalledWith('instance-1');
		expect(f.panels.loadChatSnapshot.mock.calls).toEqual([['chat-1'], ['chat-2']]);
		await f.coordinator.handleConnectionState(true);
		expect(f.ws.sendRequest).toHaveBeenCalledOnce();
		await f.coordinator.handleConnectionState(false);
		expect(f.disconnect).toHaveBeenCalledOnce();
		expect(f.panels.cancelRefreshes).toHaveBeenCalledOnce();
		await f.coordinator.handleConnectionState(true);
		expect(f.ws.sendRequest).toHaveBeenCalledTimes(2);
		expect(f.panels.loadChatSnapshot).toHaveBeenCalledTimes(4);
	});

	it('refreshes cached background controls without opening background transcripts', async () => {
		const f = fixture(['chat-1', 'background']);
		f.ws.sendRequest.mockResolvedValue(response([
			{ chatId: 'chat-1', outcome: 'snapshot', control: control() },
			{ chatId: 'background', outcome: 'snapshot', control: control() },
		]));
		await f.coordinator.handleConnectionState(true);
		expect(f.ws.sendRequest).toHaveBeenCalledWith({ type: 'reconnect-state-query', controlChatIds: ['chat-1', 'background'] });
		expect(f.panels.loadChatSnapshot).toHaveBeenCalledExactlyOnceWith('chat-1');
		expect(f.getExecutionControl).not.toHaveBeenCalled();
	});

	it('reconciles global controls without a selected chat or rendered surface', async () => {
		const f = fixture(['background'], []);
		f.sessions.selectedChatId = null;
		f.ws.sendRequest.mockResolvedValue(response([]));
		await f.coordinator.handleConnectionState(true);
		expect(f.getExecutionControl).toHaveBeenCalledExactlyOnceWith('background');
		expect(f.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(f.panels.loadChatSnapshot).not.toHaveBeenCalled();
	});

	it.each(['snapshot', 'unavailable'] as const)('honors explicit control outcomes when processing is %s', async processingOutcome => {
		const f = fixture(['chat-2', 'chat-3', 'omitted']);
		f.ws.sendRequest.mockResolvedValue({ ...response([
			{ chatId: 'chat-1', outcome: 'snapshot', control: control('instance-1', 2) },
			{ chatId: 'chat-2', outcome: 'not-found' },
			{ chatId: 'chat-3', outcome: 'unavailable' },
			{ chatId: 'unsolicited', outcome: 'snapshot', control: control() },
		]), processing: processingOutcome === 'snapshot' ? { outcome: 'snapshot', chats: [] } : { outcome: 'unavailable' } });
		await f.coordinator.handleConnectionState(true);
		expect(f.removeControl).toHaveBeenCalledExactlyOnceWith('chat-2');
		expect(f.getExecutionControl.mock.calls).toEqual([['chat-3'], ['omitted']]);
		expect(f.setControl).toHaveBeenCalledWith('chat-1', control('instance-1', 2));
		expect(f.setControl).not.toHaveBeenCalledWith('unsolicited', expect.anything());
	});

	it.each(['network', 'malformed', 'mixed-instance'] as const)('falls back to HTTP controls without confirming %s envelopes', async failure => {
		const f = fixture(['background']);
		if (failure === 'network') f.ws.sendRequest.mockRejectedValue(new Error('offline'));
		if (failure === 'malformed') f.ws.sendRequest.mockResolvedValue({ ...response(), controlResults: [{ chatId: 'chat-1', outcome: 'unknown' }] });
		if (failure === 'mixed-instance') f.ws.sendRequest.mockResolvedValue(response([{ chatId: 'chat-1', outcome: 'snapshot', control: control('other-instance') }]));
		await f.coordinator.handleConnectionState(true);
		expect(f.confirmInstance).not.toHaveBeenCalled();
		expect(f.getExecutionControl.mock.calls).toEqual([['chat-1'], ['background']]);
		expect(f.panels.loadChatSnapshot).toHaveBeenCalledOnce();
	});

	it('does not make display recovery await slow fallback controls', async () => {
		const f = fixture();
		const held = Promise.withResolvers<{ control: ChatExecutionControlState }>();
		f.ws.sendRequest.mockResolvedValue(response([]));
		f.getExecutionControl.mockReturnValue(held.promise);
		const connected = f.coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.panels.loadChatSnapshot).toHaveBeenCalledOnce());
		expect(f.setControl).not.toHaveBeenCalled();
		held.resolve({ control: control() });
		await connected;
		expect(f.setControl).toHaveBeenCalledWith('chat-1', control());
	});

	it('continues other surfaces after a failed display open or list refresh', async () => {
		const f = fixture([], ['chat-1', 'chat-2']);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		f.sessions.quietRefreshChats.mockRejectedValue(new Error('list unavailable'));
		f.panels.loadChatSnapshot.mockRejectedValueOnce(new Error('source unavailable'));
		await expect(f.coordinator.handleConnectionState(true)).resolves.toBeUndefined();
		expect(f.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-2');
		expect(f.setControl).toHaveBeenCalledWith('chat-1', control());
	});

	it('opens visible transcripts after instance confirmation without waiting for the chat list', async () => {
		const f = fixture([], ['chat-1', 'chat-2']);
		const held = Promise.withResolvers<void>();
		f.sessions.quietRefreshChats.mockReturnValue(held.promise);
		const connected = f.coordinator.handleConnectionState(true);
		try {
			await vi.waitFor(() => expect(f.panels.loadChatSnapshot).toHaveBeenCalledTimes(2));
			expect(f.confirmInstance).toHaveBeenCalledWith('instance-1');
		} finally {
			held.resolve();
			await connected;
		}
	});

	it('bounds HTTP control concurrency and cancels later batches at disconnect', async () => {
		const f = fixture(Array.from({ length: 20 }, (_, index) => `background-${index}`));
		const held = Promise.withResolvers<{ control: ChatExecutionControlState }>();
		f.ws.sendRequest.mockResolvedValue(response([]));
		f.getExecutionControl.mockReturnValue(held.promise);
		const connected = f.coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.getExecutionControl).toHaveBeenCalledTimes(4));
		await f.coordinator.handleConnectionState(false);
		held.resolve({ control: control() });
		await connected;
		expect(f.getExecutionControl).toHaveBeenCalledTimes(4);
		expect(f.setControl).not.toHaveBeenCalled();
	});

	it.each(['disconnect', 'dispose'] as const)('rejects delayed envelopes after %s', async action => {
		const f = fixture();
		const held = Promise.withResolvers<Record<string, unknown>>();
		f.ws.sendRequest.mockReturnValueOnce(held.promise);
		const connected = f.coordinator.handleConnectionState(true);
		if (action === 'disconnect') await f.coordinator.handleConnectionState(false);
		else f.coordinator.dispose();
		held.resolve(response()); await connected;
		expect(f.confirmInstance).not.toHaveBeenCalled();
		expect(f.panels.loadChatSnapshot).not.toHaveBeenCalled();
		expect(f.getExecutionControl).not.toHaveBeenCalled();
	});

	it('does not install an older control reply across a newer reconnect epoch', async () => {
		const f = fixture();
		const held = Promise.withResolvers<{ control: ChatExecutionControlState }>();
		f.ws.sendRequest.mockRejectedValue(new Error('offline'));
		f.getExecutionControl.mockReturnValueOnce(held.promise).mockResolvedValue({ control: control('instance-c') });
		const old = f.coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.getExecutionControl).toHaveBeenCalledOnce());
		await f.coordinator.handleConnectionState(false);
		await f.coordinator.handleConnectionState(true);
		held.resolve({ control: control('instance-b', 10) }); await old;
		expect(f.conversationUi.getExecutionControl('chat-1')).toEqual(control('instance-c'));
	});

	it('[TLV5-DISPLAY.07-WEB-UNIT-02] recovers other visible chats independently of a held surface application', async () => {
		const f = fixture([], ['chat-1', 'chat-2']);
		const held = Promise.withResolvers<boolean>();
		f.panels.loadChatSnapshot.mockReturnValueOnce(held.promise);
		const old = f.coordinator.handleConnectionState(true);
		await vi.waitFor(() => expect(f.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-2'));
		await f.coordinator.handleConnectionState(false);
		held.resolve(false); await old;
		expect(f.panels.loadChatSnapshot).toHaveBeenCalledTimes(2);
		expect(f.panels.cancelRefreshes).toHaveBeenCalledOnce();
	});

	it('confirms identified pongs, rejects malformed pongs, and cleans up its consumer', async () => {
		const f = fixture();
		const mounted = render(ReconnectCoordinatorTestHost, { options: f.options });
		await vi.waitFor(() => expect(f.ws.addMessageConsumer).toHaveBeenCalledOnce());
		const consumer = f.ws.addMessageConsumer.mock.calls[0][0];
		const pong = { type: 'ws-pong', clientRequestId: 'probe-1', sentAt: 1, serverTime: TS, processing: { outcome: 'snapshot', chats: [] } };
		expect(consumer(pong, {})).toBe(false);
		expect(f.confirmInstance).not.toHaveBeenCalled();
		f.conversationUi.setExecutionControlFromLiveUpdate('chat-1', control('instance-old'));
		expect(consumer({ ...pong, serverInstanceId: 'instance-new' }, {})).toBe(false);
		expect(f.confirmInstance).toHaveBeenCalledWith('instance-new');
		expect(f.panels.resetServerInstance).toHaveBeenCalledWith('instance-new');
		expect(f.conversationUi.getExecutionControl('chat-1')).toBeNull();
		mounted.unmount();
		expect(f.removeConsumer).toHaveBeenCalledOnce();
	});
});

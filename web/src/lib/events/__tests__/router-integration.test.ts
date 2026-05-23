import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { PendingUserInput } from '$shared/pending-user-input';

function createStores(overrides: Partial<EventRouterStores> = {}): EventRouterStores {
	return {
		agentId: () => 'claude',
		selectedChat: () => ({ id: 'chat-a', projectPath: '/repo' } as never),
		currentChatId: () => 'chat-a',
		setCurrentChatId: vi.fn(),
		chatMessages: () => [],
		setChatMessages: vi.fn(),
		pendingUserInputs: () => [],
		setPendingUserInputs: vi.fn(),
		upsertPendingUserInput: vi.fn(),
		clearPendingUserInput: vi.fn(),
		updatePendingUserInputDeliveryStatus: vi.fn(),
		loadMessages: vi.fn().mockResolvedValue([]),
		setIsLoading: vi.fn(),
		setCanAbort: vi.fn(),
		setLoadingStatus: vi.fn(),
		pushLoadingStatus: vi.fn(),
		popLoadingStatus: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		setSelectedChatId: vi.fn(),
		pendingPermissionRequests: () => [],
		setPendingPermissionRequests: vi.fn(),
		pendingViewChat: () => null,
		setPendingViewChat: vi.fn(),
		setMessageQueue: vi.fn(),
		permissionMode: () => 'default',
		previousPermissionMode: () => null,
		setPermissionMode: vi.fn(),
		setPreviousPermissionMode: vi.fn(),
		patchChatPreview: vi.fn(),
		refreshChats: vi.fn(),
		hasChat: () => true,
		navigateToChat: vi.fn(),
		removeChat: vi.fn(),
		patchChatTitle: vi.fn(),
		navigateAwayFromChat: vi.fn(),
		startupCoordinator: {} as never,
		onLocalStartupConfirmed: vi.fn(),
		onExternalChatCreated: vi.fn(),
		reconcileProcessing: vi.fn(),
		setChatProcessing: vi.fn(),
		patchLastReadAt: vi.fn(),
		enqueueReadReceipt: vi.fn(),
		...overrides,
	};
}

function renderRouterWithRawMessages(
	rawMessages: Array<Record<string, unknown>>,
	stores: EventRouterStores,
) {
	const connection = { messageVersion: 1 } as WsConnection;
	let drained = false;
	const drainHandle: DrainHandle = {
		drain: () => {
			if (drained) return [];
			drained = true;
			return rawMessages.map((data) => ({ data, timestamp: Date.now() }));
		},
		cleanup: vi.fn(),
	};

	render(RouterIntegrationHost, { connection, drainHandle, stores });
}

describe('event router integration', () => {
	it('routes a global event from raw payload through normalize + filter + handler', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'chat-list-refresh-requested', reason: 'archive-toggled', chatId: 'chat-b' },
		], stores);

		expect(stores.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('routes fork-created events to the fork chat', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'chat-fork-created', sourceChatId: 'chat-a', chatId: 'chat-b' },
		], stores);

		expect(stores.setCurrentChatId).toHaveBeenCalledWith('chat-b');
		expect(stores.setSelectedChatId).toHaveBeenCalledWith('chat-b');
		expect(stores.navigateToChat).toHaveBeenCalledWith('chat-b');
		expect(stores.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('drops malformed payloads before reaching handlers', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'chat-list-refresh-requested', reason: 'archive-toggled' },
		], stores);

		expect(stores.refreshChats).not.toHaveBeenCalled();
	});

	it('skips scoped lifecycle events for non-active chats', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'agent-run-finished', chatId: 'chat-b', exitCode: 0 },
		], stores);

		expect(stores.setIsLoading).not.toHaveBeenCalled();
		expect(stores.setCanAbort).not.toHaveBeenCalled();
	});

	it('marks pending user messages accepted when correlated output arrives before REST response', () => {
		let pendingUserInputs: PendingUserInput[] = [{
			chatId: 'chat-a',
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			content: 'hello',
			createdAt: '2026-05-14T00:00:00.000Z',
			deliveryStatus: 'submitting',
		}];
		const stores = createStores({
			pendingUserInputs: () => pendingUserInputs,
			updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) => {
				pendingUserInputs = pendingUserInputs.map((input) =>
					input.clientRequestId === clientRequestId
						? { ...input, deliveryStatus }
						: input,
				);
			},
		});

		renderRouterWithRawMessages([
			{
				type: 'agent-run-output',
				chatId: 'chat-a',
				clientRequestId: 'req-1',
				providerRequestId: 'cursor-req-1',
				messages: [{ type: 'assistant-message', timestamp: '2026-05-14T00:00:01.000Z', content: 'hi' }],
			},
		], stores);

		expect(pendingUserInputs[0]?.deliveryStatus).toBe('accepted');
	});

	it('marks pending user messages failed on correlated execution failure', () => {
		let pendingUserInputs: PendingUserInput[] = [{
			chatId: 'chat-a',
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			content: 'hello',
			createdAt: '2026-05-14T00:00:00.000Z',
			deliveryStatus: 'submitting',
		}];
		const stores = createStores({
			pendingUserInputs: () => pendingUserInputs,
			updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) => {
				pendingUserInputs = pendingUserInputs.map((input) =>
					input.clientRequestId === clientRequestId
						? { ...input, deliveryStatus }
						: input,
				);
			},
		});

		renderRouterWithRawMessages([
			{
				type: 'agent-run-failed',
				chatId: 'chat-a',
				clientRequestId: 'req-1',
				error: 'provider failed',
			},
		], stores);

		expect(pendingUserInputs[0]?.deliveryStatus).toBe('failed');
	});
});

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { ChatMessage } from '$shared/chat-types';
import { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';

function createStores(overrides: Partial<EventRouterStores> = {}): EventRouterStores {
	return {
		agentSettings: {
			permissionMode: () => 'default',
			setPermissionMode: vi.fn(),
		},
		chatState: {
			setChatMessages: vi.fn(),
			appendChatMessagesByIdentity: vi.fn(),
			upsertPendingUserInput: vi.fn(),
			clearPendingUserInput: vi.fn(),
			updatePendingUserInputDeliveryStatus: vi.fn(),
			loadMessages: vi.fn().mockResolvedValue([]),
		},
		lifecycle: {
			currentChatId: () => 'chat-a',
			setCurrentChatId: vi.fn(),
			setIsLoading: vi.fn(),
			setCanAbort: vi.fn(),
			setLoadingStatus: vi.fn(),
			pushLoadingStatus: vi.fn(),
			popLoadingStatus: vi.fn(),
			setIsSystemChatChange: vi.fn(),
		},
		conversationUi: new ConversationUiStore(),
		sessions: {
			selectedChat: () => ({ id: 'chat-a', projectPath: '/repo' }) as never,
			setSelectedChatId: vi.fn(),
			patchChatPreview: vi.fn(),
			refreshChats: vi.fn(),
			navigateToChat: vi.fn(),
			removeChat: vi.fn(),
			patchChatTitle: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			reconcileProcessing: vi.fn(),
			setChatProcessing: vi.fn(),
			patchLastReadAt: vi.fn(),
		},
		startup: {
			startupCoordinator: {} as never,
			onLocalStartupConfirmed: vi.fn(),
			onExternalChatCreated: vi.fn(),
		},
		readState: {
			enqueueReadReceipt: vi.fn(),
		},
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
		renderRouterWithRawMessages(
			[{ type: 'chat-list-refresh-requested', reason: 'archive-toggled', chatId: 'chat-b' }],
			stores,
		);

		expect(stores.sessions.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('routes fork-created events to the fork chat', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-fork-created', sourceChatId: 'chat-a', chatId: 'chat-b' }],
			stores,
		);

		expect(stores.lifecycle.setCurrentChatId).toHaveBeenCalledWith('chat-b');
		expect(stores.sessions.setSelectedChatId).toHaveBeenCalledWith('chat-b');
		expect(stores.sessions.navigateToChat).toHaveBeenCalledWith('chat-b');
		expect(stores.sessions.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('uses updated active chat values for later events in the same drain', () => {
		let currentChatId: string | null = 'chat-a';
		let selectedChatId: string | null = 'chat-a';
		const setIsLoading = vi.fn();
		const defaults = createStores();
		const stores = createStores({
			sessions: {
				...defaults.sessions,
				selectedChat: () =>
					selectedChatId ? ({ id: selectedChatId, projectPath: '/repo' } as never) : null,
				setSelectedChatId: (id) => {
					selectedChatId = id;
				},
			},
			lifecycle: {
				...defaults.lifecycle,
				currentChatId: () => currentChatId,
				setCurrentChatId: (id) => {
					currentChatId = id;
				},
				setIsLoading,
			},
		});

		renderRouterWithRawMessages(
			[
				{ type: 'chat-fork-created', sourceChatId: 'chat-a', chatId: 'chat-b' },
				{ type: 'chat-processing-updated', chatId: 'chat-b', isProcessing: true },
			],
			stores,
		);

		expect(setIsLoading).toHaveBeenCalledWith(true);
	});

	it('drops malformed payloads before reaching handlers', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-list-refresh-requested', reason: 'archive-toggled' }],
			stores,
		);

		expect(stores.sessions.refreshChats).not.toHaveBeenCalled();
	});

	it('skips scoped lifecycle events for non-active chats', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'agent-run-finished', chatId: 'chat-b', exitCode: 0 }],
			stores,
		);

		expect(stores.lifecycle.setIsLoading).not.toHaveBeenCalled();
		expect(stores.lifecycle.setCanAbort).not.toHaveBeenCalled();
	});

	it('marks pending user messages accepted when correlated output arrives before REST response', () => {
		let pendingUserInputs: PendingUserInput[] = [
			{
				chatId: 'chat-a',
				clientRequestId: 'req-1',
				clientMessageId: 'msg-1',
				content: 'hello',
				createdAt: '2026-05-14T00:00:00.000Z',
				deliveryStatus: 'submitting',
			},
		];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) => {
					pendingUserInputs = pendingUserInputs.map((input) =>
						input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
					);
				},
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'agent-run-output',
					chatId: 'chat-a',
					clientRequestId: 'req-1',
					upstreamRequestId: 'cursor-req-1',
					messages: [
						{ type: 'assistant-message', timestamp: '2026-05-14T00:00:01.000Z', content: 'hi' },
					],
				},
			],
			stores,
		);

		expect(pendingUserInputs[0]?.deliveryStatus).toBe('accepted');
	});

	it('marks pending user messages failed on correlated execution failure', () => {
		let pendingUserInputs: PendingUserInput[] = [
			{
				chatId: 'chat-a',
				clientRequestId: 'req-1',
				clientMessageId: 'msg-1',
				content: 'hello',
				createdAt: '2026-05-14T00:00:00.000Z',
				deliveryStatus: 'submitting',
			},
		];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) => {
					pendingUserInputs = pendingUserInputs.map((input) =>
						input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
					);
				},
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'agent-run-failed',
					chatId: 'chat-a',
					clientRequestId: 'req-1',
					error: 'provider failed',
				},
			],
			stores,
		);

		expect(pendingUserInputs[0]?.deliveryStatus).toBe('failed');
	});

	it('preserves streamed output order before same-drain stop messages', () => {
		let currentMessages: ChatMessage[] = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				appendChatMessagesByIdentity: (messages) => {
					currentMessages = [...currentMessages, ...messages];
				},
				setChatMessages: (updater) => {
					currentMessages = typeof updater === 'function' ? updater(currentMessages) : updater;
				},
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'agent-run-output',
					chatId: 'chat-a',
					messages: [
						{
							type: 'assistant-message',
							timestamp: '2026-05-14T00:00:01.000Z',
							content: 'streamed',
						},
					],
				},
				{
					type: 'chat-session-stopped',
					chatId: 'chat-a',
					success: true,
				},
			],
			stores,
		);

		expect(
			currentMessages.map((message) => ('content' in message ? String(message.content) : '')),
		).toEqual(['streamed', 'Chat interrupted by user.']);
	});
});

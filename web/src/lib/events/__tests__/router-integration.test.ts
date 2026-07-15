import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

const TS = '2026-05-14T00:00:01.000Z';

function rawMessage(seq: number, message: Record<string, unknown>) {
	return { seq, message };
}

function createStores(overrides: Partial<EventRouterStores> = {}): EventRouterStores {
	return {
		agentSettings: {
			permissionMode: () => 'default',
			setPermissionMode: vi.fn(),
		},
		chatState: {
			getCursor: vi.fn(() => ({ generationId: 'generation-current', lastSeq: 1 })),
			applyChatMessages: vi.fn((): 'applied' => 'applied'),
			reloadChatTranscript: vi.fn(),
			warmBackgroundTranscript: vi.fn(() => true),
			isVisiblePreviewChat: vi.fn(() => false),
			warmVisibleChatPreview: vi.fn(),
			loadVisibleChatPreview: vi.fn(),
			markVisibleChatPreviewStale: vi.fn(),
			appendLocalNotice: vi.fn(),
			upsertPendingUserInput: vi.fn(),
			clearPendingUserInput: vi.fn(),
			updatePendingUserInputDeliveryStatus: vi.fn(),
			loadMessages: vi.fn().mockResolvedValue([]),
			removeChatTranscript: vi.fn(),
			markChatTranscriptStale: vi.fn(),
			markChatTranscriptValidated: vi.fn(),
		},
		lifecycle: {
			currentChatId: () => 'chat-a',
			setCurrentChatId: vi.fn(),
			markTurnRunning: vi.fn(),
			clearTurnStatus: vi.fn(),
			setLoadingStatus: vi.fn(),
			pushLoadingStatus: vi.fn(),
			popLoadingStatus: vi.fn(),
			setIsSystemChatChange: vi.fn(),
		},
		conversationUi: new ConversationUiState(),
		sessions: {
			selectedChat: () => ({ id: 'chat-a', projectPath: '/repo' }) as never,
			setSelectedChatId: vi.fn(),
			patchChatPreview: vi.fn(),
			refreshChats: vi.fn(),
			navigateToChat: vi.fn(),
			removeChat: vi.fn(),
			patchChatTitle: vi.fn(),
			patchChatProjectPath: vi.fn(),
			navigateAwayFromChat: vi.fn(),
			reconcileProcessing: vi.fn(),
			setChatProcessing: vi.fn(),
			patchLastReadAt: vi.fn(),
		},
		startup: {
			startupCoordinator: {} as never,
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

	it('routes ws-fault through normalize + global filter + handler without a chat ID', () => {
		const defaults = createStores();
		const stores = createStores({
			lifecycle: {
				...defaults.lifecycle,
				currentChatId: () => null,
			},
			sessions: {
				...defaults.sessions,
				selectedChat: () => null,
			},
		});

		renderRouterWithRawMessages([{ type: 'ws-fault', error: 'socket failed' }], stores);

		expect(stores.chatState.appendLocalNotice).toHaveBeenCalledWith('error', 'socket failed');
	});

	it('patches project path updates from raw payloads', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-project-path-updated',
					chatId: 'chat-b',
					projectPath: '/workspace/worktree',
					effectiveProjectKey: '/workspace/worktree',
					previousProjectPath: '/workspace/repo',
					previousEffectiveProjectKey: '/workspace/repo',
				},
			],
			stores,
		);

		expect(stores.sessions.patchChatProjectPath).toHaveBeenCalledWith('chat-b', {
			projectPath: '/workspace/worktree',
			effectiveProjectKey: '/workspace/worktree',
		});
	});

	it('applies selected chat messages and patches the sidebar preview', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					generationId: 'generation-current',
					clientRequestId: 'req-1',
					upstreamRequestId: 'cursor-req-1',
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'hi\nthere',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.updatePendingUserInputDeliveryStatus).toHaveBeenCalledWith(
			'req-1',
			'accepted',
		);
		expect(stores.chatState.warmBackgroundTranscript).not.toHaveBeenCalled();
		expect(stores.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		expect(stores.sessions.setChatProcessing).not.toHaveBeenCalled();
		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-a',
			'generation-current',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
		);
		expect(stores.sessions.patchChatPreview).toHaveBeenCalledWith('chat-a', 'hi', TS);
	});

	it('does not re-enable processing from a late selected chat message', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{ type: 'chat-processing-updated', chatId: 'chat-a', isProcessing: false },
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					generationId: 'generation-current',
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'final output',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.lifecycle.clearTurnStatus).toHaveBeenCalledWith();
		expect(stores.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		expect(stores.sessions.setChatProcessing).toHaveBeenCalledTimes(1);
		expect(stores.sessions.setChatProcessing).toHaveBeenCalledWith('chat-a', false);
		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-a',
			'generation-current',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
		);
	});

	it('reloads the selected chat when live messages expose a seq gap', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				applyChatMessages: vi.fn((): 'gap-detected' => 'gap-detected'),
				reloadChatTranscript: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					generationId: 'generation-current',
					messages: [
						rawMessage(3, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'later',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-a',
			'generation-current',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
		);
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-a');
	});

	it('patches background previews and warms cached background transcripts', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					generationId: 'generation-b',
					messages: [
						rawMessage(1, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'background',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.sessions.patchChatPreview).toHaveBeenCalledWith('chat-b', 'background', TS);
		expect(stores.chatState.warmBackgroundTranscript).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ seq: 1 })]),
		);
		expect(stores.chatState.applyChatMessages).not.toHaveBeenCalled();
	});

	it('warms visible split-pane previews before background chat filtering skips them', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				warmVisibleChatPreview: vi.fn(() => true),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					generationId: 'generation-b',
					messages: [
						rawMessage(1, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'visible split',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.warmVisibleChatPreview).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ seq: 1 })]),
		);
		expect(stores.chatState.warmBackgroundTranscript).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ seq: 1 })]),
		);
		expect(stores.chatState.applyChatMessages).not.toHaveBeenCalled();
	});

	it('reloads visible split-pane previews when live warming detects a gap', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				warmVisibleChatPreview: vi.fn(() => false),
				markVisibleChatPreviewStale: vi.fn(),
				loadVisibleChatPreview: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					generationId: 'generation-b',
					messages: [
						rawMessage(3, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'gap',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.markVisibleChatPreviewStale).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.loadVisibleChatPreview).toHaveBeenCalledWith('chat-b');
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

	it('flushes queued messages before handling selected generation reset', () => {
		const calls: string[] = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				getCursor: () => ({ generationId: 'generation-old', lastSeq: 1 }),
				applyChatMessages: vi.fn((): 'applied' => {
					calls.push('apply');
					return 'applied';
				}),
				reloadChatTranscript: vi.fn(() => {
					calls.push('reload');
				}),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					generationId: 'generation-old',
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'streamed',
						}),
					],
				},
				{
					type: 'chat-generation-reset',
					chatId: 'chat-a',
					generationId: 'generation-new',
					reason: 'manual-reload',
					lastSeq: 0,
				},
			],
			stores,
		);

		expect(calls).toEqual(['apply', 'reload']);
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-a');
	});

	it('marks background transcripts stale on generation reset', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-generation-reset',
					chatId: 'chat-b',
					generationId: 'generation-new',
					reason: 'process-error',
					lastSeq: 2,
				},
			],
			stores,
		);

		expect(stores.chatState.markChatTranscriptStale).toHaveBeenCalledWith('chat-b');
	});

	it('reloads visible split-pane previews on generation reset', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				markVisibleChatPreviewStale: vi.fn(),
				loadVisibleChatPreview: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-generation-reset',
					chatId: 'chat-b',
					generationId: 'generation-new',
					reason: 'manual-reload',
					lastSeq: 2,
				},
			],
			stores,
		);

		expect(stores.chatState.markVisibleChatPreviewStale).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.loadVisibleChatPreview).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.markChatTranscriptStale).toHaveBeenCalledWith('chat-b');
	});

	it('preserves streamed output order before same-drain stop messages', () => {
		let currentRows: Array<{ noticeType?: LocalNoticeType; content: string }> = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				applyChatMessages: (_chatId, _generationId, messages) => {
					currentRows = [
						...currentRows,
						...messages.map((entry) => ({
							content: 'content' in entry.message ? String(entry.message.content) : '',
						})),
					];
					return 'applied';
				},
				appendLocalNotice: (noticeType, content) => {
					currentRows = [...currentRows, { noticeType, content }];
				},
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					generationId: 'generation-current',
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'streamed',
						}),
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

		expect(currentRows).toEqual([
			{ content: 'streamed' },
			{ noticeType: 'warning', content: 'Chat interrupted by user.' },
		]);
	});
});

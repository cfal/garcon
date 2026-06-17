import { describe, expect, it } from 'vitest';
import {
	AgentRunFailedMessage,
	AgentRunFinishedMessage,
	ChatForkCreatedMessage,
	ChatGenerationResetMessage,
	ChatListRefreshRequestedMessage,
	ChatMessagesMessage,
	ChatProcessingUpdatedMessage,
	ChatReadUpdatedV1Message,
	ChatReloadedMessage,
	ChatSessionCreatedMessage,
	ChatSessionDeletedWsMessage,
	ChatSessionsRunningMessage,
	ChatSessionStoppedMessage,
	ChatSubscribedMessage,
	ClientRequestErrorMessage,
	PendingUserInputClearedMessage,
	QueueStateUpdatedMessage,
	SettingsChangedMessage,
	WsFaultMessage,
	WsPongMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import {
	ChatReloadRequest,
	ChatRunningQueryRequest,
	ChatSubscribeRequest,
	WsPingRequest,
	parseClientWsMessage,
} from '$shared/ws-requests';
import { ErrorMessage } from '$shared/chat-types';
import type { RemoteSettingsSnapshot } from '$shared/settings';

const chatViewMessage = {
	seq: 1,
	message: { type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' },
};

function makeSettingsSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 2,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '' },
		pinnedChatIds: [],
		lastAgentId: 'claude',
		lastProjectPath: '',
		lastModel: '',
		lastApiProviderId: null,
		lastModelEndpointId: null,
		lastModelProtocol: null,
		lastPermissionMode: 'default',
		lastThinkingMode: 'none',
		lastClaudeThinkingMode: 'auto',
		lastAmpAgentMode: 'smart',
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
		...overrides,
	};
}

describe('parseServerWsMessage', () => {
	it('parses chat-messages', () => {
		const msg = parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			generationId: 'generation-1',
			messages: [chatViewMessage],
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});

		expect(msg).toBeInstanceOf(ChatMessagesMessage);
		expect((msg as ChatMessagesMessage).chatId).toBe('c-1');
		expect((msg as ChatMessagesMessage).generationId).toBe('generation-1');
		expect((msg as ChatMessagesMessage).messages).toHaveLength(1);
		expect((msg as ChatMessagesMessage).turnId).toBe('turn-1');
		expect((msg as ChatMessagesMessage).clientRequestId).toBe('req-1');
		expect((msg as ChatMessagesMessage).upstreamRequestId).toBe('cursor-req-1');
	});

	it('rejects a chat message batch when any envelope is malformed', () => {
		expect(parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			generationId: 'generation-1',
			messages: [{
				seq: 0,
				message: { type: 'user-message', timestamp: '2025-01-01T00:00:00Z', content: 'bad' },
			}],
		})).toBeNull();

		expect(parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			generationId: 'generation-1',
			messages: [
				chatViewMessage,
				{ ...chatViewMessage, seq: 1 },
			],
		})).toBeNull();
	});

	it('keeps unknown inner messages as error placeholders inside a valid envelope', () => {
		const msg = parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			generationId: 'generation-1',
			messages: [{
				seq: 1,
				message: { type: 'future-message', timestamp: '2025-01-01T00:00:00Z', payload: {} },
			}],
		});

		expect(msg).toBeInstanceOf(ChatMessagesMessage);
		expect((msg as ChatMessagesMessage).messages[0].message).toBeInstanceOf(ErrorMessage);
	});

	it('parses chat-subscribed delta responses', () => {
		const msg = parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			generationId: 'generation-1',
			mode: 'delta',
			messages: [chatViewMessage],
			lastSeq: 1,
		});

		expect(msg).toBeInstanceOf(ChatSubscribedMessage);
		expect((msg as ChatSubscribedMessage).mode).toBe('delta');
		expect((msg as ChatSubscribedMessage).generationId).toBe('generation-1');
	});

	it('parses unloaded chat-subscribe snapshot-required with null generationId', () => {
		const msg = parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			generationId: null,
			mode: 'snapshot-required',
			messages: [],
			lastSeq: 0,
		});

		expect(msg).toBeInstanceOf(ChatSubscribedMessage);
		expect((msg as ChatSubscribedMessage).generationId).toBeNull();
	});

	it('rejects missing generationId except for snapshot-required chat-subscribed null', () => {
		expect(parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			messages: [],
		})).toBeNull();

		expect(parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			mode: 'delta',
			messages: [],
			lastSeq: 0,
		})).toBeNull();

		expect(parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			generationId: null,
			mode: 'delta',
			messages: [],
			lastSeq: 0,
		})).toBeNull();
	});

	it('parses lightweight generation reset messages', () => {
		const msg = parseServerWsMessage({
			type: 'chat-generation-reset',
			chatId: 'c-1',
			generationId: 'generation-2',
			reason: 'process-error',
			lastSeq: 2,
		});

		expect(msg).toBeInstanceOf(ChatGenerationResetMessage);
		expect((msg as ChatGenerationResetMessage).reason).toBe('process-error');
		expect((msg as ChatGenerationResetMessage).lastSeq).toBe(2);
	});

	it('parses chat-reloaded responses with request correlation', () => {
		const msg = parseServerWsMessage({
			type: 'chat-reloaded',
			clientRequestId: 'req-reload',
			chatId: 'c-1',
			generationId: 'generation-2',
			messages: [chatViewMessage],
			lastSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
		});

		expect(msg).toBeInstanceOf(ChatReloadedMessage);
		expect((msg as ChatReloadedMessage).clientRequestId).toBe('req-reload');
		expect((msg as ChatReloadedMessage).generationId).toBe('generation-2');
	});

	it('rejects legacy event-log payloads', () => {
		expect(parseServerWsMessage({ type: 'chat-events', chatId: 'c-1', logId: 'log-1', events: [] })).toBeNull();
		expect(parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			logId: 'log-1',
			events: [chatViewMessage],
		})).toBeNull();
		expect(parseServerWsMessage({
			type: 'chat-log-response',
			clientRequestId: 'req-1',
			chatId: 'c-1',
			logId: 'log-1',
			events: [],
			lastAppendSeq: 0,
			pageOldestSeq: 0,
			hasMore: false,
			limit: 50,
		})).toBeNull();
	});

	it('parses existing non-chat stream messages', () => {
		expect(parseServerWsMessage({ type: 'chat-sessions-running', sessions: {}, clientRequestId: 'req' }))
			.toBeInstanceOf(ChatSessionsRunningMessage);
		expect(parseServerWsMessage({ type: 'agent-run-finished', chatId: 'c-1', exitCode: 0 }))
			.toBeInstanceOf(AgentRunFinishedMessage);
		expect(parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1', error: 'timeout' }))
			.toBeInstanceOf(AgentRunFailedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-created', chatId: 'c-1' }))
			.toBeInstanceOf(ChatSessionCreatedMessage);
		expect(parseServerWsMessage({ type: 'chat-fork-created', sourceChatId: 'c-1', chatId: 'c-2' }))
			.toBeInstanceOf(ChatForkCreatedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-stopped', chatId: 'c-1', success: true }))
			.toBeInstanceOf(ChatSessionStoppedMessage);
		expect(parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', isProcessing: true }))
			.toBeInstanceOf(ChatProcessingUpdatedMessage);
		expect(parseServerWsMessage({ type: 'queue-state-updated', chatId: 'c-1', queue: { entries: [], paused: false } }))
			.toBeInstanceOf(QueueStateUpdatedMessage);
		expect(parseServerWsMessage({ type: 'pending-user-input-cleared', chatId: 'c-1', clientRequestId: 'req', reason: 'chat-removed' }))
			.toBeInstanceOf(PendingUserInputClearedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-deleted', chatId: 'c-1' }))
			.toBeInstanceOf(ChatSessionDeletedWsMessage);
		expect(parseServerWsMessage({ type: 'chat-read-updated-v1', chatId: 'c-1', lastReadAt: '2025-01-01T00:00:00Z' }))
			.toBeInstanceOf(ChatReadUpdatedV1Message);
		expect(parseServerWsMessage({ type: 'chat-list-refresh-requested', reason: 'chat-added', chatId: 'c-1' }))
			.toBeInstanceOf(ChatListRefreshRequestedMessage);
		expect(parseServerWsMessage({ type: 'settings-changed', settings: makeSettingsSnapshot() }))
			.toBeInstanceOf(SettingsChangedMessage);
		expect(parseServerWsMessage({
			type: 'client-request-error',
			clientRequestId: 'req-1',
			requestType: 'chat-log',
			code: 'SESSION_NOT_FOUND',
			message: 'Session not found',
			retryable: false,
		})).toBeInstanceOf(ClientRequestErrorMessage);
		expect(parseServerWsMessage({ type: 'ws-fault', error: 'disconnected' })).toBeInstanceOf(WsFaultMessage);
		expect(parseServerWsMessage({
			type: 'ws-pong',
			clientRequestId: 'req-ping',
			sentAt: 1234,
			serverTime: '2026-06-17T00:00:00.000Z',
		})).toBeInstanceOf(WsPongMessage);
	});

	it('rejects malformed existing stream messages', () => {
		expect(parseServerWsMessage({ type: 'agent-run-finished' })).toBeNull();
		expect(parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1' })).toBeNull();
		expect(parseServerWsMessage({ type: 'chat-list-refresh-requested', reason: 'mystery', chatId: 'c-1' })).toBeNull();
		expect(parseServerWsMessage({ type: 'settings-changed', settings: { version: 'oops' } })).toBeNull();
		expect(parseServerWsMessage({ type: 'ws-pong', clientRequestId: 'req-ping' })).toBeNull();
		expect(parseServerWsMessage({ type: 'unknown-event', data: 123 })).toBeNull();
	});
});

describe('parseClientWsMessage', () => {
	it('parses read/resume request messages', () => {
		expect(parseClientWsMessage({
			type: 'chats-running-query',
			clientRequestId: 'req-running',
		})).toBeInstanceOf(ChatRunningQueryRequest);

		const subscribe = parseClientWsMessage({
			type: 'chat-subscribe',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			generationId: 'generation-1',
			afterSeq: 7,
		});
		expect(subscribe).toBeInstanceOf(ChatSubscribeRequest);
		expect((subscribe as ChatSubscribeRequest).generationId).toBe('generation-1');
		expect((subscribe as ChatSubscribeRequest).afterSeq).toBe(7);

		expect(parseClientWsMessage({
			type: 'chat-reload',
			clientRequestId: 'req-reload',
			chatId: 'c-1',
		})).toBeInstanceOf(ChatReloadRequest);

		const ping = parseClientWsMessage({
			type: 'ws-ping',
			clientRequestId: 'req-ping',
			sentAt: 1234,
		});
		expect(ping).toBeInstanceOf(WsPingRequest);
		expect((ping as WsPingRequest).sentAt).toBe(1234);
	});

	it('defaults malformed subscribe cursors to an empty cursor', () => {
		const subscribe = parseClientWsMessage({
			type: 'chat-subscribe',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			generationId: 123,
			afterSeq: -1,
		});

		expect(subscribe).toBeInstanceOf(ChatSubscribeRequest);
		expect((subscribe as ChatSubscribeRequest).generationId).toBe('');
		expect((subscribe as ChatSubscribeRequest).afterSeq).toBe(0);
	});

	it('rejects unknown client request messages', () => {
		expect(parseClientWsMessage({ type: 'fork-run' })).toBeNull();
		expect(parseClientWsMessage({
			type: 'chat-log-query',
			clientRequestId: 'req-log',
			chatId: 'c-1',
			limit: 25,
			beforeSeq: 10,
		})).toBeNull();
	});
});

import { describe, it, expect } from 'vitest';
import {
	parseServerWsMessage,
	ChatEventsMessage,
	ChatSubscribedMessage,
	ChatGenerationResetMessage,
	ChatReloadedMessage,
	AgentRunFinishedMessage,
	AgentRunFailedMessage,
	ChatSessionCreatedMessage,
	ChatForkCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	QueueStateUpdatedMessage,
	PendingUserInputClearedMessage,
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
	ChatSessionsRunningMessage,
	SettingsChangedMessage,
	ChatLogResponseMessage,
	ClientRequestErrorMessage,
	WsFaultMessage,
} from '$shared/ws-events';
import { ErrorMessage } from '$shared/chat-types';
import { ForkRunRequest, parseClientWsMessage } from '$shared/ws-requests';

const chatEvent = {
	appendSeq: 1,
	seq: 1,
	messageId: 'message-1',
	rev: 1,
	message: { type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' },
};

describe('parseServerWsMessage', () => {
	it('parses chat-events', () => {
		const msg = parseServerWsMessage({
			type: 'chat-events',
			chatId: 'c-1',
			logId: 'log-1',
			events: [chatEvent],
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});
		expect(msg).toBeInstanceOf(ChatEventsMessage);
		expect((msg as ChatEventsMessage).chatId).toBe('c-1');
		expect((msg as ChatEventsMessage).logId).toBe('log-1');
		expect((msg as ChatEventsMessage).events).toHaveLength(1);
		expect((msg as ChatEventsMessage).turnId).toBe('turn-1');
		expect((msg as ChatEventsMessage).clientRequestId).toBe('req-1');
		expect((msg as ChatEventsMessage).upstreamRequestId).toBe('cursor-req-1');
	});

	it('rejects a chat-events batch when any envelope has invalid sequence values', () => {
		const msg = parseServerWsMessage({
			type: 'chat-events',
			chatId: 'c-1',
			logId: 'log-1',
			events: [{
				appendSeq: 0,
				seq: 1,
				messageId: 'message-1',
				rev: 1,
				message: { type: 'user-message', timestamp: '2025-01-01T00:00:00Z', content: 'bad' },
			}],
		});

		expect(msg).toBeNull();
	});

	it('keeps unknown inner messages as error placeholders inside a valid envelope', () => {
		const msg = parseServerWsMessage({
			type: 'chat-events',
			chatId: 'c-1',
			logId: 'log-1',
			events: [{
				appendSeq: 1,
				seq: 1,
				messageId: 'message-1',
				rev: 1,
				message: { type: 'future-message', timestamp: '2025-01-01T00:00:00Z', payload: {} },
			}],
		});

		expect(msg).toBeInstanceOf(ChatEventsMessage);
		expect((msg as ChatEventsMessage).events[0].message).toBeInstanceOf(ErrorMessage);
	});

	it('parses chat-subscribed', () => {
		const msg = parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			logId: 'log-1',
			mode: 'delta',
			events: [chatEvent],
			lastAppendSeq: 1,
		});
		expect(msg).toBeInstanceOf(ChatSubscribedMessage);
		expect((msg as ChatSubscribedMessage).clientRequestId).toBe('req-subscribe');
		expect((msg as ChatSubscribedMessage).mode).toBe('delta');
	});

	it('rejects chat-subscribed without mode or logId', () => {
		expect(parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			mode: 'delta',
			events: [],
			lastAppendSeq: 0,
		})).toBeNull();

		expect(parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			logId: 'log-1',
			events: [],
			lastAppendSeq: 0,
		})).toBeNull();
	});

	it('parses chat-generation-reset', () => {
		const msg = parseServerWsMessage({
			type: 'chat-generation-reset',
			chatId: 'c-1',
			logId: 'log-2',
			events: [chatEvent],
			lastAppendSeq: 1,
			localNotice: 'The process died.',
		});
		expect(msg).toBeInstanceOf(ChatGenerationResetMessage);
		expect((msg as ChatGenerationResetMessage).logId).toBe('log-2');
		expect((msg as ChatGenerationResetMessage).localNotice).toBe('The process died.');
	});

	it('parses chat-reloaded responses with request correlation', () => {
		const msg = parseServerWsMessage({
			type: 'chat-reloaded',
			clientRequestId: 'req-reload',
			chatId: 'c-1',
			logId: 'log-2',
			events: [chatEvent],
			lastAppendSeq: 1,
			localNotice: 'Reloaded.',
		});
		expect(msg).toBeInstanceOf(ChatReloadedMessage);
		expect((msg as ChatReloadedMessage).clientRequestId).toBe('req-reload');
		expect((msg as ChatReloadedMessage).chatId).toBe('c-1');
		expect((msg as ChatReloadedMessage).logId).toBe('log-2');
		expect((msg as ChatReloadedMessage).localNotice).toBe('Reloaded.');
	});

	it('parses chat-sessions-running responses with optional request correlation', () => {
		const msg = parseServerWsMessage({
			type: 'chat-sessions-running',
			clientRequestId: 'req-running',
			sessions: { claude: [{ id: 'c-1' }] },
		});
		expect(msg).toBeInstanceOf(ChatSessionsRunningMessage);
		expect((msg as ChatSessionsRunningMessage).clientRequestId).toBe('req-running');
		expect((msg as ChatSessionsRunningMessage).sessions).toEqual({
			claude: [{ id: 'c-1' }],
		});
	});

	it('parses agent-run-finished with exitCode', () => {
		const msg = parseServerWsMessage({
			type: 'agent-run-finished',
			chatId: 'c-1',
			exitCode: 0,
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});
		expect(msg).toBeInstanceOf(AgentRunFinishedMessage);
		expect((msg as AgentRunFinishedMessage).exitCode).toBe(0);
		expect((msg as AgentRunFinishedMessage).turnId).toBe('turn-1');
		expect((msg as AgentRunFinishedMessage).clientRequestId).toBe('req-1');
		expect((msg as AgentRunFinishedMessage).upstreamRequestId).toBe('cursor-req-1');
	});

	it('parses agent-run-failed', () => {
		const msg = parseServerWsMessage({
			type: 'agent-run-failed',
			chatId: 'c-1',
			error: 'timeout',
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});
		expect(msg).toBeInstanceOf(AgentRunFailedMessage);
		expect((msg as AgentRunFailedMessage).error).toBe('timeout');
		expect((msg as AgentRunFailedMessage).turnId).toBe('turn-1');
		expect((msg as AgentRunFailedMessage).clientRequestId).toBe('req-1');
		expect((msg as AgentRunFailedMessage).upstreamRequestId).toBe('cursor-req-1');
	});

	it('parses chat-session-created', () => {
		const msg = parseServerWsMessage({ type: 'chat-session-created', chatId: 'c-1' });
		expect(msg).toBeInstanceOf(ChatSessionCreatedMessage);
	});

	it('parses chat-fork-created', () => {
		const msg = parseServerWsMessage({
			type: 'chat-fork-created',
			sourceChatId: 'c-1',
			chatId: 'c-2',
		});
		expect(msg).toBeInstanceOf(ChatForkCreatedMessage);
		expect((msg as ChatForkCreatedMessage).sourceChatId).toBe('c-1');
		expect((msg as ChatForkCreatedMessage).chatId).toBe('c-2');
	});

	it('parses chat-session-stopped', () => {
		const msg = parseServerWsMessage({
			type: 'chat-session-stopped',
			chatId: 'c-1',
			success: true,
		});
		expect(msg).toBeInstanceOf(ChatSessionStoppedMessage);
		expect((msg as ChatSessionStoppedMessage).success).toBe(true);
	});

	it('parses chat-processing-updated', () => {
		const msg = parseServerWsMessage({
			type: 'chat-processing-updated',
			chatId: 'c-1',
			isProcessing: true,
		});
		expect(msg).toBeInstanceOf(ChatProcessingUpdatedMessage);
		expect((msg as ChatProcessingUpdatedMessage).isProcessing).toBe(true);
	});

	it('parses queue-state-updated', () => {
		const msg = parseServerWsMessage({
			type: 'queue-state-updated',
			chatId: 'c-1',
			queue: { entries: [], paused: false },
		});
		expect(msg).toBeInstanceOf(QueueStateUpdatedMessage);
	});

	it('parses pending clear messages only for chat removal', () => {
		const msg = parseServerWsMessage({
			type: 'pending-user-input-cleared',
			chatId: 'c-1',
			clientRequestId: 'req-1',
			reason: 'chat-removed',
		});

		expect(msg).toBeInstanceOf(PendingUserInputClearedMessage);
		expect((msg as PendingUserInputClearedMessage).reason).toBe('chat-removed');
	});

	it('rejects persisted pending clear messages at the shared parser', () => {
		const msg = parseServerWsMessage({
			type: 'pending-user-input-cleared',
			chatId: 'c-1',
			clientRequestId: 'req-1',
			reason: 'persisted',
		});

		expect(msg).toBeNull();
	});

	it('parses chat-title-updated', () => {
		const msg = parseServerWsMessage({
			type: 'chat-title-updated',
			chatId: 'c-1',
			title: 'Hello World',
		});
		expect(msg).toBeInstanceOf(ChatTitleUpdatedMessage);
		expect((msg as ChatTitleUpdatedMessage).title).toBe('Hello World');
	});

	it('parses chat-session-deleted', () => {
		const msg = parseServerWsMessage({ type: 'chat-session-deleted', chatId: 'c-1' });
		expect(msg).toBeInstanceOf(ChatSessionDeletedWsMessage);
	});

	it('parses chat-read-updated-v1', () => {
		const msg = parseServerWsMessage({
			type: 'chat-read-updated-v1',
			chatId: 'c-1',
			lastReadAt: '2025-01-01T00:00:00Z',
		});
		expect(msg).toBeInstanceOf(ChatReadUpdatedV1Message);
		expect((msg as ChatReadUpdatedV1Message).lastReadAt).toBe('2025-01-01T00:00:00Z');
		expect(msg as ChatReadUpdatedV1Message).not.toHaveProperty('isUnread');
	});

	it('parses chat-list-refresh-requested', () => {
		const msg = parseServerWsMessage({
			type: 'chat-list-refresh-requested',
			reason: 'pinned-toggled',
			chatId: 'c-1',
		});
		expect(msg).toBeInstanceOf(ChatListRefreshRequestedMessage);
		expect((msg as ChatListRefreshRequestedMessage).reason).toBe('pinned-toggled');
	});

	it('parses chat-list-refresh-requested for chat-added', () => {
		const msg = parseServerWsMessage({
			type: 'chat-list-refresh-requested',
			reason: 'chat-added',
			chatId: 'c-1',
		});
		expect(msg).toBeInstanceOf(ChatListRefreshRequestedMessage);
		expect((msg as ChatListRefreshRequestedMessage).reason).toBe('chat-added');
	});

	it('parses settings-changed', () => {
		const msg = parseServerWsMessage({
			type: 'settings-changed',
			settings: {
				version: 2,
				ui: { pinnedInsertPosition: 'bottom' },
				uiEffective: {},
				paths: { pinnedProjectPaths: [], browseStartPath: '/workspace' },
				pinnedChatIds: ['chat-1'],
				lastAgentId: 'claude',
				lastProjectPath: '/workspace/project',
				lastModel: 'opus',
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
			},
		});
		expect(msg).toBeInstanceOf(SettingsChangedMessage);
		expect((msg as SettingsChangedMessage).settings.version).toBe(2);
		expect((msg as SettingsChangedMessage).settings.ui.pinnedInsertPosition).toBe('bottom');
	});

	it('parses chat-log-response', () => {
		const msg = parseServerWsMessage({
			type: 'chat-log-response',
			clientRequestId: 'req-1',
			chatId: 'c-1',
			logId: 'log-1',
			events: [chatEvent],
			pendingUserInputs: [],
			lastAppendSeq: 1,
			pageOldestSeq: 1,
			hasMore: false,
			limit: 50,
			localNotice: 'The process died.',
		});
		expect(msg).toBeInstanceOf(ChatLogResponseMessage);
		expect((msg as ChatLogResponseMessage).clientRequestId).toBe('req-1');
		expect((msg as ChatLogResponseMessage).events).toHaveLength(1);
		expect((msg as ChatLogResponseMessage).localNotice).toBe('The process died.');
	});

	it('parses client-request-error', () => {
		const msg = parseServerWsMessage({
			type: 'client-request-error',
			clientRequestId: 'req-1',
			requestType: 'chat-log',
			code: 'SESSION_NOT_FOUND',
			message: 'Session not found',
			retryable: false,
		});
		expect(msg).toBeInstanceOf(ClientRequestErrorMessage);
		expect((msg as ClientRequestErrorMessage).code).toBe('SESSION_NOT_FOUND');
	});

	it('parses ws-fault', () => {
		const msg = parseServerWsMessage({ type: 'ws-fault', error: 'disconnected' });
		expect(msg).toBeInstanceOf(WsFaultMessage);
		expect((msg as WsFaultMessage).error).toBe('disconnected');
	});

	it('returns null for unknown message type', () => {
		const msg = parseServerWsMessage({ type: 'unknown-event', data: 123 });
		expect(msg).toBeNull();
	});

	it('returns null for agent-run-finished when chatId is missing', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-finished' });
		expect(msg).toBeNull();
	});

	it('returns null for agent-run-finished when chatId is numeric', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-finished', chatId: 42 });
		expect(msg).toBeNull();
	});

	it('returns null for agent-run-failed when error is missing', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1' });
		expect(msg).toBeNull();
	});

	it('returns null for agent-run-failed when chatId is missing', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-failed', error: 'timeout' });
		expect(msg).toBeNull();
	});

	it('returns null for chat-events when chatId is empty string', () => {
		const msg = parseServerWsMessage({ type: 'chat-events', chatId: '', logId: 'log-1', events: [] });
		expect(msg).toBeNull();
	});

	it('returns null for chat-session-created when chatId is missing', () => {
		const msg = parseServerWsMessage({ type: 'chat-session-created' });
		expect(msg).toBeNull();
	});

	it('returns null for chat-fork-created when sourceChatId is missing', () => {
		const msg = parseServerWsMessage({ type: 'chat-fork-created', chatId: 'c-2' });
		expect(msg).toBeNull();
	});

	it('returns null for chat-log-response when clientRequestId is missing', () => {
		const msg = parseServerWsMessage({
			type: 'chat-log-response',
			chatId: 'c-1',
			logId: 'log-1',
			events: [],
			pendingUserInputs: [],
			lastAppendSeq: 0,
			pageOldestSeq: 0,
			hasMore: false,
			limit: 50,
		});
		expect(msg).toBeNull();
	});

	it('returns null for client-request-error when requestType is missing', () => {
		const msg = parseServerWsMessage({
			type: 'client-request-error',
			clientRequestId: 'req-1',
			code: 'SESSION_NOT_FOUND',
			message: 'not found',
			retryable: false,
		});
		expect(msg).toBeNull();
	});

	it('returns null for settings-changed when snapshot is malformed', () => {
		const msg = parseServerWsMessage({
			type: 'settings-changed',
			settings: {
				version: 'oops',
			},
		});
		expect(msg).toBeNull();
	});

	it('returns null for chat-list-refresh-requested when reason is invalid', () => {
		const msg = parseServerWsMessage({
			type: 'chat-list-refresh-requested',
			reason: 'mystery-reason',
			chatId: 'c-1',
		});
		expect(msg).toBeNull();
	});
});

describe('parseClientWsMessage', () => {
	it('parses fork-run', () => {
		const msg = parseClientWsMessage({
			type: 'fork-run',
			sourceChatId: 'c-1',
			chatId: 'c-2',
			command: 'continue in the fork',
			permissionMode: 'default',
			thinkingMode: 'none',
			model: 'sonnet',
		});

		expect(msg).toBeInstanceOf(ForkRunRequest);
		expect((msg as ForkRunRequest).sourceChatId).toBe('c-1');
		expect((msg as ForkRunRequest).chatId).toBe('c-2');
		expect((msg as ForkRunRequest).command).toBe('continue in the fork');
	});

	it('rejects fork-run without a command', () => {
		expect(() =>
			parseClientWsMessage({
				type: 'fork-run',
				sourceChatId: 'c-1',
				chatId: 'c-2',
				command: '   ',
			}),
		).toThrow('command');
	});
});

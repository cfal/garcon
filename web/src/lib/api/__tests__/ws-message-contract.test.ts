import { describe, it, expect } from 'vitest';
import {
	parseServerWsMessage,
	AgentRunOutputMessage,
	AgentRunFinishedMessage,
	AgentRunFailedMessage,
	ChatSessionCreatedMessage,
	ChatForkCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	QueueStateUpdatedMessage,
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
	SettingsChangedMessage,
	ChatLogResponseMessage,
	ClientRequestErrorMessage,
	WsFaultMessage,
} from '$shared/ws-events';
import { ForkRunRequest, parseClientWsMessage } from '$shared/ws-requests';

describe('parseServerWsMessage', () => {
	it('parses agent-run-output', () => {
		const msg = parseServerWsMessage({
			type: 'agent-run-output',
			chatId: 'c-1',
			messages: [{ type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' }],
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});
		expect(msg).toBeInstanceOf(AgentRunOutputMessage);
		expect((msg as AgentRunOutputMessage).chatId).toBe('c-1');
		expect((msg as AgentRunOutputMessage).turnId).toBe('turn-1');
		expect((msg as AgentRunOutputMessage).clientRequestId).toBe('req-1');
		expect((msg as AgentRunOutputMessage).upstreamRequestId).toBe('cursor-req-1');
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
		const msg = parseServerWsMessage({ type: 'chat-session-stopped', chatId: 'c-1', success: true });
		expect(msg).toBeInstanceOf(ChatSessionStoppedMessage);
		expect((msg as ChatSessionStoppedMessage).success).toBe(true);
	});

	it('parses chat-processing-updated', () => {
		const msg = parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', isProcessing: true });
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

	it('parses chat-title-updated', () => {
		const msg = parseServerWsMessage({ type: 'chat-title-updated', chatId: 'c-1', title: 'Hello World' });
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
		expect((msg as ChatReadUpdatedV1Message)).not.toHaveProperty('isUnread');
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
				telegramBotTokenAvailable: false,
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
			messages: [],
			total: 0,
			hasMore: false,
			offset: 0,
			limit: 50,
		});
		expect(msg).toBeInstanceOf(ChatLogResponseMessage);
		expect((msg as ChatLogResponseMessage).clientRequestId).toBe('req-1');
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

	it('returns null for agent-run-output when chatId is empty string', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-output', chatId: '', messages: [] });
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
			messages: [],
			total: 0,
			hasMore: false,
			offset: 0,
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
		expect(() => parseClientWsMessage({
			type: 'fork-run',
			sourceChatId: 'c-1',
			chatId: 'c-2',
			command: '   ',
		})).toThrow('command');
	});
});

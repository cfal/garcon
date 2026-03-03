import { describe, it, expect } from 'vitest';
import {
	parseServerWsMessage,
	AgentRunOutputMessage,
	AgentRunFinishedMessage,
	AgentRunFailedMessage,
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	QueueStateUpdatedMessage,
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
	ChatLogResponseMessage,
	ClientRequestErrorMessage,
	WsFaultMessage,
} from '$shared/ws-events';

describe('parseServerWsMessage', () => {
	it('parses agent-run-output', () => {
		const msg = parseServerWsMessage({
			type: 'agent-run-output',
			chatId: 'c-1',
			messages: [{ type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' }],
		});
		expect(msg).toBeInstanceOf(AgentRunOutputMessage);
		expect((msg as AgentRunOutputMessage).chatId).toBe('c-1');
	});

	it('parses agent-run-finished with exitCode', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-finished', chatId: 'c-1', exitCode: 0 });
		expect(msg).toBeInstanceOf(AgentRunFinishedMessage);
		expect((msg as AgentRunFinishedMessage).exitCode).toBe(0);
	});

	it('parses agent-run-failed', () => {
		const msg = parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1', error: 'timeout' });
		expect(msg).toBeInstanceOf(AgentRunFailedMessage);
		expect((msg as AgentRunFailedMessage).error).toBe('timeout');
	});

	it('parses chat-session-created', () => {
		const msg = parseServerWsMessage({ type: 'chat-session-created', chatId: 'c-1' });
		expect(msg).toBeInstanceOf(ChatSessionCreatedMessage);
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
});

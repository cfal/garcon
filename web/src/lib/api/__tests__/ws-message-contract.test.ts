import { describe, expect, it } from 'vitest';
import {
	AgentRunFailedMessage,
	AgentRunFinishedMessage,
	ChatGenerationResetMessage,
	ChatListRefreshRequestedMessage,
	ChatMessagesMessage,
	ChatProcessingUpdatedMessage,
	ChatProjectPathUpdatedMessage,
	ChatReadUpdatedV1Message,
	ChatReloadedMessage,
	ChatSessionCreatedMessage,
	ChatSessionDeletedWsMessage,
	ChatSessionStoppedMessage,
	ChatSubscribedMessage,
	ClientRequestErrorMessage,
	PendingUserInputClearedMessage,
	ReconnectStateMessage,
	QueueStateUpdatedMessage,
	ScheduledPromptsInvalidatedMessage,
	SettingsChangedMessage,
	SnippetsInvalidatedMessage,
	WsFaultMessage,
	WsPongMessage,
	parseServerWsMessage,
} from '$shared/ws-events';
import {
	ChatReloadRequest,
	ChatSubscribeRequest,
	ReconnectStateQueryRequest,
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
		features: { transcriptSearch: { enabled: false } },
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
			},
			byAgent: {},
		},
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
		expect(parseServerWsMessage({ type: 'scheduled-prompts-invalidated', reason: 'executed' }))
			.toBeInstanceOf(ScheduledPromptsInvalidatedMessage);
		expect(parseServerWsMessage({
			type: 'reconnect-state',
			clientRequestId: 'req-reconnect',
			processing: { outcome: 'snapshot', runningChatIds: ['running-1'] },
			queueResults: [{
				chatId: 'c-1',
				outcome: 'snapshot',
				queue: { entries: [], pause: null, version: 4 },
			}, { chatId: 'deleted', outcome: 'not-found' }],
		})).toBeInstanceOf(ReconnectStateMessage);
		expect(parseServerWsMessage({ type: 'agent-run-finished', chatId: 'c-1', exitCode: 0 }))
			.toBeInstanceOf(AgentRunFinishedMessage);
		expect(parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1', error: 'timeout' }))
			.toBeInstanceOf(AgentRunFailedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-created', chatId: 'c-1' }))
			.toBeInstanceOf(ChatSessionCreatedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-stopped', chatId: 'c-1', success: true }))
			.toBeInstanceOf(ChatSessionStoppedMessage);
		expect(parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', isProcessing: true }))
			.toBeInstanceOf(ChatProcessingUpdatedMessage);
		expect(parseServerWsMessage({ type: 'queue-state-updated', chatId: 'c-1', queue: { entries: [], pause: null } }))
			.toBeInstanceOf(QueueStateUpdatedMessage);
		expect(parseServerWsMessage({ type: 'pending-user-input-cleared', chatId: 'c-1', clientRequestId: 'req', reason: 'chat-removed' }))
			.toBeInstanceOf(PendingUserInputClearedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-deleted', chatId: 'c-1' }))
			.toBeInstanceOf(ChatSessionDeletedWsMessage);
			expect(parseServerWsMessage({ type: 'chat-read-updated-v1', chatId: 'c-1', lastReadAt: '2025-01-01T00:00:00Z' }))
				.toBeInstanceOf(ChatReadUpdatedV1Message);
			const projectPathUpdated = parseServerWsMessage({
				type: 'chat-project-path-updated',
				chatId: 'c-1',
				projectPath: '/workspace/worktree',
				effectiveProjectKey: '/workspace/worktree',
				previousProjectPath: '/workspace/repo',
				previousEffectiveProjectKey: '/workspace/repo',
			});
			expect(projectPathUpdated).toBeInstanceOf(ChatProjectPathUpdatedMessage);
			expect((projectPathUpdated as ChatProjectPathUpdatedMessage).projectPath).toBe('/workspace/worktree');
			expect(parseServerWsMessage({ type: 'chat-list-refresh-requested', reason: 'chat-added', chatId: 'c-1' }))
				.toBeInstanceOf(ChatListRefreshRequestedMessage);
		const settingsChanged = parseServerWsMessage({
			type: 'settings-changed',
			settings: makeSettingsSnapshot({
				ui: { appIdentity: { title: 'Garcon - Work' } },
			}),
		});
		expect(settingsChanged).toBeInstanceOf(SettingsChangedMessage);
		expect((settingsChanged as SettingsChangedMessage).settings.ui.appIdentity?.title)
			.toBe('Garcon - Work');
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

	it('parses only known snippet invalidation reasons', () => {
		for (const reason of ['created', 'updated', 'removed', 'reordered']) {
			expect(parseServerWsMessage({ type: 'snippets-invalidated', reason }))
				.toBeInstanceOf(SnippetsInvalidatedMessage);
		}
		expect(parseServerWsMessage({ type: 'snippets-invalidated', reason: 'renamed' })).toBeNull();
		expect(parseServerWsMessage({ type: 'snippets-invalidated' })).toBeNull();
	});

	it('rejects malformed existing stream messages', () => {
		expect(parseServerWsMessage({ type: 'agent-run-finished' })).toBeNull();
		expect(parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1' })).toBeNull();
		expect(parseServerWsMessage({ type: 'chat-list-refresh-requested', reason: 'mystery', chatId: 'c-1' })).toBeNull();
		expect(parseServerWsMessage({ type: 'settings-changed', settings: { version: 'oops' } })).toBeNull();
		expect(parseServerWsMessage({ type: 'ws-pong', clientRequestId: 'req-ping' })).toBeNull();
		expect(parseServerWsMessage({
			type: 'reconnect-state',
			processing: { outcome: 'snapshot', runningChatIds: [] },
			queueResults: [{ chatId: 'c-1', outcome: 'snapshot' }],
		})).toBeNull();
		expect(parseServerWsMessage({ type: 'unknown-event', data: 123 })).toBeNull();
	});

	it('strictly parses reconnect processing outcomes', () => {
		const snapshot = parseServerWsMessage({
			type: 'reconnect-state',
			clientRequestId: 'req-reconnect',
			processing: {
				outcome: 'snapshot',
				runningChatIds: [' chat-2 ', 'chat-1', 'chat-2'],
			},
			queueResults: [],
		});
		expect(snapshot).toBeInstanceOf(ReconnectStateMessage);
		expect((snapshot as ReconnectStateMessage).processing).toEqual({
			outcome: 'snapshot',
			runningChatIds: ['chat-2', 'chat-1'],
		});
		expect((snapshot as ReconnectStateMessage).clientRequestId).toBe('req-reconnect');

		const unavailable = parseServerWsMessage({
			type: 'reconnect-state',
			processing: { outcome: 'unavailable' },
			queueResults: [],
		});
		expect(unavailable).toBeInstanceOf(ReconnectStateMessage);
		expect((unavailable as ReconnectStateMessage).processing).toEqual({ outcome: 'unavailable' });

		for (const processing of [
			undefined,
			null,
			[],
			{},
			{ outcome: 'unknown' },
			{ outcome: 'snapshot' },
			{ outcome: 'snapshot', runningChatIds: 'chat-1' },
			{ outcome: 'snapshot', runningChatIds: [42] },
			{ outcome: 'snapshot', runningChatIds: [' '] },
		]) {
			expect(parseServerWsMessage({
				type: 'reconnect-state',
				processing,
				queueResults: [],
			})).toBeNull();
		}
		expect(parseServerWsMessage({
			type: 'reconnect-state',
			sessions: { claude: [{ id: 'legacy' }] },
			queueResults: [],
		})).toBeNull();
	});
});
describe('parseClientWsMessage', () => {
	it('parses read/resume request messages', () => {
		const reconnect = parseClientWsMessage({
			type: 'reconnect-state-query',
			clientRequestId: 'req-reconnect',
			queueChatIds: ['c-1', 'c-1', '', 42, ' c-2 '],
		});
		expect(reconnect).toBeInstanceOf(ReconnectStateQueryRequest);
		expect((reconnect as ReconnectStateQueryRequest).queueChatIds).toEqual(['c-1', 'c-2']);

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

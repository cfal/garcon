import { describe, expect, it } from 'vitest';
import {
	AgentRunFailedMessage,
	AgentRunFinishedMessage,
	ChatTranscriptReplacedMessage,
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
	ChatTransientFeedMutationMessage,
	ClientRequestErrorMessage,
	ReconnectStateMessage,
	ChatExecutionControlUpdatedMessage,
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
import { CHAT_STOP_OUTCOMES, ErrorMessage } from '$shared/chat-types';
import type { RemoteSettingsSnapshot } from '$shared/settings';

const chatViewMessage = {
	ordinal: 1,
	message: { type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' },
};

function transientFeed(transcriptViewId = 'generation-1') {
	return {
		serverInstanceId: 'server-instance-test',
		chatId: 'c-1',
		transcriptViewId,
		transientRevision: 0,
		rows: [],
	};
}

function emptyExecutionControl(version = 4, serverInstanceId = 'server-instance-test') {
	return {
		serverInstanceId,
		queue: {
			entries: [],
			steeringEntryId: null,
			recentlyDispatched: [],
			pause: null,
			reorderRevision: 0,
		},
		version,
		updatedAt: '2026-07-18T00:00:00.000Z',
	};
}

function makeSettingsSnapshot(
	overrides: Partial<RemoteSettingsSnapshot> = {},
): RemoteSettingsSnapshot {
	return {
		version: 2,
		features: {
			transcriptSearch: { enabled: false },
			agentCommands: { enabled: true, chatIdDiscovery: true, sendMessage: true },
		},
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
		pinnedChatIds: [],
		recentAgentSettings: [],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettingsById: {},
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
			transcriptViewId: 'generation-1',
			messages: [chatViewMessage],
			firstOrdinal: 1,
			lastOrdinal: 1,
			resendCandidates: [],
			turnId: 'turn-1',
			clientRequestId: 'req-1',
			upstreamRequestId: 'cursor-req-1',
		});

		expect(msg).toBeInstanceOf(ChatMessagesMessage);
		expect((msg as ChatMessagesMessage).chatId).toBe('c-1');
		expect((msg as ChatMessagesMessage).transcriptViewId).toBe('generation-1');
		expect((msg as ChatMessagesMessage).messages).toHaveLength(1);
		expect((msg as ChatMessagesMessage).turnId).toBe('turn-1');
		expect((msg as ChatMessagesMessage).clientRequestId).toBe('req-1');
		expect((msg as ChatMessagesMessage).upstreamRequestId).toBe('cursor-req-1');
	});

	it('rejects a chat message batch when any envelope is malformed', () => {
		expect(
			parseServerWsMessage({
				type: 'chat-messages',
				chatId: 'c-1',
				transcriptViewId: 'generation-1',
				firstOrdinal: 1,
				lastOrdinal: 1,
				messages: [
					{
						ordinal: 0,
						message: { type: 'user-message', timestamp: '2025-01-01T00:00:00Z', content: 'bad' },
					},
				],
			}),
		).toBeNull();

		expect(
			parseServerWsMessage({
				type: 'chat-messages',
				chatId: 'c-1',
				transcriptViewId: 'generation-1',
				messages: [chatViewMessage, { ...chatViewMessage, ordinal: 1 }],
				firstOrdinal: 1,
				lastOrdinal: 1,
			}),
		).toBeNull();
	});

	it('keeps unknown inner messages as error placeholders inside a valid envelope', () => {
		const msg = parseServerWsMessage({
			type: 'chat-messages',
			chatId: 'c-1',
			transcriptViewId: 'generation-1',
			firstOrdinal: 1,
			lastOrdinal: 1,
			messages: [
				{
					ordinal: 1,
					message: { type: 'future-message', timestamp: '2025-01-01T00:00:00Z', payload: {} },
				},
			],
			resendCandidates: [],
		});

		expect(msg).toBeInstanceOf(ChatMessagesMessage);
		expect((msg as ChatMessagesMessage).messages[0].message).toBeInstanceOf(ErrorMessage);
	});

	it('parses chat-subscribed replay responses', () => {
		const msg = parseServerWsMessage({
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			transcriptViewId: 'generation-1',
			messages: [chatViewMessage],
			firstOrdinal: 1,
			lastOrdinal: 1,
			nextAfterOrdinal: 1,
			throughOrdinal: 1,
			hasMore: false,
			resendCandidates: [],
			transientFeed: transientFeed(),
		});

		expect(msg).toBeInstanceOf(ChatSubscribedMessage);
		expect((msg as ChatSubscribedMessage).transcriptViewId).toBe('generation-1');
		expect((msg as ChatSubscribedMessage).messages).toEqual([chatViewMessage]);
	});

	it('rejects chat-subscribe transient state for another chat or transcript view', () => {
		const response = {
			type: 'chat-subscribed',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			transcriptViewId: 'generation-1',
			messages: [],
			firstOrdinal: 1,
			lastOrdinal: 0,
			nextAfterOrdinal: 0,
			throughOrdinal: 0,
			hasMore: false,
			resendCandidates: [],
		};
		expect(parseServerWsMessage({
			...response,
			transientFeed: { ...transientFeed(), chatId: 'c-2' },
		})).toBeNull();
		expect(parseServerWsMessage({
			...response,
			transientFeed: transientFeed('generation-2'),
		})).toBeNull();
	});

	it('parses ordered transient mutations', () => {
		const mutation = parseServerWsMessage({
			type: 'chat-transient-feed-mutation',
			...transientFeed(),
			transientRevision: 1,
			mutation: { kind: 'remove', permissionOccurrenceId: 'one' },
		});
		expect(mutation).toBeInstanceOf(ChatTransientFeedMutationMessage);
	});

	it('rejects chat-subscribe responses without a transient-feed snapshot', () => {
		expect(
			parseServerWsMessage({
				type: 'chat-subscribed',
				clientRequestId: 'req-subscribe',
				chatId: 'c-1',
				transcriptViewId: 'generation-1',
				messages: [],
				firstOrdinal: 1,
				lastOrdinal: 0,
				nextAfterOrdinal: 0,
				throughOrdinal: 0,
				hasMore: false,
				resendCandidates: [],
			}),
		).toBeNull();
	});

	it('rejects missing or null transcript view IDs', () => {
		expect(
			parseServerWsMessage({
				type: 'chat-messages',
				chatId: 'c-1',
				messages: [],
				firstOrdinal: 1,
				lastOrdinal: 0,
			}),
		).toBeNull();

		expect(
			parseServerWsMessage({
				type: 'chat-subscribed',
				clientRequestId: 'req-subscribe',
				chatId: 'c-1',
				messages: [],
				firstOrdinal: 1,
				lastOrdinal: 0,
				nextAfterOrdinal: 0,
				throughOrdinal: 0,
				hasMore: false,
				transientFeed: transientFeed(),
			}),
		).toBeNull();

		expect(
			parseServerWsMessage({
				type: 'chat-subscribed',
				clientRequestId: 'req-subscribe',
				chatId: 'c-1',
				transcriptViewId: null,
				messages: [],
				firstOrdinal: 1,
				lastOrdinal: 0,
				nextAfterOrdinal: 0,
				throughOrdinal: 0,
				hasMore: false,
				transientFeed: transientFeed(),
			}),
		).toBeNull();
	});

	it('parses transcript replacement messages', () => {
		const msg = parseServerWsMessage({
			type: 'chat-transcript-replaced',
			chatId: 'c-1',
			previousTranscriptViewId: 'generation-1',
			transcriptViewId: 'generation-2',
			lastOrdinal: 2,
		});

		expect(msg).toBeInstanceOf(ChatTranscriptReplacedMessage);
		expect((msg as ChatTranscriptReplacedMessage).previousTranscriptViewId).toBe('generation-1');
		expect((msg as ChatTranscriptReplacedMessage).lastOrdinal).toBe(2);
	});

	it('parses chat-reloaded responses with request correlation', () => {
		const msg = parseServerWsMessage({
			type: 'chat-reloaded',
			clientRequestId: 'req-reload',
			chatId: 'c-1',
			transcriptViewId: 'generation-2',
			messages: [{ ...chatViewMessage, ordinal: 51 }],
			lastOrdinal: 100,
			pageOldestOrdinal: 51,
			pageNewestOrdinal: 100,
			nextBeforeOrdinal: 51,
			hasMore: true,
		});

		expect(msg).toBeInstanceOf(ChatReloadedMessage);
		expect((msg as ChatReloadedMessage).clientRequestId).toBe('req-reload');
		expect((msg as ChatReloadedMessage).transcriptViewId).toBe('generation-2');
		expect((msg as ChatReloadedMessage).nextBeforeOrdinal).toBe(51);
	});

	it.each([
		['non-boolean hasMore', { hasMore: 'false' }],
		['oldest ordinal that does not match the first message', { pageOldestOrdinal: 0 }],
		['newest ordinal that does not match the current tail', { pageNewestOrdinal: 0 }],
		['last ordinal behind the newest page', { lastOrdinal: 0 }],
		['message outside the declared page', { pageOldestOrdinal: 2 }],
	])('rejects chat-reloaded responses with invalid %s', (_name, patch) => {
		expect(parseServerWsMessage({
			type: 'chat-reloaded',
			clientRequestId: 'req-reload',
			chatId: 'c-1',
			transcriptViewId: 'generation-2',
			messages: [chatViewMessage],
			lastOrdinal: 1,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
			...patch,
		})).toBeNull();
	});

	it('rejects legacy event-log payloads', () => {
		expect(
			parseServerWsMessage({ type: 'chat-events', chatId: 'c-1', logId: 'log-1', events: [] }),
		).toBeNull();
		expect(
			parseServerWsMessage({
				type: 'chat-messages',
				chatId: 'c-1',
				logId: 'log-1',
				events: [chatViewMessage],
			}),
		).toBeNull();
		expect(
			parseServerWsMessage({
				type: 'chat-log-response',
				clientRequestId: 'req-1',
				chatId: 'c-1',
				logId: 'log-1',
				events: [],
				lastAppendSeq: 0,
				pageOldestSeq: 0,
				hasMore: false,
				limit: 50,
			}),
		).toBeNull();
	});

	it('parses existing non-chat stream messages', () => {
		expect(
			parseServerWsMessage({ type: 'scheduled-prompts-invalidated', reason: 'executed' }),
		).toBeInstanceOf(ScheduledPromptsInvalidatedMessage);
		expect(
			parseServerWsMessage({
				type: 'reconnect-state',
				clientRequestId: 'req-reconnect',
				serverInstanceId: 'server-instance-test',
				processing: {
					outcome: 'snapshot',
					chats: [{ chatId: 'running-1', phase: 'running' }],
				},
				controlResults: [
					{
						chatId: 'c-1',
						outcome: 'snapshot',
						control: emptyExecutionControl(),
					},
					{ chatId: 'deleted', outcome: 'not-found' },
				],
			}),
		).toBeInstanceOf(ReconnectStateMessage);
		expect(
			parseServerWsMessage({ type: 'agent-run-finished', chatId: 'c-1', exitCode: 0 }),
		).toBeInstanceOf(AgentRunFinishedMessage);
		expect(
			parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1', error: 'timeout' }),
		).toBeInstanceOf(AgentRunFailedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-created', chatId: 'c-1' })).toBeInstanceOf(
			ChatSessionCreatedMessage,
		);
		expect(
			parseServerWsMessage({
				type: 'chat-session-stopped',
				chatId: 'c-1',
				outcome: 'interrupt-requested',
				intent: 'interrupt-and-send',
			}),
		).toEqual(new ChatSessionStoppedMessage('c-1', 'interrupt-requested', 'interrupt-and-send'));
		expect(
			parseServerWsMessage({
				type: 'chat-session-stopped',
				chatId: 'c-1',
				outcome: 'interrupt-requested',
			}),
		).toBeNull();
		for (const outcome of CHAT_STOP_OUTCOMES) {
			expect(
				parseServerWsMessage({
					type: 'chat-session-stopped',
					chatId: 'c-1',
					outcome,
					intent: 'stop',
				}),
			).toEqual(new ChatSessionStoppedMessage('c-1', outcome, 'stop'));
		}
		for (const outcome of [undefined, 'unexpected']) {
			expect(
				parseServerWsMessage({
					type: 'chat-session-stopped',
					chatId: 'c-1',
					outcome,
					intent: 'stop',
				}),
			).toBeNull();
		}
		expect(
			parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', phase: 'running' }),
		).toEqual(new ChatProcessingUpdatedMessage('c-1', 'running'));
		expect(
			parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', phase: 'stopping' }),
		).toEqual(new ChatProcessingUpdatedMessage('c-1', 'stopping'));
		expect(
			parseServerWsMessage({ type: 'chat-processing-updated', chatId: 'c-1', phase: null }),
		).toEqual(new ChatProcessingUpdatedMessage('c-1', null));
		expect(
			parseServerWsMessage({
				type: 'chat-execution-control-updated',
				chatId: 'c-1',
				control: emptyExecutionControl(),
			}),
		).toBeInstanceOf(ChatExecutionControlUpdatedMessage);
		expect(parseServerWsMessage({ type: 'chat-session-deleted', chatId: 'c-1' })).toBeInstanceOf(
			ChatSessionDeletedWsMessage,
		);
		expect(
			parseServerWsMessage({
				type: 'chat-read-updated-v1',
				chatId: 'c-1',
				lastReadAt: '2025-01-01T00:00:00Z',
			}),
		).toBeInstanceOf(ChatReadUpdatedV1Message);
		const projectPathUpdated = parseServerWsMessage({
			type: 'chat-project-path-updated',
			chatId: 'c-1',
			projectPath: '/workspace/worktree',
			effectiveProjectKey: '/workspace/worktree',
			previousProjectPath: '/workspace/repo',
			previousEffectiveProjectKey: '/workspace/repo',
		});
		expect(projectPathUpdated).toBeInstanceOf(ChatProjectPathUpdatedMessage);
		expect((projectPathUpdated as ChatProjectPathUpdatedMessage).projectPath).toBe(
			'/workspace/worktree',
		);
		expect(
			parseServerWsMessage({
				type: 'chat-list-refresh-requested',
				reason: 'tags-updated',
				chatId: 'c-1',
			}),
		).toBeInstanceOf(ChatListRefreshRequestedMessage);
		expect(
			parseServerWsMessage({
				type: 'chat-list-refresh-requested',
				reason: 'chats-reordered',
				chatId: 'c-1',
			}),
		).toBeInstanceOf(ChatListRefreshRequestedMessage);
		expect(
			parseServerWsMessage({
				type: 'chat-list-refresh-requested',
				reason: 'chats-reordered-quick',
				chatId: 'c-1',
			}),
		).toBeNull();
		const settingsSnapshot = makeSettingsSnapshot({
			ui: { appIdentity: { title: 'Garcon - Work' } },
		});
		const settingsChanged = parseServerWsMessage({
			type: 'settings-changed',
			settings: settingsSnapshot,
		});
		expect(settingsChanged).toBeInstanceOf(SettingsChangedMessage);
		expect((settingsChanged as SettingsChangedMessage).settings.ui.appIdentity?.title).toBe(
			'Garcon - Work',
		);
		expect(
			(settingsChanged as SettingsChangedMessage).settings.features.agentCommands,
		).toEqual({
			enabled: true,
			chatIdDiscovery: true,
			sendMessage: true,
		});
		expect(
			parseServerWsMessage({
				type: 'client-request-error',
				clientRequestId: 'req-1',
				requestType: 'chat-log',
				code: 'SESSION_NOT_FOUND',
				message: 'Session not found',
				retryable: false,
			}),
		).toBeInstanceOf(ClientRequestErrorMessage);
		expect(parseServerWsMessage({ type: 'ws-fault', error: 'disconnected' })).toBeInstanceOf(
			WsFaultMessage,
		);
		expect(
			parseServerWsMessage({
				type: 'ws-pong',
				clientRequestId: 'req-ping',
				serverInstanceId: 'server-instance-test',
				sentAt: 1234,
				serverTime: '2026-06-17T00:00:00.000Z',
				processing: { outcome: 'snapshot', chats: [] },
			}),
		).toBeInstanceOf(WsPongMessage);
	});

	it('strictly validates optional run-finished and request-error fields', () => {
		expect(
			parseServerWsMessage({
				type: 'agent-run-finished',
				chatId: 'c-1',
				outcome: 'interrupted',
			}),
		).toMatchObject({ outcome: 'interrupted' });
		for (const exitCode of ['0', 1.5, null, Number.NaN]) {
			expect(
				parseServerWsMessage({
					type: 'agent-run-finished',
					chatId: 'c-1',
					exitCode,
				}),
			).toBeNull();
		}

		const validError = {
			type: 'client-request-error',
			clientRequestId: 'req-1',
			requestType: 'chat-reload',
			code: 'CHAT_RUNNING',
			message: 'Chat is running',
			retryable: true,
		};
		expect(parseServerWsMessage(validError)).toBeInstanceOf(ClientRequestErrorMessage);
		expect(parseServerWsMessage({ ...validError, chatId: 'chat-1' })).toMatchObject({
			chatId: 'chat-1',
		});
		for (const patch of [
			{ code: 'UNKNOWN' },
			{ code: undefined },
			{ message: 42 },
			{ retryable: 'false' },
			{ retryable: undefined },
			{ chatId: 42 },
			{ chatId: ' ' },
		]) {
			expect(parseServerWsMessage({ ...validError, ...patch })).toBeNull();
		}
	});

	it('strictly parses shared reconnect and pong processing outcomes', () => {
		const snapshot = parseServerWsMessage({
			type: 'reconnect-state',
			clientRequestId: 'req-reconnect',
			serverInstanceId: 'server-instance-test',
			processing: {
				outcome: 'snapshot',
				chats: [
					{ chatId: 'chat-b', phase: 'stopping' },
					{ chatId: ' chat-a ', phase: 'running' },
				],
			},
			controlResults: [],
		});
		expect(snapshot).toBeInstanceOf(ReconnectStateMessage);
		expect((snapshot as ReconnectStateMessage).processing).toEqual({
			outcome: 'snapshot',
			chats: [
				{ chatId: 'chat-b', phase: 'stopping' },
				{ chatId: 'chat-a', phase: 'running' },
			],
		});
		expect((snapshot as ReconnectStateMessage).clientRequestId).toBe('req-reconnect');
		expect((snapshot as ReconnectStateMessage).serverInstanceId).toBe('server-instance-test');

		const emptySnapshot = parseServerWsMessage({
			type: 'reconnect-state',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'snapshot', chats: [] },
			controlResults: [],
		});
		expect((emptySnapshot as ReconnectStateMessage).processing).toEqual({
			outcome: 'snapshot',
			chats: [],
		});

		const unavailable = parseServerWsMessage({
			type: 'reconnect-state',
			serverInstanceId: 'server-instance-test',
			processing: { outcome: 'unavailable' },
			controlResults: [],
		});
		expect((unavailable as ReconnectStateMessage).processing).toEqual({
			outcome: 'unavailable',
		});

		const pong = parseServerWsMessage({
			type: 'ws-pong',
			clientRequestId: 'req-ping',
			serverInstanceId: 'server-instance-test',
			sentAt: 42,
			serverTime: '2026-07-27T00:00:00.000Z',
			processing: {
				outcome: 'snapshot',
				chats: [{ chatId: 'chat-a', phase: 'stopping' }],
			},
		});
		expect(pong).toBeInstanceOf(WsPongMessage);
		expect((pong as WsPongMessage).processing).toEqual({
			outcome: 'snapshot',
			chats: [{ chatId: 'chat-a', phase: 'stopping' }],
		});
		expect((pong as WsPongMessage).serverInstanceId).toBe('server-instance-test');
		const unavailablePong = parseServerWsMessage({
			type: 'ws-pong',
			clientRequestId: 'req-ping-unavailable',
			serverInstanceId: 'server-instance-test',
			sentAt: 43,
			serverTime: '2026-07-27T00:00:00.000Z',
			processing: { outcome: 'unavailable' },
		});
		expect(unavailablePong).toBeInstanceOf(WsPongMessage);
		expect((unavailablePong as WsPongMessage).processing).toEqual({
			outcome: 'unavailable',
		});
	});

	it('rejects missing, malformed, and mixed execution-control instance identities', () => {
		const reconnect = {
			type: 'reconnect-state',
			serverInstanceId: 'server-a',
			processing: { outcome: 'snapshot', chats: [] },
			controlResults: [
				{ chatId: 'chat-1', outcome: 'snapshot', control: emptyExecutionControl(1, 'server-a') },
			],
		};
		const pong = {
			type: 'ws-pong',
			clientRequestId: 'req-ping',
			sentAt: 42,
			serverTime: '2026-07-27T00:00:00.000Z',
			processing: { outcome: 'snapshot', chats: [] },
			serverInstanceId: 'server-a',
		};

		for (const serverInstanceId of [
			undefined,
			null,
			'',
			' server-a',
			'server-a ',
			'x'.repeat(129),
		]) {
			expect(parseServerWsMessage({ ...reconnect, serverInstanceId })).toBeNull();
			expect(parseServerWsMessage({ ...pong, serverInstanceId })).toBeNull();
		}
		expect(
			parseServerWsMessage({
				type: 'reconnect-state',
				processing: { outcome: 'snapshot', chats: [] },
				controlResults: [],
			}),
		).toBeNull();
		expect(
			parseServerWsMessage({
				...reconnect,
				controlResults: [
					{
						chatId: 'chat-1',
						outcome: 'snapshot',
						control: emptyExecutionControl(1, 'server-b'),
					},
				],
			}),
		).toBeNull();
	});

	it('rejects malformed reconnect processing data and legacy session payloads', () => {
		const invalidProcessingValues: unknown[] = [
			undefined,
			null,
			[],
			'snapshot',
			{},
			{ outcome: 'unknown' },
			{ outcome: 'snapshot' },
			{ outcome: 'snapshot', chats: {} },
			{ outcome: 'snapshot', chats: [42] },
			{ outcome: 'snapshot', chats: [{ chatId: '', phase: 'running' }] },
			{ outcome: 'snapshot', chats: [{ chatId: 'chat-1', phase: 'unknown' }] },
			{
				outcome: 'snapshot',
				chats: [
					{ chatId: 'chat-1', phase: 'running' },
					{ chatId: 'chat-1', phase: 'stopping' },
				],
			},
		];

		for (const processing of invalidProcessingValues) {
			expect(
				parseServerWsMessage({
					type: 'reconnect-state',
					serverInstanceId: 'server-instance-test',
					processing,
					controlResults: [],
				}),
			).toBeNull();
			expect(
				parseServerWsMessage({
					type: 'ws-pong',
					clientRequestId: 'req-ping',
					serverInstanceId: 'server-instance-test',
					sentAt: 42,
					serverTime: '2026-07-27T00:00:00.000Z',
					processing,
				}),
			).toBeNull();
		}

		expect(
			parseServerWsMessage({
				type: 'reconnect-state',
				serverInstanceId: 'server-instance-test',
				sessions: { claude: [{ id: 'running-1' }] },
				controlResults: [],
			}),
		).toBeNull();
	});

	it('parses only known snippet invalidation reasons', () => {
		for (const reason of ['created', 'updated', 'removed']) {
			expect(parseServerWsMessage({ type: 'snippets-invalidated', reason })).toBeInstanceOf(
				SnippetsInvalidatedMessage,
			);
		}
		expect(
			parseServerWsMessage({
				type: 'agent-run-finished',
				chatId: 'c-1',
				outcome: 'failed',
			}),
		).toBeNull();
		expect(parseServerWsMessage({ type: 'snippets-invalidated', reason: 'reordered' })).toBeNull();
		expect(parseServerWsMessage({ type: 'snippets-invalidated', reason: 'renamed' })).toBeNull();
		expect(parseServerWsMessage({ type: 'snippets-invalidated' })).toBeNull();
	});

	it('rejects malformed existing stream messages', () => {
		expect(parseServerWsMessage({ type: 'agent-run-finished' })).toBeNull();
		expect(parseServerWsMessage({ type: 'agent-run-failed', chatId: 'c-1' })).toBeNull();
		expect(
			parseServerWsMessage({
				type: 'chat-list-refresh-requested',
				reason: 'mystery',
				chatId: 'c-1',
			}),
		).toBeNull();
		expect(
			parseServerWsMessage({ type: 'settings-changed', settings: { version: 'oops' } }),
		).toBeNull();
		expect(parseServerWsMessage({ type: 'ws-pong', clientRequestId: 'req-ping' })).toBeNull();
		expect(
			parseServerWsMessage({
				type: 'reconnect-state',
				serverInstanceId: 'server-instance-test',
				processing: { outcome: 'snapshot', chats: [] },
				controlResults: [{ chatId: 'c-1', outcome: 'snapshot' }],
			}),
		).toBeNull();
		expect(parseServerWsMessage({ type: 'unknown-event', data: 123 })).toBeNull();
	});
});
describe('parseClientWsMessage', () => {
	it('parses read/resume request messages', () => {
		const reconnect = parseClientWsMessage({
			type: 'reconnect-state-query',
			clientRequestId: 'req-reconnect',
			controlChatIds: ['c-1', 'c-1', '', 42, ' c-2 '],
		});
		expect(reconnect).toBeInstanceOf(ReconnectStateQueryRequest);
		expect((reconnect as ReconnectStateQueryRequest).controlChatIds).toEqual(['c-1', 'c-2']);

		const subscribe = parseClientWsMessage({
			type: 'chat-subscribe',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			transcriptViewId: 'generation-1',
			afterOrdinal: 7,
		});
		expect(subscribe).toBeInstanceOf(ChatSubscribeRequest);
		expect((subscribe as ChatSubscribeRequest).transcriptViewId).toBe('generation-1');
		expect((subscribe as ChatSubscribeRequest).afterOrdinal).toBe(7);

		expect(
			parseClientWsMessage({
				type: 'chat-reload',
				clientRequestId: 'req-reload',
				chatId: 'c-1',
			}),
		).toBeInstanceOf(ChatReloadRequest);

		const ping = parseClientWsMessage({
			type: 'ws-ping',
			clientRequestId: 'req-ping',
			sentAt: 1234,
		});
		expect(ping).toBeInstanceOf(WsPingRequest);
		expect((ping as WsPingRequest).sentAt).toBe(1234);
	});

	it('rejects malformed subscribe cursors', () => {
		const subscribe = parseClientWsMessage({
			type: 'chat-subscribe',
			clientRequestId: 'req-subscribe',
			chatId: 'c-1',
			transcriptViewId: 123,
			afterOrdinal: -1,
		});

		expect(subscribe).toBeNull();
	});

	it('rejects unknown client request messages', () => {
		expect(parseClientWsMessage({ type: 'fork-run' })).toBeNull();
		expect(
			parseClientWsMessage({
				type: 'chat-log-query',
				clientRequestId: 'req-log',
				chatId: 'c-1',
				limit: 25,
				beforeSeq: 10,
			}),
		).toBeNull();
	});
});

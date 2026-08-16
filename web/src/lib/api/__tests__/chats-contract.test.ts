import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	listChats,
	startChat,
	deleteChat,
	togglePinned,
	toggleArchive,
	markChatsReadBatch,
	reorderChat,
	forkChat,
	validateStart,
	runChat,
	generateChatTitle,
	forkRunChat,
	stopChat,
	interruptAndSendChat,
	sendPermissionDecision,
	createQueuedInput,
	replaceQueuedInput,
	deleteQueuedInput,
	moveQueuedInput,
	steerChat,
	steerQueuedEntry,
	submitGoalControl,
	getChatExecutionControl,
	clearChatQueue,
	pauseChatQueue,
	resumeChatQueue,
	updateExecutionSettings,
	updateChatModel,
	updateChatProjectPath,
	getChatMessages,
	getChatDetails,
	setLastSelectedChat,
} from '../chats';
import type { ChatListResponse } from '$shared/chat-list';
import type { CommandErrorCode } from '$shared/chat-command-contracts';
import { CHAT_STOP_OUTCOMES } from '$shared/chat-types';
import { ApiError } from '../client';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const CLAUDE_SETTINGS = {
	ownerId: 'claude',
	schemaVersion: 1,
	values: { thinkingMode: 'auto' },
} as const;

describe('chats API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	function emptyControl() {
		return {
			serverInstanceId: 'server-instance-test',
			queue: {
				entries: [],
				steeringEntryId: null,
				recentlyDispatched: [],
				pause: null,
				reorderRevision: 0,
			},
			version: 0,
			updatedAt: null,
		};
	}

	function chatEntry(id: string) {
		return {
			id,
			agentId: 'claude',
			agentOwnershipEpoch: 'epoch-1',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: CLAUDE_SETTINGS,
			title: 'Chat',
			projectPath: '/project',
			effectiveProjectKey: '/project',
			orderGroup: 'normal',
			tags: [],
			activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
			preview: { lastMessage: '' },
			isPinned: false,
			isArchived: false,
			isActive: false,
			isProcessing: true,
			processingPhase: 'running',
			isUnread: false,
			canReloadFromNativeHistory: false,
		};
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('listChats calls GET /api/v1/chats', async () => {
		const payload: ChatListResponse = {
			sessions: [
				{
					id: 'chat-1',
					agentId: 'claude',
					agentOwnershipEpoch: 'epoch-1',
					model: 'opus',
					permissionMode: 'default',
					thinkingMode: 'none',
					agentSettings: CLAUDE_SETTINGS,
					title: 'Chat 1',
					projectPath: '/repo',
					effectiveProjectKey: '/repo',
					orderGroup: 'normal',
					tags: [],
					activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
					preview: { lastMessage: '' },
					isPinned: false,
					isArchived: false,
					isActive: false,
					isProcessing: false,
					processingPhase: null,
					isUnread: false,
					canReloadFromNativeHistory: false,
				},
			],
			total: 1,
			lastSelectedChatId: 'chat-1',
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await listChats();
		expect(result).toEqual(payload);
		expect(result.sessions[0]?.permissionMode).toBe('default');

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats');
		expect(opts.method ?? 'GET').toBe('GET');
	});

	it.each([
		[true, 'running'],
		[true, 'stopping'],
		[false, null],
	] as const)(
		'round-trips the REST processing pair %s/%s',
		async (isProcessing, processingPhase) => {
			const payload = {
				sessions: [
					{
						id: 'chat-1',
						isProcessing,
						processingPhase,
					},
				],
				total: 1,
				lastSelectedChatId: 'chat-1',
			} as unknown as ChatListResponse;
			fetchMock.mockResolvedValue(jsonResponse(payload));

			await expect(listChats()).resolves.toMatchObject({
				sessions: [{ isProcessing, processingPhase }],
			});
		},
	);

	it.each([
		[false, 'running'],
		[false, 'stopping'],
		[true, null],
		[true, 'unknown'],
	])(
		'rejects the contradictory REST processing pair %s/%s',
		async (isProcessing, processingPhase) => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					sessions: [{ id: 'chat-1', isProcessing, processingPhase }],
					total: 1,
					lastSelectedChatId: 'chat-1',
				}),
			);

			await expect(listChats()).rejects.toThrow('Invalid chat list processing response');
		},
	);

	it('setLastSelectedChat sends PUT /api/v1/chats/last-selected', async () => {
		const payload = { success: true as const, lastSelectedChatId: 'chat-1' };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await setLastSelectedChat('chat-1');

		expect(result).toEqual(payload);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/last-selected');
		expect(opts.method).toBe('PUT');
		expect(JSON.parse(opts.body)).toEqual({ chatId: 'chat-1' });
	});

	it('getChatDetails returns agent session id from the details endpoint', async () => {
		const payload = {
			chatId: 'c-1',
			firstMessage: 'Hello',
			createdAt: '2026-02-20T10:00:00.000Z',
			lastActivityAt: '2026-02-21T11:00:00.000Z',
			agentSessionId: 'thread-abc',
			transcriptSource: null,
			carryOver: {
				revision: 'carry-v1:0',
				archivedMessageCount: 0,
				segments: [],
			},
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getChatDetails('c/1');

		expect(result).toEqual(payload);
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/details?chatId=c%2F1');
		expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');
	});

	it('startChat sends POST with correct shape', async () => {
		const payload = { success: true, chatId: 'c-1', chat: chatEntry('c-1') };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await startChat({
			clientRequestId: 'req-start-1',
			clientMessageId: 'msg-start-1',
			chatId: 'c-1',
			agentId: 'claude',
			projectPath: '/project',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: CLAUDE_SETTINGS,
			command: 'hello',
		});

		expect(result).toEqual(payload);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/start');
		expect(opts.method).toBe('POST');

		expect(JSON.parse(opts.body)).toEqual({
			clientRequestId: 'req-start-1',
			clientMessageId: 'msg-start-1',
			chatId: 'c-1',
			agentId: 'claude',
			projectPath: '/project',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: CLAUDE_SETTINGS,
			command: 'hello',
		});
	});

	it('startChat forwards top-level images and explicit tags', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, chat: chatEntry('c-2') }));
		const images = [{ data: 'data:image/png;base64,abc', name: 'diagram.png' }];

		await startChat({
			clientRequestId: 'req-start-2',
			clientMessageId: 'msg-start-2',
			chatId: 'c-2',
			agentId: 'claude',
			projectPath: '/p',
			model: 'm',
			permissionMode: 'acceptEdits',
			thinkingMode: 'medium',
			agentSettings: { ...CLAUDE_SETTINGS, values: { thinkingMode: 'off' } },
			command: 'test',
			images,
			tags: ['fast'],
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.permissionMode).toBe('acceptEdits');
		expect(body.thinkingMode).toBe('medium');
		expect(body.agentSettings.values.thinkingMode).toBe('off');
		expect(body.images).toEqual(images);
		expect(body).not.toHaveProperty('options');
		expect(body.tags).toEqual(['fast']);
	});

	it('startChat rejects a recovered response after the chat was deleted', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				commandType: 'chat-start',
				clientRequestId: 'req-deleted',
				chatId: 'c-deleted',
				turnId: 'turn-deleted',
				status: 'duplicate',
				acceptedAt: '2026-08-01T00:00:00.000Z',
				chat: null,
			}),
		);

		await expect(
			startChat({
				clientRequestId: 'req-deleted',
				clientMessageId: 'msg-deleted',
				chatId: 'c-deleted',
				agentId: 'claude',
				projectPath: '/project',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: CLAUDE_SETTINGS,
				command: 'hello',
			}),
		).rejects.toMatchObject({
			status: 410,
			errorCode: 'SESSION_NOT_FOUND',
		});
	});

	it('generateChatTitle sends POST /api/v1/chats/title/generate', async () => {
		const payload = { success: true as const, chatId: 'chat-1', title: 'Generated Title' };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await generateChatTitle({
			chatId: 'chat-1',
			message: 'Help debug layout',
			messageSeq: 4,
		});

		expect(result).toEqual(payload);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/title/generate');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({
			chatId: 'chat-1',
			message: 'Help debug layout',
			messageSeq: 4,
		});
	});

	it('startChat normalizes invalid mode values before sending the request', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, chat: chatEntry('c-3') }));

		await startChat({
			clientRequestId: 'req-start-3',
			clientMessageId: 'msg-start-3',
			chatId: 'c-3',
			agentId: 'claude',
			projectPath: '/p',
			model: 'm',
			permissionMode: 'bogus' as any,
			thinkingMode: 'very-hard' as any,
			agentSettings: CLAUDE_SETTINGS,
			command: 'test',
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.permissionMode).toBe('default');
		expect(body.thinkingMode).toBe('none');
		expect(body.agentSettings).toEqual(CLAUDE_SETTINGS);
	});

	it('runChat sends POST /api/v1/chats/run with command identity', async () => {
		const payload = {
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-1',
			chatId: 'c-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		};
		fetchMock.mockResolvedValue(jsonResponse(payload, 202));

		const result = await runChat({
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			command: 'hello',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: CLAUDE_SETTINGS,
			model: 'opus',
		});

		expect(result).toEqual(payload);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/run');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toMatchObject({
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			chatId: 'c-1',
			command: 'hello',
		});
	});

	it('uses the extended timeout only for a fenced agent handoff', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const response = {
			success: true as const,
			commandType: 'agent-run',
			clientRequestId: 'req-1',
			chatId: 'c-1',
			turnId: 'turn-1',
			status: 'accepted' as const,
			acceptedAt: '2026-05-14T00:00:00.000Z',
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse(response, 202))
			.mockResolvedValueOnce(jsonResponse({ ...response, chat: chatEntry('c-1') }, 202));

		await runChat({
			clientRequestId: 'req-normal',
			clientMessageId: 'msg-normal',
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			command: 'normal',
		});
		await runChat({
			clientRequestId: 'req-handoff',
			clientMessageId: 'msg-handoff',
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			command: 'handoff',
			handoff: {
				expectedAgentOwnershipEpoch: 'epoch-1',
				target: {
					agentId: 'codex',
					model: 'gpt-5.5',
					permissionMode: 'default',
					thinkingMode: 'high',
					agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
				},
			},
		});

		expect(timeout).toHaveBeenNthCalledWith(1, 30_000);
		expect(timeout).toHaveBeenNthCalledWith(2, 10 * 60_000);
	});

	it('rejects a successful handoff response without a durable chat projection', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					success: true,
					commandType: 'agent-run',
					clientRequestId: 'req-handoff',
					chatId: 'c-1',
					turnId: 'turn-1',
					status: 'accepted',
					acceptedAt: '2026-05-14T00:00:00.000Z',
				},
				202,
			),
		);

		await expect(
			runChat({
				clientRequestId: 'req-handoff',
				clientMessageId: 'msg-handoff',
				chatId: 'c-1',
				transcriptViewId: 'view-1',
				command: 'handoff',
				handoff: {
					expectedAgentOwnershipEpoch: 'epoch-1',
					target: { agentId: 'codex', model: 'gpt-5.5' },
				},
			}),
		).rejects.toThrow('durable chat projection is missing');
	});

	it('forkRunChat sends POST /api/v1/chats/fork-run', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					success: true,
					commandType: 'fork-run',
					clientRequestId: 'req-1',
					status: 'accepted',
					acceptedAt: 't',
				},
				202,
			),
		);

		await forkRunChat({
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			sourceChatId: 'c-1',
			chatId: 'c-2',
			command: 'continue',
			allowHandoffFork: true,
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: CLAUDE_SETTINGS,
			model: 'opus',
		});

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/fork-run');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toMatchObject({
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			sourceChatId: 'c-1',
			chatId: 'c-2',
			command: 'continue',
			allowHandoffFork: true,
		});
	});

	it('stopChat and permission decision send command identity payloads', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				commandType: 'agent-stop',
				clientRequestId: 'req-stop',
				status: 'accepted',
				acceptedAt: 't',
				outcome: 'interrupt-requested',
				control: emptyControl(),
			}),
		);

		await stopChat({ clientRequestId: 'req-stop', chatId: 'c-1', agentId: 'claude' });

		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/stop');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			clientRequestId: 'req-stop',
			chatId: 'c-1',
			agentId: 'claude',
		});

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				success: true,
				commandType: 'permission-decision',
				clientRequestId: 'req-perm',
				status: 'accepted',
				acceptedAt: 't',
			}),
		);

		await sendPermissionDecision({
			clientRequestId: 'req-perm',
			chatId: 'c-1',
			permissionOccurrenceId: 'incarnation-1',
			control: {
				serverInstanceId: 'server-instance-test',
				chatId: 'c-1',
				runId: 'turn-1',
				permissionOccurrenceId: 'incarnation-1',
			},
			allow: true,
			alwaysAllow: false,
			response: { outcome: { outcome: 'accepted' } },
		});

		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/chats/permissions/decision');
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			clientRequestId: 'req-perm',
			chatId: 'c-1',
			permissionOccurrenceId: 'incarnation-1',
			control: {
				serverInstanceId: 'server-instance-test',
				chatId: 'c-1',
				runId: 'turn-1',
				permissionOccurrenceId: 'incarnation-1',
			},
			allow: true,
			alwaysAllow: false,
			response: { outcome: { outcome: 'accepted' } },
		});
	});

	it('interruptAndSendChat uses a distinct command endpoint', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				commandType: 'agent-interrupt-and-send',
				clientRequestId: 'req-interrupt',
				status: 'accepted',
				acceptedAt: 't',
				outcome: 'already-idle',
				control: emptyControl(),
			}),
		);

		await interruptAndSendChat({
			clientRequestId: 'req-interrupt',
			chatId: 'c-1',
			agentId: 'claude',
		});

		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/interrupt-and-send');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			clientRequestId: 'req-interrupt',
			chatId: 'c-1',
			agentId: 'claude',
		});
	});

	it.each(CHAT_STOP_OUTCOMES)('accepts the %s Stop outcome', async (outcome) => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				commandType: 'agent-stop',
				clientRequestId: 'req-stop',
				status: 'accepted',
				acceptedAt: 't',
				outcome,
				control: emptyControl(),
			}),
		);

		await expect(
			stopChat({ clientRequestId: 'req-stop', chatId: 'c-1', agentId: 'claude' }),
		).resolves.toMatchObject({ outcome });
	});

	it('rejects missing and unknown Stop outcomes at the HTTP boundary', async () => {
		const response = {
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop',
			status: 'accepted',
			acceptedAt: 't',
			control: emptyControl(),
		};
		fetchMock
			.mockResolvedValueOnce(jsonResponse(response))
			.mockResolvedValueOnce(jsonResponse({ ...response, outcome: 'unexpected' }));

		await expect(
			stopChat({ clientRequestId: 'req-stop', chatId: 'c-1', agentId: 'claude' }),
		).rejects.toThrow('Invalid chat Stop outcome response');
		await expect(
			interruptAndSendChat({
				clientRequestId: 'req-interrupt',
				chatId: 'c-1',
				agentId: 'claude',
			}),
		).rejects.toThrow('Invalid chat Stop outcome response');
	});

	it('queue helpers use REST endpoints and encode identifiers', async () => {
		const control = emptyControl();
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ success: true, chatId: 'c/1', control })),
		);

		await getChatExecutionControl('c/1');
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/queue?chatId=c%2F1');
		expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');

		await createQueuedInput({
			clientRequestId: 'req-queue',
			clientMessageId: 'message-queue',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			content: 'queue this',
		});
		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/chats/queue/entries');
		expect(fetchMock.mock.calls[1][1].method).toBe('POST');
			expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			clientRequestId: 'req-queue',
			clientMessageId: 'message-queue',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			content: 'queue this',
		});

		await replaceQueuedInput({
			clientRequestId: 'req-replace',
			chatId: 'c/1',
			entryId: 'entry/1',
			content: 'replacement',
			expectedRevision: 3,
		});
		expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/chats/queue/entries');
		expect(fetchMock.mock.calls[2][1].method).toBe('PUT');
		expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
			clientRequestId: 'req-replace',
			chatId: 'c/1',
			entryId: 'entry/1',
			content: 'replacement',
			expectedRevision: 3,
		});

		await deleteQueuedInput({
			clientRequestId: 'req-delete',
			chatId: 'c/1',
			entryId: 'entry/1',
		});
		expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/chats/queue/entries');
		expect(fetchMock.mock.calls[3][1].method).toBe('DELETE');
		expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
			clientRequestId: 'req-delete',
			chatId: 'c/1',
			entryId: 'entry/1',
		});

		await moveQueuedInput({
			clientRequestId: 'req-move',
			chatId: 'c/1',
			entryId: 'entry/2',
			targetEntryId: 'entry/1',
			placement: 'before',
			expectedReorderRevision: 4,
			expectedSourceRevision: 2,
			expectedTargetRevision: 3,
		});
		expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/chats/queue/entries/move');
		expect(fetchMock.mock.calls[4][1].method).toBe('PUT');
		expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toEqual({
			clientRequestId: 'req-move',
			chatId: 'c/1',
			entryId: 'entry/2',
			targetEntryId: 'entry/1',
			placement: 'before',
			expectedReorderRevision: 4,
			expectedSourceRevision: 2,
			expectedTargetRevision: 3,
		});

		await submitGoalControl({
			clientRequestId: 'req-goal',
			clientMessageId: 'message-goal',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			content: '/goal pause',
		});
		expect(fetchMock.mock.calls[5][0]).toBe('/api/v1/chats/goal-control');
		expect(fetchMock.mock.calls[5][1].method).toBe('POST');

		await steerChat({
			clientRequestId: 'req-steer',
			clientMessageId: 'message-steer',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			content: 'steer now',
		});
		expect(fetchMock.mock.calls[6][0]).toBe('/api/v1/chats/steer');
		expect(fetchMock.mock.calls[6][1].method).toBe('POST');
		expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toEqual({
			clientRequestId: 'req-steer',
			clientMessageId: 'message-steer',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			content: 'steer now',
		});

		await clearChatQueue('c/1');
		await pauseChatQueue('c/1');
		await resumeChatQueue('c/1', 'pause/1');

		expect(fetchMock.mock.calls[7][0]).toBe('/api/v1/chats/queue/clear');
		expect(fetchMock.mock.calls[8][0]).toBe('/api/v1/chats/queue/pause');
		expect(fetchMock.mock.calls[9][0]).toBe('/api/v1/chats/queue/resume');
		expect(JSON.parse(fetchMock.mock.calls[9][1].body)).toEqual({
			chatId: 'c/1',
			pauseId: 'pause/1',
		});
	});

	it('posts queued steering observations without client-supplied content', async () => {
		const control = emptyControl();
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					success: true,
					commandType: 'steer',
					clientRequestId: 'request-queue-steer',
					chatId: 'c/1',
					status: 'accepted',
					acceptedAt: '2026-08-02T00:00:00.000Z',
					turnId: 'turn-active',
					serverInstanceId: control.serverInstanceId,
					control,
				},
				202,
			),
		);

		await expect(
			steerQueuedEntry({
				clientRequestId: 'request-queue-steer',
				chatId: 'c/1',
				transcriptViewId: 'view-1',
				entryId: 'entry/1',
				expectedRevision: 3,
				expectedReorderRevision: 7,
			}),
		).resolves.toMatchObject({ control });

		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/queue/entries/steer');
		expect(fetchMock.mock.calls[0][1].method).toBe('POST');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			clientRequestId: 'request-queue-steer',
			chatId: 'c/1',
			transcriptViewId: 'view-1',
			entryId: 'entry/1',
			expectedRevision: 3,
			expectedReorderRevision: 7,
		});
	});

	it('rejects malformed present queue-steer control snapshots', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					success: true,
					commandType: 'steer',
					clientRequestId: 'request-queue-steer',
					chatId: 'c-1',
					status: 'accepted',
					acceptedAt: '2026-08-02T00:00:00.000Z',
					turnId: 'turn-active',
					serverInstanceId: 'server-instance-test',
					control: { ...emptyControl(), queue: { entries: [] } },
				},
				202,
			),
		);

		await expect(
			steerQueuedEntry({
				clientRequestId: 'request-queue-steer',
				chatId: 'c-1',
				transcriptViewId: 'view-1',
				entryId: 'entry-1',
				expectedRevision: 3,
				expectedReorderRevision: 7,
			}),
		).rejects.toThrow('Invalid queued steer execution control response');
	});

	it('rejects missing or mismatched queued-steer server identities', async () => {
		const response = {
			success: true,
			commandType: 'steer',
			clientRequestId: 'request-queue-steer',
			chatId: 'c-1',
			status: 'accepted',
			acceptedAt: '2026-08-02T00:00:00.000Z',
			turnId: 'turn-active',
			control: emptyControl(),
		};
		const request = {
			clientRequestId: 'request-queue-steer',
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			entryId: 'entry-1',
			expectedRevision: 3,
			expectedReorderRevision: 7,
		};
		fetchMock.mockResolvedValueOnce(jsonResponse(response, 202));
		await expect(steerQueuedEntry(request)).rejects.toThrow(
			'Invalid queued steer server instance response',
		);

		fetchMock.mockResolvedValueOnce(
			jsonResponse({ ...response, serverInstanceId: 'server-other' }, 202),
		);
		await expect(steerQueuedEntry(request)).rejects.toThrow(
			'Mismatched queued steer server instance response',
		);
	});

	it('rejects queue controls without a bounded opaque server instance ID', async () => {
		for (const serverInstanceId of [
			undefined,
			null,
			'',
			' server-a',
			'server-a ',
			'x'.repeat(129),
		]) {
			fetchMock.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					chatId: 'chat-1',
					control: { ...emptyControl(), serverInstanceId },
				}),
			);
			await expect(getChatExecutionControl('chat-1')).rejects.toThrow(
				'Invalid chat execution control response',
			);
		}
	});

	it('settings, model, project path, and history helpers use REST endpoints', async () => {
		fetchMock.mockImplementation((url: string) => {
			const requestUrl = new URL(url, 'http://garcon.local');
			const beforeOrdinal = requestUrl.searchParams.get('beforeOrdinal');
			const pageNewestOrdinal = beforeOrdinal === null ? 0 : Number(beforeOrdinal) - 1;
			return Promise.resolve(
				jsonResponse(
					url.startsWith('/api/v1/chats/messages')
						? {
								historyState: { kind: 'complete' },
								chatId: requestUrl.searchParams.get('chatId'),
								messages: [],
								transcriptViewId: 'view-1',
								lastOrdinal: pageNewestOrdinal,
								pageOldestOrdinal: 0,
								pageNewestOrdinal,
								nextBeforeOrdinal: null,
								resendCandidates: [],
								hasMore: false,
								limit: 50,
							}
						: { success: true },
				),
			);
		});

		await updateExecutionSettings({ chatId: 'c-1', permissionMode: 'manualBypass' });
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/execution-settings');
		expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			chatId: 'c-1',
			permissionMode: 'manualBypass',
		});

		await updateChatModel({
			chatId: 'c-1',
			model: 'endpoint:model',
			apiProviderId: 'provider',
			modelEndpointId: 'endpoint',
			modelProtocol: 'openai-compatible',
		});
		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/chats/model');
		expect(fetchMock.mock.calls[1][1].method).toBe('PATCH');

		await updateChatProjectPath({ chatId: 'c-1', projectPath: '/workspace/repo-worktree' });
		expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/chats/project-path');
		expect(fetchMock.mock.calls[2][1].method).toBe('PATCH');
		expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
			chatId: 'c-1',
			projectPath: '/workspace/repo-worktree',
		});

		const messages = await getChatMessages({
			chatId: 'c/1',
			limit: 50,
			beforeOrdinal: 20,
			transcriptViewId: 'view-1',
		});
		expect(fetchMock.mock.calls[3][0]).toBe(
			'/api/v1/chats/messages?chatId=c%2F1&limit=50&beforeOrdinal=20&transcriptViewId=view-1',
		);
		expect(fetchMock.mock.calls[3][1].method ?? 'GET').toBe('GET');
		expect(messages).toMatchObject({
			historyState: { kind: 'complete' },
			transcriptViewId: 'view-1',
		});

		await getChatMessages({ chatId: 'c/2' });
		expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/chats/messages?chatId=c%2F2&limit=50');
	});

	it('rejects malformed chat message page metadata', async () => {
		const validPage = {
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [],
			transcriptViewId: 'view-1',
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			resendCandidates: [],
			hasMore: false,
			limit: 20,
		};

		const cases: Array<[string, Record<string, unknown>]> = [
			['chatId', { chatId: '' }],
			['transcriptViewId', { transcriptViewId: '' }],
			['lastOrdinal', { lastOrdinal: '0' }],
			['pageOldestOrdinal', { pageOldestOrdinal: -1 }],
			['pageNewestOrdinal', { pageNewestOrdinal: -1 }],
			['nextBeforeOrdinal', { nextBeforeOrdinal: undefined }],
			['resendCandidates', { resendCandidates: [{ ordinal: 1 }] }],
			['hasMore', { hasMore: 'false' }],
			['limit', { limit: 0 }],
		];

		for (const [fieldName, patch] of cases) {
			fetchMock.mockResolvedValueOnce(jsonResponse({ ...validPage, ...patch }));

			await expect(getChatMessages({ chatId: 'c-1' })).rejects.toThrow(fieldName);
		}
	});

	it('[TLV5-PAGE.09-WEB-CONTRACT-01] accepts an all-hidden raw page with a strict continuation', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [],
			transcriptViewId: 'view-1',
			lastOrdinal: 300,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 250,
			nextBeforeOrdinal: 201,
			resendCandidates: [],
			hasMore: true,
			limit: 50,
		}));

		await expect(getChatMessages({
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			beforeOrdinal: 251,
			limit: 50,
		})).resolves.toMatchObject({
			messages: [],
			pageNewestOrdinal: 250,
			nextBeforeOrdinal: 201,
			hasMore: true,
		});
	});

	it('[TLV5-PAGE.08-WEB-CONTRACT-01] accepts a server-clamped raw interval ceiling', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [],
			transcriptViewId: 'view-1',
			lastOrdinal: 250,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 250,
			nextBeforeOrdinal: 201,
			resendCandidates: [],
			hasMore: true,
			limit: 50,
		}));

		await expect(getChatMessages({
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			beforeOrdinal: 999,
			limit: 50,
		})).resolves.toMatchObject({
			lastOrdinal: 250,
			pageNewestOrdinal: 250,
			nextBeforeOrdinal: 201,
			hasMore: true,
		});
	});

	it('[TLV5-PAGE.10-WEB-CONTRACT-01] rejects malformed or stalled raw continuations', async () => {
		const validPage = {
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [],
			transcriptViewId: 'view-1',
			lastOrdinal: 300,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 250,
			nextBeforeOrdinal: 201,
			resendCandidates: [],
			hasMore: true,
			limit: 50,
		};
		const request = {
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			beforeOrdinal: 251,
			limit: 50,
		} satisfies Parameters<typeof getChatMessages>[0];

		for (const patch of [
			{ nextBeforeOrdinal: null },
			{ nextBeforeOrdinal: null, hasMore: false },
			{ nextBeforeOrdinal: 0 },
			{ nextBeforeOrdinal: 2 },
			{ nextBeforeOrdinal: 251 },
			{ nextBeforeOrdinal: 201, hasMore: false },
		]) {
			fetchMock.mockResolvedValueOnce(jsonResponse({ ...validPage, ...patch }));
			await expect(getChatMessages(request)).rejects.toThrow('Invalid chat messages page');
		}
	});

	it('[TLV5-PAGE.01-WEB-CONTRACT-01] qualifies transcript page requests by view and validates the response against the request', async () => {
		const message = (ordinal: number, content: string) => ({
			ordinal,
			message: {
				type: 'assistant-message',
				timestamp: '2026-08-15T00:00:00.000Z',
				content,
			},
		});
		const validPage = {
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [message(40, 'earlier'), message(49, 'later')],
			transcriptViewId: 'view-1',
			lastOrdinal: 100,
			pageOldestOrdinal: 40,
			pageNewestOrdinal: 49,
			nextBeforeOrdinal: 30,
			resendCandidates: [],
			hasMore: true,
			limit: 20,
		};
		const request = {
			chatId: 'c-1',
			transcriptViewId: 'view-1',
			limit: 20,
			beforeOrdinal: 50,
		} satisfies Parameters<typeof getChatMessages>[0];
		fetchMock.mockResolvedValueOnce(jsonResponse(validPage));

		await getChatMessages(request);

		expect(fetchMock.mock.calls[0][0]).toBe(
			'/api/v1/chats/messages?chatId=c-1&limit=20&beforeOrdinal=50&transcriptViewId=view-1',
		);

		const invalidResponses = [
			{ ...validPage, chatId: 'another-chat' },
			{ ...validPage, transcriptViewId: 'another-view' },
			{ ...validPage, limit: 19 },
			{ ...validPage, pageNewestOrdinal: 50 },
			{ ...validPage, pageOldestOrdinal: 51, pageNewestOrdinal: 49 },
			{ ...validPage, lastOrdinal: 48 },
			{ ...validPage, messages: [message(49, 'later'), message(40, 'earlier')] },
			{ ...validPage, messages: [message(40, 'first'), message(40, 'duplicate')] },
			{ ...validPage, messages: [message(40, 'earlier'), message(50, 'outside range')] },
			{ ...validPage, messages: [message(41, 'wrong lower bound'), message(49, 'later')] },
			{ ...validPage, pageOldestOrdinal: 0 },
			{ ...validPage, messages: [], pageOldestOrdinal: 40 },
		];
		for (const response of invalidResponses) {
			fetchMock.mockResolvedValueOnce(jsonResponse(response));
			await expect(getChatMessages(request)).rejects.toThrow('Invalid chat messages page');
		}
	});

	it('qualifies a newest-page refresh when the caller already owns a transcript view', async () => {
		const validPage = {
			historyState: { kind: 'complete' },
			chatId: 'c-1',
			messages: [],
			transcriptViewId: 'view-1',
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			resendCandidates: [],
			hasMore: false,
			limit: 20,
		};
		const request = {
			chatId: 'c-1',
			limit: 20,
			transcriptViewId: 'view-1',
		} satisfies Parameters<typeof getChatMessages>[0];
		fetchMock.mockResolvedValueOnce(jsonResponse(validPage));

		await getChatMessages(request);

		expect(fetchMock.mock.calls[0][0]).toBe(
			'/api/v1/chats/messages?chatId=c-1&limit=20&transcriptViewId=view-1',
		);

		fetchMock.mockResolvedValueOnce(
			jsonResponse({ ...validPage, transcriptViewId: 'replacement-view' }),
		);
		await expect(getChatMessages(request)).rejects.toThrow(
			'transcriptViewId does not match request',
		);
	});

	it('accepts the server-clamped effective page limit', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				historyState: { kind: 'complete' },
				chatId: 'c-1',
				messages: [],
				transcriptViewId: 'view-1',
				lastOrdinal: 0,
				pageOldestOrdinal: 0,
				pageNewestOrdinal: 0,
				nextBeforeOrdinal: null,
				resendCandidates: [],
				hasMore: false,
				limit: 200,
			}),
		);

		await expect(getChatMessages({ chatId: 'c-1', limit: 999_999 })).resolves.toMatchObject({
			chatId: 'c-1',
			limit: 200,
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			'/api/v1/chats/messages?chatId=c-1&limit=999999',
		);
	});

	it('accepts degraded history only without sequence metadata', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				historyState: {
					kind: 'degraded',
					errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
					retryable: false,
				},
				chatId: 'c-1',
				messages: [],
			}),
		);

		await expect(getChatMessages({ chatId: 'c-1' })).resolves.toEqual({
			historyState: {
				kind: 'degraded',
				errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
				retryable: false,
			},
			chatId: 'c-1',
			messages: [],
		});

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				historyState: {
					kind: 'degraded',
					errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
					retryable: false,
				},
				chatId: 'c-1',
				messages: [],
				lastOrdinal: 0,
			}),
		);
		await expect(getChatMessages({ chatId: 'c-1' })).rejects.toThrow('lastOrdinal');
	});

	it('deleteChat sends chatId in the JSON body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await deleteChat('chat/special');

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats');
		expect(opts.method).toBe('DELETE');
		expect(JSON.parse(opts.body)).toEqual({ chatId: 'chat/special' });
	});

	it('togglePinned sends chatId in the JSON body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, isPinned: true }));

		const result = await togglePinned('c-1');

		expect(result).toEqual({ success: true, isPinned: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/pin');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ chatId: 'c-1' });
	});

	it('toggleArchive sends chatId in the JSON body', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, isArchived: true }));

		const result = await toggleArchive('c-1');

		expect(result).toEqual({ success: true, isArchived: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/archive');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ chatId: 'c-1' });
	});

	it('markChatsReadBatch sends entries array', async () => {
		const response = {
			success: true,
			results: [{ chatId: 'c-1', lastReadAt: '2025-01-01T00:00:00Z' }],
		};
		fetchMock.mockResolvedValue(jsonResponse(response));

		const entries = [{ chatId: 'c-1', lastReadAt: '2025-01-01T00:00:00Z' }];
		const result = await markChatsReadBatch(entries);

		expect(result).toEqual(response);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.entries).toEqual(entries);
	});

	it('reorderChat sends and parses a boundary placement', async () => {
		const result = {
			success: true as const,
			chatId: 'c-1',
			orderGroup: 'normal' as const,
			changed: true,
		};
		fetchMock.mockResolvedValue(jsonResponse(result));

		await expect(
			reorderChat({
				chatId: 'c-1',
				placement: { kind: 'boundary', boundary: 'top' },
			}),
		).resolves.toEqual(result);

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/reorder');
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({
			chatId: 'c-1',
			placement: { kind: 'boundary', boundary: 'top' },
		});
	});

	it('reorderChat sends a relative placement', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				success: true,
				chatId: 'c-1',
				orderGroup: 'pinned',
				changed: false,
			}),
		);

		await reorderChat({
			chatId: 'c-1',
			placement: { kind: 'relative', referenceChatId: 'c-2', position: 'before' },
		});

		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			chatId: 'c-1',
			placement: { kind: 'relative', referenceChatId: 'c-2', position: 'before' },
		});
	});

	for (const [name, response] of [
		['missing chat ID', { success: true, orderGroup: 'normal', changed: true }],
		['invalid group', { success: true, chatId: 'c-1', orderGroup: 'orphan', changed: true }],
		[
			'invalid changed value',
			{ success: true, chatId: 'c-1', orderGroup: 'normal', changed: 'yes' },
		],
	] as const) {
		it(`rejects a reorder response with ${name}`, async () => {
			fetchMock.mockResolvedValue(jsonResponse(response));

			await expect(
				reorderChat({
					chatId: 'c-1',
					placement: { kind: 'boundary', boundary: 'bottom' },
				}),
			).rejects.toThrow('Invalid chat reorder response');
		});
	}

	it('forkChat sends POST with sourceChatId and chatId', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ success: true, sourceChatId: '1', chatId: '2', agentId: 'claude' }),
		);

		const result = await forkChat({ sourceChatId: '1', chatId: '2' });

		expect(result.success).toBe(true);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/fork');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ sourceChatId: '1', chatId: '2' });
	});

	it('forkChat surfaces retryable transcript-persistence refusals', async () => {
		const errorCode = 'TRANSCRIPT_NOT_YET_PERSISTED' satisfies CommandErrorCode;
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					success: false,
					error: "This chat's transcript hasn't been written yet. Try the fork again in a moment.",
					errorCode,
					retryable: true,
				},
				409,
			),
		);

		let failure: unknown;
		try {
			await forkChat({ sourceChatId: '1', chatId: '2' });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ApiError);
		expect(failure).toMatchObject({
			status: 409,
			message: "This chat's transcript hasn't been written yet. Try the fork again in a moment.",
			errorCode,
			retryable: true,
		});
	});

	it('forkChat sends an optional view-bound message cutoff', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ success: true, sourceChatId: '1', chatId: '2', agentId: 'codex' }),
		);

		await forkChat({
			sourceChatId: '1',
			chatId: '2',
			upToOrdinal: 7,
			transcriptViewId: 'view-1',
		});

		const [, opts] = fetchMock.mock.calls[0];
		expect(JSON.parse(opts.body)).toEqual({
			sourceChatId: '1',
			chatId: '2',
			upToOrdinal: 7,
			transcriptViewId: 'view-1',
		});
	});

	it('forkChat sends handoff-fork consent only when the user has given it', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ success: true, sourceChatId: '1', chatId: '2', agentId: 'codex' }),
		);

		await forkChat({
			sourceChatId: '1',
			chatId: '2',
			upToOrdinal: 7,
			transcriptViewId: 'view-1',
			allowHandoffFork: true,
		});

		const [, opts] = fetchMock.mock.calls[0];
		expect(JSON.parse(opts.body)).toEqual({
			sourceChatId: '1',
			chatId: '2',
			upToOrdinal: 7,
			transcriptViewId: 'view-1',
			allowHandoffFork: true,
		});
	});

	it('validateStart calls GET /api/v1/chats/validate-start', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ valid: true, isGitRepo: true }));
		const controller = new AbortController();

		const result = await validateStart('/repo', { signal: controller.signal });

		expect(result).toEqual({ valid: true, isGitRepo: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/validate-start?path=%2Frepo');
		expect(opts.method ?? 'GET').toBe('GET');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it('validateStart returns structured invalid payloads on 200', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ valid: false, error: 'Path does not exist', errorCode: 'path_not_found' }),
		);

		const result = await validateStart('/missing');

		expect(result).toEqual({
			valid: false,
			error: 'Path does not exist',
			errorCode: 'path_not_found',
		});
	});
});

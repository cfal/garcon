import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	listChats,
	startChat,
	deleteChat,
	togglePinned,
	toggleArchive,
	markChatsReadBatch,
	reorderChats,
	reorderChatsQuick,
	forkChat,
	validateStart,
	runChat,
	forkRunChat,
	stopChat,
	sendPermissionDecision,
	enqueueChatMessage,
	getChatQueue,
	dequeueChatMessage,
	clearChatQueue,
	pauseChatQueue,
	resumeChatQueue,
	updateExecutionSettings,
	updateChatModel,
	getRunningChats,
	getChatMessages,
} from '../chats';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('chats API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('listChats calls GET /api/v1/chats', async () => {
		const payload = { sessions: [], total: 0 };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await listChats();
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats');
		expect(opts.method ?? 'GET').toBe('GET');
	});

	it('startChat sends POST with correct shape', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, chatId: 'c-1' }));

		const result = await startChat({
			chatId: 'c-1',
			agentId: 'claude',
			projectPath: '/project',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
			command: 'hello',
		});

		expect(result).toEqual({ success: true, chatId: 'c-1' });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/start');
		expect(opts.method).toBe('POST');

		const body = JSON.parse(opts.body);
		expect(body.chatId).toBe('c-1');
		expect(body.agentId).toBe('claude');
		expect(body.permissionMode).toBe('default');
		expect(body.thinkingMode).toBe('none');
		expect(body.claudeThinkingMode).toBe('auto');
		expect(body.command).toBe('hello');
		expect(body.options).toEqual({});
		expect(body.tags).toEqual([]);
	});

	it('startChat forwards options and tags', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await startChat({
			chatId: 'c-2',
			agentId: 'claude',
			projectPath: '/p',
			model: 'm',
			permissionMode: 'acceptEdits',
			thinkingMode: 'think-hard',
			claudeThinkingMode: 'off',
			ampAgentMode: 'smart',
			command: 'test',
			options: { cwd: '/p' },
			tags: ['fast'],
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.permissionMode).toBe('acceptEdits');
		expect(body.thinkingMode).toBe('think-hard');
		expect(body.claudeThinkingMode).toBe('off');
		expect(body.options).toEqual({ cwd: '/p' });
		expect(body.tags).toEqual(['fast']);
	});

	it('startChat normalizes invalid mode values before sending the request', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await startChat({
			chatId: 'c-3',
			agentId: 'claude',
			projectPath: '/p',
			model: 'm',
			permissionMode: 'bogus' as any,
			thinkingMode: 'very-hard' as any,
			claudeThinkingMode: 'sometimes' as any,
			ampAgentMode: 'smart',
			command: 'test',
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.permissionMode).toBe('default');
		expect(body.thinkingMode).toBe('none');
		expect(body.claudeThinkingMode).toBe('auto');
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
			command: 'hello',
			permissionMode: 'default',
			thinkingMode: 'none',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
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
			permissionMode: 'default',
			thinkingMode: 'none',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
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
				stopped: true,
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
			permissionRequestId: 'perm-1',
			allow: true,
			alwaysAllow: false,
		});

		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/chats/permissions/decision');
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			clientRequestId: 'req-perm',
			chatId: 'c-1',
			permissionRequestId: 'perm-1',
			allow: true,
			alwaysAllow: false,
		});
	});

	it('queue helpers use REST endpoints and encode identifiers', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				jsonResponse({ success: true, chatId: 'c/1', queue: { entries: [], paused: false } }),
			),
		);

		await getChatQueue('c/1');
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/queue?chatId=c%2F1');
		expect(fetchMock.mock.calls[0][1].method ?? 'GET').toBe('GET');

		await enqueueChatMessage({ clientRequestId: 'req-queue', chatId: 'c/1', content: 'queued' });
		expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/chats/queue/enqueue');
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			clientRequestId: 'req-queue',
			chatId: 'c/1',
			content: 'queued',
		});

		await dequeueChatMessage('c/1', 'entry/1');
		await clearChatQueue('c/1');
		await pauseChatQueue('c/1');
		await resumeChatQueue('c/1');

		expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/chats/queue/dequeue');
		expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
			chatId: 'c/1',
			entryId: 'entry/1',
		});
		expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/chats/queue/clear');
		expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/chats/queue/pause');
		expect(fetchMock.mock.calls[5][0]).toBe('/api/v1/chats/queue/resume');
	});

	it('settings, model, running, and history helpers use REST endpoints', async () => {
		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ success: true })));

		await updateExecutionSettings({ chatId: 'c-1', permissionMode: 'acceptEdits' });
		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/chats/execution-settings');
		expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			chatId: 'c-1',
			permissionMode: 'acceptEdits',
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

		await getRunningChats();
		expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/chats/running');
		expect(fetchMock.mock.calls[2][1].method ?? 'GET').toBe('GET');

		await getChatMessages({ chatId: 'c/1', limit: 50, offset: 20 });
		expect(fetchMock.mock.calls[3][0]).toBe(
			'/api/v1/chats/messages?chatId=c%2F1&limit=50&offset=20',
		);
		expect(fetchMock.mock.calls[3][1].method ?? 'GET').toBe('GET');
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

	it('reorderChats sends list, oldOrder, newOrder', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await reorderChats({
			list: 'normal',
			oldOrder: ['a', 'b'],
			newOrder: ['b', 'a'],
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.list).toBe('normal');
		expect(body.oldOrder).toEqual(['a', 'b']);
		expect(body.newOrder).toEqual(['b', 'a']);
	});

	it('reorderChatsQuick sends chatId with an above neighbor', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await reorderChatsQuick({ chatId: 'c-1', chatIdAbove: 'c-0' });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.chatId).toBe('c-1');
		expect(body.chatIdAbove).toBe('c-0');
	});

	it('reorderChatsQuick sends chatId with a below neighbor', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await reorderChatsQuick({ chatId: 'c-1', chatIdBelow: 'c-2' });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.chatId).toBe('c-1');
		expect(body.chatIdBelow).toBe('c-2');
	});

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

	it('validateStart calls GET /api/v1/chats/validate-start', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ valid: true, isGitRepo: true }));

		const result = await validateStart('/repo');

		expect(result).toEqual({ valid: true, isGitRepo: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/validate-start?path=%2Frepo');
		expect(opts.method ?? 'GET').toBe('GET');
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

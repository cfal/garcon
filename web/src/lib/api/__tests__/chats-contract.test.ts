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
			provider: 'claude',
			projectPath: '/project',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			command: 'hello',
		});

		expect(result).toEqual({ success: true, chatId: 'c-1' });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/start');
		expect(opts.method).toBe('POST');

		const body = JSON.parse(opts.body);
		expect(body.chatId).toBe('c-1');
		expect(body.provider).toBe('claude');
		expect(body.permissionMode).toBe('default');
		expect(body.thinkingMode).toBe('none');
		expect(body.command).toBe('hello');
		expect(body.options).toEqual({});
		expect(body.tags).toEqual([]);
	});

	it('startChat forwards options and tags', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await startChat({
			chatId: 'c-2',
			provider: 'claude',
			projectPath: '/p',
			model: 'm',
			permissionMode: 'acceptEdits',
			thinkingMode: 'think-hard',
			command: 'test',
			options: { cwd: '/p' },
			tags: ['fast'],
		});

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.permissionMode).toBe('acceptEdits');
		expect(body.thinkingMode).toBe('think-hard');
		expect(body.options).toEqual({ cwd: '/p' });
		expect(body.tags).toEqual(['fast']);
	});

	it('deleteChat encodes chatId in query string', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await deleteChat('chat/special');

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats?chatId=chat%2Fspecial');
		expect(opts.method).toBe('DELETE');
	});

	it('togglePinned calls POST with chatId query param', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, isPinned: true }));

		const result = await togglePinned('c-1');

		expect(result).toEqual({ success: true, isPinned: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/pin?chatId=c-1');
		expect(opts.method).toBe('POST');
	});

	it('toggleArchive calls POST with chatId query param', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, isArchived: true }));

		const result = await toggleArchive('c-1');

		expect(result).toEqual({ success: true, isArchived: true });
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/chats/archive?chatId=c-1');
		expect(opts.method).toBe('POST');
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

	it('reorderChatsQuick sends chatId with optional neighbors', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await reorderChatsQuick({ chatId: 'c-1', chatIdAbove: 'c-0' });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.chatId).toBe('c-1');
		expect(body.chatIdAbove).toBe('c-0');
	});

	it('forkChat sends POST with sourceChatId and chatId', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, sourceChatId: '1', chatId: '2', provider: 'claude' }));

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
			jsonResponse({ valid: false, error: 'Path does not exist', errorCode: 'path_not_found' })
		);

		const result = await validateStart('/missing');

		expect(result).toEqual({
			valid: false,
			error: 'Path does not exist',
			errorCode: 'path_not_found'
		});
	});
});

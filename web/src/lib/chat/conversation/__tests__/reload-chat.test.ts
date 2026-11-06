import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadChatFromNative, type ChatReloadOptions, type ChatReloadPort } from '../reload-chat.js';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { displayOpen, displayRow, mockDisplayApi } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import type { WsRequestProgress } from '$lib/ws/connection.svelte.js';
import { WsRequestError } from '$lib/ws/ws-request-error.js';

function wsWithResponse(response: Record<string, unknown> | Promise<Record<string, unknown>>) {
	const requests: WsRequestProgress[] = [];
	const ws = {
		sendProgressRequest: vi.fn((_message: object, progress: WsRequestProgress) => {
			requests.push(progress);
			return { clientRequestId: 'req-1', response: Promise.resolve(response) };
		}),
		sendMessage: vi.fn(() => true),
	} satisfies ChatReloadPort;
	return Object.assign(ws, { progress: () => requests[0]! });
}

function options(overrides: Partial<ChatReloadOptions> = {}): ChatReloadOptions {
	return { signal: new AbortController().signal, onProgress: vi.fn(), ...overrides };
}
const replacement = { type: 'chat-reloaded', clientRequestId: 'req-1', chatId: 'chat-1', transcriptViewId: 'generation-2', lastOrdinal: 100 };
let chat: ActiveTranscriptState;
let api: ReturnType<typeof mockDisplayApi>;
beforeEach(() => {
	api = mockDisplayApi(Array.from({ length: 100 }, (_, index) => displayRow(index + 1)), displayOpen('chat-1', 'generation-2', 100));
	chat = new ActiveTranscriptState();
	chat.activateChat('chat-1');
});
afterEach(() => { chat.dispose(); vi.restoreAllMocks(); });

describe('reloadChatFromNative', () => {
	it('leaves replacement projection to the registry rather than reopening a single transcript', async () => {
		const ws = wsWithResponse(replacement);
		await chat.loadMessages('chat-1');
		api.open.mockClear();
		const clear = vi.spyOn(chat, 'clearMessages');
		await expect(reloadChatFromNative(ws, 'chat-1', options())).resolves.toBe('reloaded');
		expect(ws.sendProgressRequest).toHaveBeenCalledWith(
			{ type: 'chat-reload', chatId: 'chat-1' },
			expect.objectContaining({ type: 'chat-reload-progress', idleTimeoutMs: 30_000 }),
		);
		expect(api.open).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		expect(chat.getCursor()).toEqual({ transcriptViewId: 'generation-2', lastOrdinal: 100 });
		expect(chat.entries.map(row => row.ordinal)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
		expect(chat.hasEarlierMessages).toBe(true);
		await expect(chat.loadEarlierPage('chat-1')).resolves.toBe('loaded');
		expect(api.window.mock.calls.at(-1)?.[0]).toMatchObject({ transcriptViewId: 'generation-2', anchor: { kind: 'before' } });
		expect(chat.entries).toHaveLength(100);
		expect(chat.hasEarlierMessages).toBe(false);
	});

	it.each([
		{ type: 'chat-subscribe', chatId: 'chat-1' },
		{ ...replacement, chatId: 'chat-other' },
		{ ...replacement, lastOrdinal: -1 },
		{ ...replacement, transcriptViewId: '' },
	])('keeps the admitted view when reload identity is malformed or unrelated', async response => {
		chat.installOpen(displayOpen('chat-1', 'generation-1', 10));
		await expect(reloadChatFromNative(wsWithResponse(response), 'chat-1', options())).rejects.toThrow('Unexpected chat reload response');
		expect(chat.transcriptViewId).toBe('generation-1');
		expect(api.open).not.toHaveBeenCalled();
	});

	it('does not retarget a replacement after switching chats', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), 'chat-1', options());
		chat.activateChat('chat-2');
		response.resolve(replacement);
		await expect(reloading).resolves.toBe('reloaded');
		expect(chat.activeChatId).toBe('chat-2');
		expect(api.open).not.toHaveBeenCalled();
	});

	it('forwards only well-formed progress for the reloading chat', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const onProgress = vi.fn();
		const reloading = reloadChatFromNative(ws, 'chat-1', options({ onProgress }));
		for (const [chatId, phase, rows] of [['chat-1', 'reading', 1200], ['chat-2', 'saving', 5], ['chat-1', 'unknown', 5]]) {
			ws.progress().onProgress({ type: 'chat-reload-progress', clientRequestId: 'req-1', chatId, phase, rows });
		}
		response.reject(new Error('stop'));
		await expect(reloading).rejects.toThrow('stop');
		expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'reading', rows: 1200 });
	});

	it('asks the server to cancel and reports a confirmed cancellation without reopening', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const ws = wsWithResponse(response.promise);
		const cancellation = new AbortController();
		const reloading = reloadChatFromNative(ws, 'chat-1', options({ signal: cancellation.signal }));
		cancellation.abort();
		expect(ws.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			type: 'chat-reload-cancel', chatId: 'chat-1', reloadRequestId: 'req-1',
		}));
		response.reject(new WsRequestError('REQUEST_CANCELLED', 'Reload cancelled', true));
		await expect(reloading).resolves.toBe('cancelled');
		expect(api.open).not.toHaveBeenCalled();
	});

	it('reports a reload that completed despite a late cancellation without a second open', async () => {
		const response = Promise.withResolvers<Record<string, unknown>>();
		const cancellation = new AbortController();
		const reloading = reloadChatFromNative(wsWithResponse(response.promise), 'chat-1', options({ signal: cancellation.signal }));
		cancellation.abort(); response.resolve(replacement);
		await expect(reloading).resolves.toBe('reloaded');
		expect(api.open).not.toHaveBeenCalled();
	});
});

import { describe, expect, it, vi } from 'vitest';
import type { ChatReloadOptions, ChatReloadOutcome } from '$lib/chat/conversation/reload-chat.js';
import { ReloadChatDialogState } from '../reload-chat-dialog-state.svelte.js';

const CANDIDATES = [{ ordinal: 3, preview: 'unsent', timestamp: '2026-01-01T00:00:00.000Z', attachmentCount: 0 }];

describe('ReloadChatDialogState', () => {
	it('settles a dismissed confirmation without running a reload', async () => {
		const dialog = new ReloadChatDialogState();
		const requested = dialog.request('chat-1', CANDIDATES);

		expect(dialog.open).toBe(true);
		expect(dialog.chatId).toBe('chat-1');
		expect(dialog.candidates).toEqual(CANDIDATES);
		dialog.cancel();

		await expect(requested).resolves.toBeUndefined();
		expect(dialog.open).toBe(false);
	});

	it('captures summary uncertainty and the full removal count with the confirmation', async () => {
		const dialog = new ReloadChatDialogState();
		const requested = dialog.request('chat-1', CANDIDATES, { total: 80, incomplete: true });
		expect(dialog.candidates).toEqual(CANDIDATES);
		expect(dialog.totalCandidates).toBe(80);
		expect(dialog.summaryIncomplete).toBe(true);
		dialog.cancel();
		await requested;
		expect(dialog.summaryIncomplete).toBe(false);
	});

	it('tracks progress while running and settles after the reload', async () => {
		const dialog = new ReloadChatDialogState();
		const requested = dialog.request('chat-1', []);
		const finished = Promise.withResolvers<ChatReloadOutcome>();
		let reported: ChatReloadOptions | null = null;

		const confirming = dialog.confirm(async (_chatId, options) => {
			reported = options;
			return finished.promise;
		});
		reported!.onProgress({ phase: 'reading', rows: 120 });

		expect(dialog.running).toBe(true);
		expect(dialog.progress).toEqual({ phase: 'reading', rows: 120 });
		finished.resolve('reloaded');
		await confirming;

		await expect(requested).resolves.toBeUndefined();
		expect(dialog.open).toBe(false);
		expect(dialog.running).toBe(false);
		expect(dialog.progress).toBeNull();
	});

	it('turns cancel into a stop request while a reload runs', async () => {
		const dialog = new ReloadChatDialogState();
		const requested = dialog.request('chat-1', []);
		const finished = Promise.withResolvers<ChatReloadOutcome>();
		let signal: AbortSignal | null = null;

		const confirming = dialog.confirm(async (_chatId, options) => {
			signal = options.signal;
			return finished.promise;
		});
		dialog.cancel();

		expect(signal!.aborted).toBe(true);
		expect(dialog.cancelling).toBe(true);
		expect(dialog.open).toBe(true);
		finished.resolve('cancelled');
		await confirming;

		await expect(requested).resolves.toBeUndefined();
		expect(dialog.cancelling).toBe(false);
	});

	it('fails the request when the reload fails', async () => {
		const dialog = new ReloadChatDialogState();
		const requested = dialog.request('chat-1', []);
		const failure = new Error('native history unavailable');

		await dialog.confirm(vi.fn(async () => {
			throw failure;
		}));

		await expect(requested).rejects.toBe(failure);
		expect(dialog.open).toBe(false);
	});
});

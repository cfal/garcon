import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatCanvas, UpdateCanvasRequest } from '$shared/chat-canvas';
import { ApiError } from '$lib/api/client';
import { CanvasSession, type CanvasSessionPort } from '../canvas-session.svelte';
import { canvas, deferred, recoveryMemory } from './canvas-fixtures';

afterEach(() => vi.useRealTimers());

function setup(overrides: Partial<CanvasSessionPort> = {}) {
	vi.useFakeTimers();
	const memory = recoveryMemory();
	const api = {
		get: async () => canvas(),
		update: async (request: UpdateCanvasRequest) =>
			canvas(request.content, request.expectedRevision + 1),
		...overrides,
	} satisfies CanvasSessionPort;
	const saved = vi.fn();
	const session = new CanvasSession(canvas(), api, memory.port, saved);
	return { session, memory, api, saved };
}

describe('canvas autosave', () => {
	it('retries a transient autosave failure when the user edits again', async () => {
		const update = vi
			.fn<CanvasSessionPort['update']>()
			.mockRejectedValueOnce(new Error('Offline'))
			.mockImplementation(async (request) => canvas(request.content, 2));
		const { session } = setup({ update });
		session.document.rename('First edit');
		await vi.advanceTimersByTimeAsync(500);
		expect(session.error).toBe('Offline');
		session.document.rename('Later edit');
		await vi.advanceTimersByTimeAsync(500);
		expect(update).toHaveBeenCalledTimes(2);
		expect(session.saved.content.title).toBe('Later edit');
		expect(session.dirty).toBe(false);
		session.dispose();
	});

	it('backs up pending edits on disposal without starting another save', async () => {
		const update = vi
			.fn<CanvasSessionPort['update']>()
			.mockRejectedValueOnce(new Error('Offline'))
			.mockImplementation(async (request) => canvas(request.content, 2));
		const { session, memory } = setup({ update });
		session.document.rename('Pending edit');
		await session.flush();
		session.dispose();
		await vi.runAllTimersAsync();
		expect(update).toHaveBeenCalledTimes(1);
		expect(memory.drafts.get('board')?.content.title).toBe('Pending edit');
	});

	it.each(['save', 'reload'] as const)(
		'fences a disposed %s completion from a reopened draft',
		async (operation) => {
			const response = deferred<ChatCanvas>();
			const { session, memory, api } = setup({
				update: () => response.promise,
				get: () => response.promise,
			});
			session.document.rename('Old edit');
			const completion = operation === 'save' ? session.flush() : session.discardAndReload();
			session.dispose();
			const reopened = new CanvasSession(canvas(), api, memory.port, vi.fn());
			reopened.document.rename('New edit');
			response.resolve(canvas({ ...canvas().content, title: 'Old edit' }, 2));
			expect(await completion).toBe(false);
			session.discardRecovery();
			expect(memory.drafts.get('board')?.content.title).toBe('New edit');
			reopened.dispose();
		},
	);

	it('defers refresh during gestures and ignores responses spanning a gesture', async () => {
		const response = deferred<ChatCanvas>();
		const get = vi.fn(() => response.promise);
		const { session } = setup({ get });
		const refresh = session.refresh();
		const end = session.beginInteraction();
		await session.refresh();
		expect(get).toHaveBeenCalledTimes(1);
		end();
		response.resolve(canvas({ ...canvas().content, title: 'Remote' }, 2));
		await refresh;
		expect(session.document.content.title).toBe('Work');
		await session.refresh();
		expect(session.document.content.title).toBe('Remote');
		session.dispose();
	});

	it('backs up edits immediately and clears the backup only after confirmation', async () => {
		const response = deferred<ChatCanvas>();
		const { session, memory } = setup({ update: () => response.promise });
		session.document.rename('Edited');
		expect(memory.drafts.get('board')?.content.title).toBe('Edited');
		const completion = session.flush();
		expect(session.saving).toBe(true);
		expect(memory.drafts.has('board')).toBe(true);
		response.resolve(canvas(session.document.content, 2));
		expect(await completion).toBe(true);
		expect(session.dirty).toBe(false);
		expect(memory.drafts.size).toBe(0);
		session.dispose();
	});

	it('serializes edits made during a save with the returned revision', async () => {
		const first = deferred<ChatCanvas>();
		const update = vi
			.fn<(request: UpdateCanvasRequest) => Promise<ChatCanvas>>()
			.mockImplementationOnce(() => first.promise)
			.mockImplementation(async (request) => canvas(request.content, request.expectedRevision + 1));
		const { session } = setup({ update });
		session.document.rename('First');
		const completion = session.flush();
		const submitted = session.document.content;
		session.document.rename('Second');
		first.resolve(canvas(submitted, 2));
		expect(await completion).toBe(true);
		expect(update.mock.calls[1][0]).toMatchObject({
			expectedRevision: 2,
			content: { title: 'Second' },
		});
		expect(session.saved.revision).toBe(3);
		session.dispose();
	});

	it.each([new ApiError(409, 'Changed elsewhere'), new ApiError(500, 'Corrupt', 'CANVAS_CORRUPT')])(
		'retains failed edits, supports retry, and does not automatically retry conflicts: %s',
		async (error) => {
			const update = vi
				.fn<(request: UpdateCanvasRequest) => Promise<ChatCanvas>>()
				.mockRejectedValueOnce(new Error('Offline'))
				.mockImplementation(async (request) => canvas(request.content, 2));
			const { session, memory } = setup({ update });
			session.document.rename('Edited');
			expect(await session.flush()).toBe(false);
			expect(memory.drafts.has('board')).toBe(true);
			expect(await session.flush()).toBe(true);
			update.mockRejectedValue(error);
			session.document.rename('Local');
			expect(await session.flush()).toBe(false);
			expect(session.conflict).toBe(true);
			session.document.rename('More conflicted work');
			await vi.runAllTimersAsync();
			expect(await session.flush()).toBe(false);
			expect(update).toHaveBeenCalledTimes(3);
			session.dispose();
		},
	);

	it('keeps conflicted work protected when a reload fails transiently', async () => {
		const update = vi
			.fn<CanvasSessionPort['update']>()
			.mockRejectedValue(new ApiError(409, 'Changed elsewhere'));
		const { session, memory } = setup({
			update,
			get: async () => {
				throw new ApiError(503, 'Offline');
			},
		});
		session.document.rename('Local work');
		await session.flush();
		expect(await session.discardAndReload()).toBe(false);
		expect(session.conflict).toBe(true);
		expect(await session.flush()).toBe(false);
		expect(memory.drafts.get('board')?.content.title).toBe('Local work');
		expect(update).toHaveBeenCalledTimes(1);
		session.dispose();
	});

	it('restores recovery drafts and requires a decision when their base revision is stale', () => {
		const { api, memory, session } = setup();
		memory.port.write(canvas({ ...canvas().content, title: 'Recovered' }));
		const recovered = new CanvasSession(canvas(undefined, 2), api, memory.port, () => {});
		expect(recovered.document.content.title).toBe('Recovered');
		expect(recovered.conflict).toBe(true);
		recovered.dispose();
		session.dispose();
	});

	it('does not replace newer local saves with a delayed refresh response', async () => {
		const response = deferred<ChatCanvas>();
		const { session } = setup({ get: () => response.promise });
		const refresh = session.refresh();
		session.document.rename('Local');
		await session.flush();
		response.resolve(canvas());
		await refresh;
		expect(session.saved.revision).toBe(2);
		expect(session.document.content.title).toBe('Local');
		session.dispose();
	});
});

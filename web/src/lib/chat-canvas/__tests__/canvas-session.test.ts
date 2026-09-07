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

	it('retains failed edits, supports retry, and does not automatically retry conflicts', async () => {
		const update = vi
			.fn<(request: UpdateCanvasRequest) => Promise<ChatCanvas>>()
			.mockRejectedValueOnce(new Error('Offline'))
			.mockImplementation(async (request) => canvas(request.content, 2));
		const { session, memory } = setup({ update });
		session.document.rename('Edited');
		expect(await session.flush()).toBe(false);
		expect(memory.drafts.has('board')).toBe(true);
		expect(await session.flush()).toBe(true);
		update.mockRejectedValue(new ApiError(409, 'Changed elsewhere'));
		session.document.rename('Local');
		expect(await session.flush()).toBe(false);
		expect(session.conflict).toBe(true);
		expect(await session.flush()).toBe(false);
		expect(update).toHaveBeenCalledTimes(3);
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

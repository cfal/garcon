import { describe, expect, it, vi } from 'vitest';
import { ScheduledPromptsStore, type ScheduledPromptMoveDirection } from '../scheduled-prompts-store.svelte';
import { ApiError } from '$lib/api/client';
import type { ScheduledPromptsMutationResponse, ScheduledPromptsSnapshot } from '$shared/scheduled-prompts';

function scheduledPrompt(id: string) {
	return {
		id,
		enabled: true,
		schedule: { type: 'once' as const, nextRunAt: '2030-01-01T09:00:00.000Z' },
		target: { type: 'existing-chat' as const, chatId: '123', busyBehavior: 'queue' as const },
		prompt: `Prompt ${id}`,
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function snapshot(revision: number, ids: string[]): ScheduledPromptsSnapshot {
	return { revision, prompts: ids.map(scheduledPrompt), runLog: [] };
}

describe('ScheduledPromptsStore', () => {
	it.each([
		['c', 'top', ['c', 'a', 'b', 'd']],
		['b', 'bottom', ['a', 'c', 'd', 'b']],
		['c', 'up', ['a', 'c', 'b', 'd']],
		['b', 'down', ['a', 'c', 'b', 'd']],
	] satisfies [string, ScheduledPromptMoveDirection, string[]][])(
		'moves %s %s without changing the relative order of other prompts', async (id, direction, ids) => {
			const pending = Promise.withResolvers<ScheduledPromptsMutationResponse>();
			const reorder = vi.fn(() => pending.promise);
			const store = new ScheduledPromptsStore({ reorder });
			store.applySnapshot(snapshot(2, ['a', 'b', 'c', 'd']));
			const moving = store.move(id, direction);
			await vi.waitFor(() => expect(reorder).toHaveBeenCalledOnce());
			expect(store.prompts.map(prompt => prompt.id)).toEqual(ids);
			expect(reorder).toHaveBeenCalledWith({ expectedRevision: 2, orderedPromptIds: ids });
			pending.resolve({ success: true, snapshot: snapshot(3, ids) });
			await moving;
			expect(store.snapshot).toEqual(snapshot(3, ids));
		},
	);

	it('does not submit boundary, missing-ID, or singleton moves', async () => {
		const reorder = vi.fn();
		const store = new ScheduledPromptsStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b']));
		for (const direction of ['up', 'top'] as const) await store.move('a', direction);
		for (const direction of ['down', 'bottom'] as const) await store.move('b', direction);
		for (const direction of ['up', 'down', 'top', 'bottom'] as const) await store.move('missing', direction);
		store.applySnapshot(snapshot(3, ['a']));
		await store.move('a', 'top');
		await store.move('a', 'bottom');
		expect(reorder).not.toHaveBeenCalled();
	});

	it.each([false, true])('rolls back a failed move unless a newer snapshot arrived (%s)', async newer => {
		const pending = Promise.withResolvers<ScheduledPromptsMutationResponse>();
		const reorder = vi.fn(() => pending.promise);
		const store = new ScheduledPromptsStore({ reorder });
		const original = snapshot(2, ['a', 'b', 'c']);
		store.applySnapshot(original);
		const moving = store.move('c', 'top');
		const failure = expect(moving).rejects.toThrow('Save failed');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledOnce());
		const latest = snapshot(3, ['b', 'c', 'a']);
		if (newer) store.applySnapshot(latest);
		pending.reject(new Error('Save failed'));
		await failure;
		expect(store.snapshot).toEqual(newer ? latest : original);
	});

	it('refreshes after an endpoint move conflicts without retrying the mutation', async () => {
		const reorder = vi.fn().mockRejectedValue(new ApiError(409, 'Refresh and try again'));
		const get = vi.fn().mockResolvedValue(snapshot(4, ['c', 'b', 'a']));
		const store = new ScheduledPromptsStore({ reorder, get });
		store.applySnapshot(snapshot(2, ['a', 'b', 'c']));
		await expect(store.move('a', 'bottom')).rejects.toThrow();
		expect(reorder).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledOnce();
		expect(store.snapshot).toEqual(snapshot(4, ['c', 'b', 'a']));
	});

	it('honors queued invalidation after a failed refresh', async () => {
		let rejectRead!: (error: Error) => void;
		const get = vi.fn()
			.mockImplementationOnce(() => new Promise<ScheduledPromptsSnapshot>((_, reject) => { rejectRead = reject; }))
			.mockResolvedValueOnce(snapshot(2, ['a', 'b']));
		const store = new ScheduledPromptsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		rejectRead(new Error('disconnected'));
		await Promise.all([first, second]);

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
		expect(store.error).toBeNull();
	});

	it('honors invalidation after a failed initial load', async () => {
		let rejectRead!: (error: Error) => void;
		const get = vi.fn()
			.mockImplementationOnce(() => new Promise<ScheduledPromptsSnapshot>((_, reject) => { rejectRead = reject; }))
			.mockResolvedValueOnce(snapshot(2, ['a']));
		const store = new ScheduledPromptsStore({ get });
		const failure = new Error('disconnected');
		const initial = expect(store.ensureLoaded()).rejects.toBe(failure);
		const invalidated = store.refreshIfLoaded();
		rejectRead(failure);
		await initial;
		await invalidated;

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot).toEqual(snapshot(2, ['a']));
	});

	it('does not retry failed reads without another invalidation', async () => {
		const get = vi.fn().mockRejectedValue(new Error('disconnected'));
		const store = new ScheduledPromptsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));
		await store.refreshIfLoaded();
		expect(get).toHaveBeenCalledTimes(1);
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
		expect(store.error).toBe('disconnected');
	});

	it('loads lazily and applies canonical mutation snapshots', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(0, []));
		const create = vi.fn().mockResolvedValue({ success: true, scheduledPrompt: scheduledPrompt('a'), snapshot: snapshot(1, ['a']) });
		const store = new ScheduledPromptsStore({ get, create });
		expect(get).not.toHaveBeenCalled();

		await store.ensureLoaded();
		await store.create({
			schedule: { type: 'once', runAtUtc: '2030-01-01T09:00:00.000Z' },
			target: { type: 'existing-chat', chatId: '123', busyBehavior: 'queue' },
			prompt: 'Prompt a',
		});

		expect(create).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
		expect(store.snapshot).toEqual(snapshot(1, ['a']));
	});

	it('optimistically reorders prompts and applies the server revision', async () => {
		const mutation = Promise.withResolvers<ScheduledPromptsMutationResponse>();
		const reorder = vi.fn(() => mutation.promise);
		const store = new ScheduledPromptsStore({ reorder });
		store.applySnapshot(snapshot(2, ['a', 'b']));

		const moving = store.move('b', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
		expect(store.prompts.map((entry) => entry.id)).toEqual(['b', 'a']);
		mutation.resolve({ success: true, snapshot: snapshot(3, ['b', 'a']) });
		await moving;

		expect(reorder).toHaveBeenCalledWith({ expectedRevision: 2, orderedPromptIds: ['b', 'a'] });
		expect(store.snapshot?.revision).toBe(3);
	});

	it('refreshes again when invalidated during an in-flight refresh', async () => {
		const resolvers: Array<(value: ScheduledPromptsSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<ScheduledPromptsSnapshot>((resolve) => resolvers.push(resolve)),
		);
		const store = new ScheduledPromptsStore({ get });
		store.applySnapshot(snapshot(1, ['a']));

		const first = store.refreshIfLoaded();
		const second = store.refreshIfLoaded();
		resolvers[0](snapshot(2, ['a']));
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1](snapshot(3, ['a', 'b']));
		await Promise.all([first, second]);

		expect(get).toHaveBeenCalledTimes(2);
		expect(store.snapshot?.revision).toBe(3);
	});

	it('refreshes after an invalidation that arrives during the initial load', async () => {
		const resolvers: Array<(value: ScheduledPromptsSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<ScheduledPromptsSnapshot>((resolve) => resolvers.push(resolve)),
		);
		const store = new ScheduledPromptsStore({ get });

		const initial = store.ensureLoaded();
		const invalidated = store.refreshIfLoaded();
		resolvers[0](snapshot(1, ['a']));
		await initial;
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
		resolvers[1](snapshot(2, ['a', 'b']));
		await invalidated;

		expect(store.snapshot).toEqual(snapshot(2, ['a', 'b']));
	});

	it('does not replace a newer snapshot with a stale response', () => {
		const store = new ScheduledPromptsStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));

		store.applySnapshot(snapshot(3, ['a']));

		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});
});


it('publishes only saved enablement and retains the previous state on failure', async () => {
  const saved = snapshot(2, ['a']);
  saved.prompts[0].enabled = false;
  const setEnabled = vi.fn().mockResolvedValueOnce({ success: true, snapshot: saved }).mockRejectedValueOnce(new Error('offline'));
  const store = new ScheduledPromptsStore({ setEnabled });
  store.applySnapshot(snapshot(1, ['a']));
  await store.setEnabled('a', false);
  expect(setEnabled).toHaveBeenCalledWith({ expectedRevision: 1, id: 'a', enabled: false });
  expect(store.prompts[0].enabled).toBe(false);
  await expect(store.setEnabled('a', true)).rejects.toThrow('offline');
  expect(store.prompts[0].enabled).toBe(false);
});

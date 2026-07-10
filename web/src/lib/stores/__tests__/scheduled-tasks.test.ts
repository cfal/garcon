import { describe, expect, it, vi } from 'vitest';
import { ScheduledTasksStore } from '../scheduled-tasks.svelte';
import type { ScheduledTasksSnapshot } from '$shared/scheduled-tasks';

function task(id: string) {
	return {
		id,
		schedule: { type: 'once' as const, nextRunAt: '2030-01-01T09:00:00.000Z' },
		target: { type: 'existing-chat' as const, chatId: '123', busyBehavior: 'queue' as const },
		prompt: `Prompt ${id}`,
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
	};
}

function snapshot(revision: number, ids: string[]): ScheduledTasksSnapshot {
	return { revision, tasks: ids.map(task), runLog: [] };
}

describe('ScheduledTasksStore', () => {
	it('loads lazily and applies canonical mutation snapshots', async () => {
		const get = vi.fn().mockResolvedValue(snapshot(0, []));
		const create = vi.fn().mockResolvedValue({ success: true, snapshot: snapshot(1, ['a']) });
		const store = new ScheduledTasksStore({ get, create });
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

	it('optimistically reorders tasks and applies the server revision', async () => {
		let resolveMutation!: (value: unknown) => void;
		const reorder = vi.fn(() => new Promise((resolve) => (resolveMutation = resolve)));
		const store = new ScheduledTasksStore({ reorder: reorder as never });
		store.applySnapshot(snapshot(2, ['a', 'b']));

		const moving = store.move('b', 'up');
		await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(1));
		expect(store.tasks.map((entry) => entry.id)).toEqual(['b', 'a']);
		resolveMutation({ success: true, snapshot: snapshot(3, ['b', 'a']) });
		await moving;

		expect(reorder).toHaveBeenCalledWith({ expectedRevision: 2, orderedTaskIds: ['b', 'a'] });
		expect(store.snapshot?.revision).toBe(3);
	});

	it('refreshes again when invalidated during an in-flight refresh', async () => {
		const resolvers: Array<(value: ScheduledTasksSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<ScheduledTasksSnapshot>((resolve) => resolvers.push(resolve)),
		);
		const store = new ScheduledTasksStore({ get });
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
		const resolvers: Array<(value: ScheduledTasksSnapshot) => void> = [];
		const get = vi.fn(
			() => new Promise<ScheduledTasksSnapshot>((resolve) => resolvers.push(resolve)),
		);
		const store = new ScheduledTasksStore({ get });

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
		const store = new ScheduledTasksStore();
		store.applySnapshot(snapshot(4, ['a', 'b']));

		store.applySnapshot(snapshot(3, ['a']));

		expect(store.snapshot).toEqual(snapshot(4, ['a', 'b']));
	});
});

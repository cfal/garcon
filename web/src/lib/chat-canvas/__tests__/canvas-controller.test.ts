import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	canvasSummary,
	type ChatCanvas,
	type CreateCanvasRequest,
	type UpdateCanvasRequest,
	type DeleteCanvasRequest,
	type CanvasListResponse,
} from '$shared/chat-canvas';
import { ApiError } from '$lib/api/client';
import { CanvasController, type CanvasApiPort } from '../canvas-controller.svelte';
import { canvas, deferred, recoveryMemory } from './canvas-fixtures';

afterEach(() => vi.useRealTimers());

function setup() {
	vi.useFakeTimers();
	const boards = new Map<string, ChatCanvas>([
		['board', canvas()],
		['other', { ...canvas(), id: 'other' }],
	]);
	const api = {
		list: vi.fn(async () => ({ canvases: [...boards.values()].map(canvasSummary) })),
		get: vi.fn(async (id: string) => boards.get(id)!),
		create: vi.fn(async (request: CreateCanvasRequest) => {
			const created = { ...canvas(request.content), id: request.id };
			boards.set(request.id, created);
			return created;
		}),
		update: vi.fn(async (request: UpdateCanvasRequest) => {
			const next = { ...canvas(request.content, request.expectedRevision + 1), id: request.id };
			boards.set(request.id, next);
			return next;
		}),
		remove: vi.fn(async (request: DeleteCanvasRequest) => {
			boards.delete(request.id);
		}),
	} satisfies CanvasApiPort;
	const memory = recoveryMemory();
	const controller = new CanvasController(api, memory.port);
	return { controller, api, memory, boards };
}

describe('CanvasController', () => {
	it('loads on demand and saves the current document before switching', async () => {
		const { controller, api } = setup();
		expect(api.list).not.toHaveBeenCalled();
		await controller.activate();
		controller.session!.document.rename('Edited');
		await controller.open('other');
		expect(api.update).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'board',
				content: expect.objectContaining({ title: 'Edited' }),
			}),
		);
		expect(controller.session?.saved.id).toBe('other');
		controller.dispose();
	});

	it('keeps the active document when switching would lose a failed save', async () => {
		const { controller, api } = setup();
		await controller.activate();
		api.update.mockRejectedValue(new Error('Offline'));
		controller.session!.document.rename('Edited');
		await controller.open('other');
		expect(controller.session?.saved.id).toBe('board');
		expect(controller.session?.error).toBe('Offline');
		controller.dispose();
	});

	it('saves conflicted work as an independent copy and clears its recovery draft', async () => {
		const { controller, api, memory, boards } = setup();
		await controller.activate();
		api.update.mockRejectedValue(new ApiError(409, 'Changed elsewhere'));
		controller.session!.document.rename('Local work');
		await controller.session!.flush();
		expect(await controller.saveCopy('Recovered copy')).toBe(true);
		expect(controller.session?.document.content.title).toBe('Recovered copy');
		expect(boards.get('board')?.content.title).toBe('Work');
		expect(memory.drafts.has('board')).toBe(false);
		expect(api.update).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it('does not autosave or resurrect an explicitly deleted dirty board', async () => {
		const { controller, api, boards } = setup();
		await controller.activate();
		controller.session!.document.rename('Pending');
		expect(await controller.removeCurrent()).toBe(true);
		await vi.runAllTimersAsync();
		expect(api.update).not.toHaveBeenCalled();
		expect(boards.has('board')).toBe(false);
		controller.dispose();
	});

	it('ignores a completed load after disposal and prunes deleted-board viewports', async () => {
		const { controller, api, boards } = setup();
		await controller.activate();
		controller.setViewport('other', { x: 1, y: 2, zoom: 0.5 });
		boards.delete('other');
		await controller.refresh();
		expect(controller.viewport('other')).toBeUndefined();
		const response = deferred<CanvasListResponse>();
		api.list.mockReturnValue(response.promise);
		const refresh = controller.activate();
		controller.dispose();
		response.resolve({ canvases: [] });
		await refresh;
		expect(controller.canvases.length).toBe(1);
	});
	it('does not let an old catalog response hide a newly created board', async () => {
		const { controller, api } = setup();
		await controller.activate();
		const response = deferred<CanvasListResponse>();
		api.list.mockReturnValueOnce(response.promise);
		const refresh = controller.refresh();
		await controller.create('New board');
		const id = controller.session!.saved.id;
		response.resolve({ canvases: [] });
		await refresh;
		expect(controller.canvases.some((entry) => entry.id === id)).toBe(true);
		controller.dispose();
	});

	it('offers locally recovered work even after the original board was deleted elsewhere', async () => {
		const { controller, api, boards, memory } = setup();
		boards.clear();
		memory.port.write(canvas({ ...canvas().content, title: 'Unsent draft' }));
		api.get.mockRejectedValue(new ApiError(404, 'Deleted'));
		await controller.activate();
		expect(controller.canvases[0].title).toBe('Unsent draft');
		expect(controller.session?.conflict).toBe(true);
		expect(memory.drafts.has('board')).toBe(true);
		expect(await controller.saveCopy('Recovered work')).toBe(true);
		expect(controller.session?.document.content.title).toBe('Recovered work');
		expect(memory.drafts.has('board')).toBe(false);
		controller.dispose();
	});
});

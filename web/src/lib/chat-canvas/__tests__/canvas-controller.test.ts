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
import { CanvasExitGuard } from '../canvas-exit-guard';
import { canvas, deferred, recoveryMemory } from './canvas-fixtures';

const controllers = new Set<CanvasController>();
const guards = new Set<CanvasExitGuard>();
afterEach(() => {
	for (const controller of controllers) controller.dispose();
	controllers.clear();
	for (const guard of guards) guard.dispose();
	guards.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup() {
	vi.useFakeTimers();
	const boards = new Map<string, ChatCanvas>([
		['board', canvas()],
		['other', { ...canvas(), id: 'other' }],
	]);
	const api = {
		list: vi.fn<CanvasApiPort['list']>(async () => ({
			canvases: [...boards.values()].map(canvasSummary),
			unavailableIds: [],
		})),
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
	controllers.add(controller);
	const guard = new CanvasExitGuard(memory.port, () => controller.session);
	guard.activate();
	guards.add(guard);
	return { controller, api, memory, boards, guard };
}

describe('CanvasController', () => {
	it('pauses debounce-pending and exit-triggered saves until deletion settles', async () => {
		const { controller, api, boards } = setup();
		await controller.activate();
		const session = controller.session!;
		session.document.rename('Pending deletion');
		const response = deferred<void>();
		api.remove.mockImplementation(async ({ id, expectedRevision }) => {
			await response.promise;
			if (boards.get(id)?.revision !== expectedRevision) throw new ApiError(409, 'Conflict');
			boards.delete(id);
		});
		const deletion = controller.removeCurrent();
		await vi.advanceTimersByTimeAsync(1000);
		session.preserveForExit();
		response.resolve();
		expect(await deletion).toBe(true);
		expect(api.update).not.toHaveBeenCalled();
		expect(controller.session).toBeNull();
	});

	it('resumes pending autosave when deletion fails', async () => {
		const { controller, api, boards } = setup();
		await controller.activate();
		controller.session!.document.rename('Retained edit');
		api.remove.mockRejectedValueOnce(new Error('Delete failed'));
		expect(await controller.removeCurrent()).toBe(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(boards.get('board')?.content.title).toBe('Retained edit');
		expect(api.update).toHaveBeenCalledTimes(1);
	});

	it('waits for an in-flight save and deletes its resulting revision', async () => {
		const { controller, api } = setup();
		await controller.activate();
		const response = deferred<ChatCanvas>();
		api.update.mockReturnValueOnce(response.promise);
		const session = controller.session!;
		session.document.rename('In-flight edit');
		await vi.advanceTimersByTimeAsync(500);
		const deletion = controller.removeCurrent();
		expect(api.remove).not.toHaveBeenCalled();
		response.resolve(canvas(session.document.content, 2));
		expect(await deletion).toBe(true);
		expect(api.remove).toHaveBeenCalledWith({ id: 'board', expectedRevision: 2 });
	});

	it('finishes a deletion whose successful response was lost', async () => {
		const { controller, api, boards, memory } = setup();
		await controller.activate();
		controller.session!.document.rename('Pending deletion');
		api.remove
			.mockImplementationOnce(async ({ id }) => {
				boards.delete(id);
				throw new Error('Response lost');
			})
			.mockRejectedValueOnce(new ApiError(404, 'Not found'));
		expect(await controller.removeCurrent()).toBe(false);
		expect(await controller.removeCurrent()).toBe(true);
		expect(controller.session).toBeNull();
		expect(controller.canvases.some((entry) => entry.id === 'board')).toBe(false);
		expect(memory.drafts.has('board')).toBe(false);
	});

	it('keeps healthy canvases available and clears resolved catalog warnings on refresh', async () => {
		const { controller, api } = setup();
		api.list.mockResolvedValueOnce({
			canvases: [canvasSummary(canvas())],
			unavailableIds: ['damaged'],
		});
		await controller.activate();
		expect(controller.unavailableIds).toEqual(['damaged']);
		expect(controller.session!.saved.id).toBe('board');
		await controller.refresh();
		expect(controller.unavailableIds).toEqual([]);
		controller.dispose();
	});

	it('saves debounce-pending edits to the original before making a copy', async () => {
		const { controller, boards, memory } = setup();
		await controller.activate();
		controller.session!.document.rename('Edited original');
		expect(await controller.saveCopy('Copy')).toBe(true);
		expect(boards.get('board')?.content.title).toBe('Edited original');
		expect(memory.drafts.has('board')).toBe(false);
		await controller.open('board');
		expect(controller.session!.document.content.title).toBe('Edited original');
		controller.dispose();
	});

	it('keeps the original and its draft when saving before a copy fails', async () => {
		const { controller, api, memory } = setup();
		await controller.activate();
		api.update.mockRejectedValue(new Error('Offline'));
		controller.session!.document.rename('Pending original');
		expect(await controller.saveCopy('Copy')).toBe(false);
		expect(api.create).not.toHaveBeenCalled();
		expect(controller.session!.saved.id).toBe('board');
		expect(memory.drafts.get('board')?.content.title).toBe('Pending original');
		controller.dispose();
	});

	it('does not publish or clear recovery after disposal while completing a save', async () => {
		const { controller, api, memory } = setup();
		await controller.activate();
		const response = deferred<ChatCanvas>();
		api.update.mockReturnValue(response.promise);
		controller.session!.document.rename('Final edit');
		const content = controller.session!.document.content;
		const catalog = controller.canvases;
		const saving = controller.session!.flush();
		controller.dispose();
		response.resolve(canvas(content, 2));
		await saving;
		expect(controller.canvases).toBe(catalog);
		expect(memory.drafts.has('board')).toBe(true);
	});

	it('holds close admission through a pending save and prevents new operations until released', async () => {
		const { controller, api } = setup();
		await controller.activate();
		const response = deferred<ChatCanvas>();
		api.update.mockReturnValue(response.promise);
		controller.session!.document.rename('Pending');
		const closing = controller.prepareClose();
		expect(controller.closing).toBe(true);
		await controller.open('other');
		expect(await controller.create('New')).toBe(false);
		expect(await controller.saveCopy('Copy')).toBe(false);
		expect(await controller.removeCurrent()).toBe(false);
		expect(await controller.prepareClose()).toBeNull();
		response.resolve(canvas(controller.session!.document.content, 2));
		const release = await closing;
		expect(release).toBeTypeOf('function');
		expect(controller.closing).toBe(true);
		release!();
		expect(controller.closing).toBe(false);
	});

	it('blocks close when neither saving nor recovery can preserve the document', async () => {
		const { controller, api, memory } = setup();
		await controller.activate();
		api.update.mockRejectedValue(new Error('Offline'));
		vi.spyOn(memory.port, 'write').mockImplementation(() => {
			throw new Error('Full');
		});
		controller.session!.document.rename('Keep me');
		expect(await controller.prepareClose()).toBeNull();
		expect(controller.closing).toBe(false);
		expect(controller.session!.document.content.title).toBe('Keep me');
	});

	it('backs up a clean conflicted document synchronously on browser exit', async () => {
		const { controller, api, memory } = setup();
		await controller.activate();
		api.get.mockRejectedValue(new ApiError(404, 'Deleted'));
		await controller.session!.refresh();
		expect(controller.session!.dirty).toBe(false);
		window.dispatchEvent(new Event('pagehide'));
		expect(memory.drafts.get('board')?.content.title).toBe('Work');
	});

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

	it.each([
		new ApiError(409, 'Changed elsewhere'),
		new ApiError(404, 'Deleted'),
		new ApiError(500, 'Corrupt', 'CANVAS_CORRUPT'),
	])(
		'preserves conflicted work across board switches and protects inactive drafts: %s',
		async (error) => {
			const { controller, api, boards, memory } = setup();
			await controller.activate();
			controller.session!.document.rename('Local work');
			api.update.mockRejectedValue(error);
			await controller.session!.flush();
			api.get.mockImplementation(async (id) => {
				if (id !== 'board') return boards.get(id)!;
				if (error.status !== 409) throw error;
				return canvas({ ...canvas().content, title: 'Remote work' }, 2);
			});
			api.create.mockRejectedValueOnce(new ApiError(409, 'Catalog full', 'CANVAS_LIMIT'));
			expect(await controller.saveCopy('Recovered')).toBe(false);
			await controller.open('other');
			expect(controller.session?.saved.id).toBe('other');
			expect(memory.drafts.get('board')?.content.title).toBe('Local work');
			const exitWithInactiveDraft = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(exitWithInactiveDraft);
			expect(exitWithInactiveDraft.defaultPrevented).toBe(true);
			await controller.session!.flush();
			await controller.open('board');
			expect(controller.session?.document.content.title).toBe('Local work');
			expect(controller.session?.conflict).toBe(true);
			await vi.runAllTimersAsync();
			expect(api.update).toHaveBeenCalledTimes(1);
			expect(await controller.saveCopy('Recovered')).toBe(true);
			expect(memory.drafts.has('board')).toBe(false);
			const savedExit = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(savedExit);
			expect(savedExit.defaultPrevented).toBe(false);
			controller.dispose();
		},
	);

	it('blocks a switch when edits made during the destination load cannot be backed up', async () => {
		const { controller, api, boards, memory } = setup();
		await controller.activate();
		controller.session!.document.rename('Local work');
		api.update.mockRejectedValue(new ApiError(409, 'Changed elsewhere'));
		await controller.session!.flush();
		const response = deferred<ChatCanvas>();
		api.get.mockReturnValueOnce(response.promise);
		const opening = controller.open('other');
		expect(api.get).toHaveBeenLastCalledWith('other');
		const write = vi.spyOn(memory.port, 'write').mockImplementation(() => {
			throw new Error('Storage full');
		});
		controller.session!.document.rename('Latest local work');
		response.resolve(boards.get('other')!);
		await opening;
		expect(controller.session?.saved.id).toBe('board');
		expect(controller.session?.recoveryError).toBe(true);
		expect(controller.session?.document.content.title).toBe('Latest local work');
		write.mockRestore();
		await controller.open('other');
		expect(controller.session?.saved.id).toBe('other');
		expect(memory.drafts.get('board')?.content.title).toBe('Latest local work');
		controller.dispose();
	});

	it('backs up a clean canvas that became unreadable before switching away', async () => {
		const { controller, api, memory } = setup();
		await controller.activate();
		api.get.mockRejectedValueOnce(new ApiError(500, 'Corrupt', 'CANVAS_CORRUPT'));
		await controller.session!.refresh();
		expect(controller.session?.dirty).toBe(false);
		expect(controller.session?.conflict).toBe(true);
		expect(memory.drafts.size).toBe(0);
		await controller.open('other');
		expect(controller.session?.saved.id).toBe('other');
		expect(memory.drafts.get('board')?.content).toEqual(canvas().content);
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
		response.resolve({ canvases: [], unavailableIds: [] });
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
		response.resolve({ canvases: [], unavailableIds: [] });
		await refresh;
		expect(controller.canvases.some((entry) => entry.id === id)).toBe(true);
		controller.dispose();
	});

	it.each([new ApiError(404, 'Deleted'), new ApiError(500, 'Corrupt', 'CANVAS_CORRUPT')])(
		'offers local recovery when the original board is unavailable: %s',
		async (error) => {
			const { controller, api, boards, memory } = setup();
			boards.clear();
			memory.port.write(canvas({ ...canvas().content, title: 'Unsent draft' }));
			api.list.mockResolvedValue({
				canvases: [],
				unavailableIds: error.errorCode === 'CANVAS_CORRUPT' ? ['board'] : [],
			});
			api.get.mockRejectedValue(error);
			await controller.activate();
			expect(controller.canvases[0].title).toBe('Unsent draft');
			expect(controller.session?.conflict).toBe(true);
			const deletedExit = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(deletedExit);
			expect(deletedExit.defaultPrevented).toBe(true);
			expect(memory.drafts.has('board')).toBe(true);
			expect(await controller.session!.discardAndReload()).toBe(false);
			expect(controller.session?.conflict).toBe(true);
			api.create.mockRejectedValueOnce(new Error('Offline'));
			expect(await controller.saveCopy('Recovered work')).toBe(false);
			expect(memory.drafts.has('board')).toBe(true);
			expect(await controller.saveCopy('Recovered work')).toBe(true);
			expect(controller.session?.document.content.title).toBe('Recovered work');
			expect(memory.drafts.has('board')).toBe(false);
			expect(api.update).not.toHaveBeenCalled();
			expect(boards.has('board')).toBe(false);
			controller.dispose();
		},
	);

	it('reports an unreadable board without a draft and preserves drafts on unrelated load errors', async () => {
		const { controller, api, boards, memory } = setup();
		boards.clear();
		api.list.mockResolvedValue({ canvases: [], unavailableIds: ['board'] });
		api.get.mockRejectedValueOnce(new ApiError(500, 'Corrupt', 'CANVAS_CORRUPT'));
		await controller.open('board');
		expect(controller.session).toBeNull();
		expect(controller.error).toBe('Corrupt');
		memory.port.write(canvas({ ...canvas().content, title: 'Unsent draft' }));
		api.get.mockRejectedValueOnce(new ApiError(500, 'Server unavailable'));
		await controller.activate();
		expect(controller.session).toBeNull();
		expect(controller.error).toBe('Server unavailable');
		expect(memory.drafts.has('board')).toBe(true);
		controller.dispose();
	});
	it('guards recovery after controller disposal until the root guard is destroyed', async () => {
		const { controller, api, guard } = setup();
		await controller.activate();
		const savedExit = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(savedExit);
		expect(savedExit.defaultPrevented).toBe(false);
		controller.session!.document.rename('Background save');
		window.dispatchEvent(new Event('pagehide'));
		await controller.session!.flush();
		expect(controller.session!.dirty).toBe(false);
		api.update.mockRejectedValue(new Error('Offline'));
		controller.session!.document.rename('Pending work');
		await controller.session!.flush();
		const dirtyExit = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(dirtyExit);
		expect(dirtyExit.defaultPrevented).toBe(true);
		await controller.session!.flush();
		controller.dispose();
		const disposedExit = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(disposedExit);
		expect(disposedExit.defaultPrevented).toBe(true);
		guard.dispose();
		const rootExit = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(rootExit);
		expect(rootExit.defaultPrevented).toBe(false);
	});
});

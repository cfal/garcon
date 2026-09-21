import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browseDirectory } from '$lib/api/files.js';
import { ProjectPathCompletionController } from '../project-path-completion.js';

vi.mock('$lib/api/files.js', () => ({ browseDirectory: vi.fn() }));

function target() {
	return { nodeId: 'local', filesAvailable: true, projectPath: '/repo/s', showBrowser: false };
}

describe('ProjectPathCompletionController', () => {
	beforeEach(() => vi.mocked(browseDirectory).mockReset());

	it('completes and cycles directory matches from the selected node', async () => {
		const form = target();
		form.nodeId = '22222222-2222-4222-8222-222222222222';
		vi.mocked(browseDirectory).mockResolvedValue([
			{ name: 'src', path: '/repo/src', type: 'directory' },
			{ name: 'scripts', path: '/repo/scripts', type: 'directory' },
		]);
		const completion = new ProjectPathCompletionController(form);
		await completion.complete();
		expect(browseDirectory).toHaveBeenCalledWith('/repo', undefined, form.nodeId);
		expect(form.showBrowser).toBe(true);
		await completion.complete();
		expect(form.projectPath).toBe('/repo/scripts');
		await completion.complete();
		expect(form.projectPath).toBe('/repo/src');
		expect(browseDirectory).toHaveBeenCalledOnce();
		completion.reset();
		vi.mocked(browseDirectory).mockResolvedValue([
			{ name: 'src', path: '/repo/src', type: 'directory' },
		]);
		await completion.complete();
		expect(form.projectPath).toBe('/repo/src/');
	});

	it('invalidates a pending completion even when the node and path return to their original values', async () => {
		const form = target();
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof browseDirectory>>>();
		vi.mocked(browseDirectory).mockReturnValueOnce(pending.promise);
		const completion = new ProjectPathCompletionController(form);
		const completing = completion.complete();
		completion.reset();
		pending.resolve([{ name: 'src', path: '/repo/src', type: 'directory' }]);
		await completing;
		expect(form.projectPath).toBe('/repo/s');
		expect(form.showBrowser).toBe(false);
	});

	it('leaves unavailable nodes untouched without filesystem requests', async () => {
		const form = target();
		form.filesAvailable = false;
		await new ProjectPathCompletionController(form).complete();
		expect(browseDirectory).not.toHaveBeenCalled();
		expect(form.projectPath).toBe('/repo/s');
	});
});

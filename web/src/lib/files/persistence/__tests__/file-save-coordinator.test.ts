import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { FileSaveCoordinator } from '$lib/files/persistence/file-save-coordinator.js';
import { MAX_FILE_VIEW_BYTES } from '$shared/file-contracts';

function document() {
	const value = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'file.ts' },
		'file',
	);
	value.baseline = 'initial';
	value.content = 'changed';
	value.loadedRevision = 'v1:initial';
	value.saveController = new AbortController();
	return value;
}
const saved = (revision = 'v1:saved') => ({
	success: true as const,
	path: '/workspace/file.ts',
	message: 'saved',
	revision,
});

describe('FileSaveCoordinator', () => {
	it('saves supported files without requiring a browser recovery journal', async () => {
		const value = document();
		value.content = 'x'.repeat(MAX_FILE_VIEW_BYTES);
		const saveText = vi.fn(async () => saved());
		const coordinator = new FileSaveCoordinator({ saveText, getTimeoutMs: () => 1000 });
		await coordinator.submit(value, value.content, value.saveController!, 'v1:initial');
		expect(saveText).toHaveBeenCalledWith(
			expect.objectContaining({
				content: value.content,
				expectedRevision: 'v1:initial',
				conflictResolution: 'reject',
			}),
			expect.anything(),
		);
		expect(value.dirty).toBe(false);
	});

	it.each([401, 403, 404, 409, 500])(
		'reports HTTP %s without adding persistent guards',
		async (status) => {
			const value = document();
			const coordinator = new FileSaveCoordinator({
				saveText: async () => {
					throw new ApiError(status, 'Save failed');
				},
				getTimeoutMs: () => 1000,
			});
			await expect(
				coordinator.submit(value, value.content, value.saveController!, 'v1:initial'),
			).rejects.toThrow('Save failed');
			expect(value.content).toBe('changed');
			expect(value.baseline).toBe('initial');
			expect(value.dirty).toBe(true);
			expect(value.mutationGuarded).toBe(false);
		},
	);

	it('does not apply a timed-out response over a later successful Save', async () => {
		vi.useFakeTimers();
		try {
			const value = document();
			let finish!: (result: ReturnType<typeof saved>) => void;
			const saveText = vi.fn(async () => saved('v1:retry'));
			saveText.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const coordinator = new FileSaveCoordinator({ saveText, getTimeoutMs: () => 50 });
			const failed = expect(
				coordinator.submit(value, 'changed', value.saveController!, 'v1:initial'),
			).rejects.toThrow('not confirmed');
			await vi.advanceTimersByTimeAsync(50);
			await failed;
			expect(value.saveController?.signal.aborted).toBe(true);
			value.content = 'newer';
			value.saveController = new AbortController();
			await coordinator.submit(value, 'newer', value.saveController, 'v1:initial');
			finish(saved('v1:late'));
			await Promise.resolve();
			expect(value.loadedRevision).toBe('v1:retry');
			expect(value.baseline).toBe('newer');
			expect(value.content).toBe('newer');
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves edits made during Save dirty', async () => {
		const value = document();
		const coordinator = new FileSaveCoordinator({
			saveText: async () => {
				value.content = 'later edit';
				return saved();
			},
			getTimeoutMs: () => 1000,
		});
		await coordinator.submit(value, 'changed', value.saveController!, 'v1:initial');
		expect(value.baseline).toBe('changed');
		expect(value.content).toBe('later edit');
		expect(value.dirty).toBe(true);
	});
});

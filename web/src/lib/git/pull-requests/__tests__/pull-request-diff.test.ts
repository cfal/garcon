import { describe, expect, it, vi } from 'vitest';
import { PullRequestDiffController } from '../pull-request-diff.svelte.js';
import type {
	GitReviewFileBody,
	GitReviewFilePatchBody,
	GitReviewFileSummary,
} from '$lib/api/git.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { GitDiffSyntaxController } from '$lib/git/review/git-diff-syntax-controller.svelte.js';

function document(documentId: string, paths = ['a.ts', 'b.ts', 'c.ts']) {
	const files: GitReviewFileSummary[] = paths.map((path) => ({
		path,
		category: 'normal',
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
		bodyFingerprint: `${documentId}:${path}`,
		bodyState: 'unloaded',
		estimatedRows: 2,
		indexStatus: 'M',
		workTreeStatus: ' ',
		additions: 1,
		deletions: 0,
	}));
	const fileBodies: Record<string, GitReviewFilePatchBody> = Object.fromEntries(
		files.map((file) => [
			file.path,
			{
				...file,
				bodyState: 'loaded',
				patch: '@@ -0,0 +1 @@\n+const synthetic = 1;\n',
				patchBytes: 40,
				renderedRowCount: 2,
			},
		]),
	);
	return {
		reviewId: 'executor:repository:1',
		documentId,
		headRefOid: 'a'.repeat(40),
		files,
		fileBodies,
	};
}
function plainSyntax() {
	return new GitDiffSyntaxController({
		waitForWorkSlot: async () => {},
		loadHighlighter: async () => ({
			highlightGitDiffFile: async () => ({ status: 'plain', reason: 'unsupported-language' }),
		}),
	});
}
const indexed = (body: GitReviewFilePatchBody): GitReviewFileBody => ({
	...body,
	patchIndex: createGitPatchIndex(body.patch!, body.renderedRowCount),
});

describe('PR diff demand', () => {
	it.each(['constructor', 'toString', '__proto__'])(
		'treats %s as a file path, not an inherited cached body',
		async (path) => {
			const index = vi.fn(async (body: GitReviewFilePatchBody) => indexed(body));
			const controller = new PullRequestDiffController(index, plainSyntax());
			controller.open(document('prototype-path', [path]));
			controller.handleDemand({
				documentId: 'prototype-path',
				kind: 'viewport',
				filePaths: [path],
			});
			expect(index).toHaveBeenCalledOnce();
			await vi.waitFor(() => expect(Object.hasOwn(controller.fileBodies, path)).toBe(true));
			expect(controller.fileBodies[path].patchIndex?.rowCount).toBe(2);
			controller.close();
			expect(Object.getPrototypeOf(controller.fileBodies)).toBeNull();
		},
	);
	it('trims the oldest unpinned bodies while retaining demanded paths', async () => {
		const paths = Array.from({ length: 130 }, (_, index) => `file-${index}.ts`);
		const index = vi.fn(async (body: GitReviewFilePatchBody) => indexed(body));
		const controller = new PullRequestDiffController(index, plainSyntax());
		controller.open(document('many-files', paths));
		controller.handleDemand({
			documentId: 'many-files',
			kind: 'viewport',
			filePaths: paths.slice(0, 128),
		});
		await vi.waitFor(() => expect(Object.keys(controller.fileBodies)).toHaveLength(128));
		controller.handleDemand({
			documentId: 'many-files',
			kind: 'viewport',
			filePaths: [paths[0], paths[128], paths[129]],
		});
		await vi.waitFor(() => expect(controller.fileBodies[paths[129]]).toBeDefined());
		expect(Object.keys(controller.fileBodies)).toEqual([paths[0], ...paths.slice(3)]);
		expect(index).toHaveBeenCalledTimes(130);
		controller.close();
	});
	it('retries only local index failures on refresh without restarting loaded or pending bodies', async () => {
		const pending = Promise.withResolvers<GitReviewFileBody>();
		const index = vi.fn(async (body: GitReviewFilePatchBody, _signal?: AbortSignal) =>
			indexed(body),
		);
		index.mockRejectedValueOnce(new Error('Synthetic Worker startup failure'));
		const controller = new PullRequestDiffController(index, plainSyntax());
		const original = document('same');
		controller.open(original);
		const demand = { documentId: 'same', kind: 'viewport' as const, filePaths: ['a.ts', 'b.ts'] };
		controller.handleDemand(demand);
		await vi.waitFor(() => expect(controller.loadingBodies.size).toBe(0));
		expect(controller.fileBodies['a.ts'].bodyState).toBe('error');
		const loaded = controller.fileBodies['b.ts'];
		expect(loaded.patchIndex).not.toBeNull();
		controller.handleDemand(demand);
		controller.handleDemand({ ...demand, filePaths: [] });
		controller.handleDemand(demand);
		expect(index).toHaveBeenCalledTimes(2);
		index.mockImplementationOnce(() => pending.promise);
		controller.handleDemand({ ...demand, filePaths: ['a.ts', 'b.ts', 'c.ts'] });
		const pendingSignal = index.mock.calls[2][1];
		controller.open({ ...structuredClone(original), documentId: 'metadata-refresh' });
		expect(controller.fileBodies['a.ts']).toBeUndefined();
		expect(controller.fileBodies['b.ts']).toBe(loaded);
		expect(pendingSignal?.aborted).toBe(false);
		pending.resolve(indexed(original.fileBodies['c.ts']));
		await vi.waitFor(() => expect(controller.fileBodies['a.ts'].bodyState).toBe('loaded'));
		expect(index).toHaveBeenCalledTimes(4);
		expect(controller.documentId).toBe('same');
		controller.close();
	});
	it('retains terminal server errors across unchanged refreshes', async () => {
		const index = vi.fn(async (body: GitReviewFilePatchBody) => ({ ...body, patchIndex: null }));
		const controller = new PullRequestDiffController(index, plainSyntax());
		const original = document('same');
		original.fileBodies['a.ts'] = {
			...original.fileBodies['a.ts'],
			bodyState: 'error',
			patch: null,
			error: 'Unavailable patch',
		};
		controller.open(original);
		controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['a.ts'] });
		await vi.waitFor(() => expect(controller.loadingBodies.size).toBe(0));
		const failed = controller.fileBodies['a.ts'];
		controller.open({ ...structuredClone(original), documentId: 'metadata-refresh' });
		controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['a.ts'] });
		expect(controller.fileBodies['a.ts']).toBe(failed);
		expect(index).toHaveBeenCalledOnce();
		controller.close();
	});
	it('preserves in-flight indexing and loaded bodies on an unchanged refresh', async () => {
		const pending = Promise.withResolvers<GitReviewFileBody>();
		const index = vi.fn(async (body: GitReviewFilePatchBody, _signal?: AbortSignal) =>
			indexed(body),
		);
		index.mockImplementationOnce(() => pending.promise);
		const controller = new PullRequestDiffController(index, plainSyntax());
		const original = document('same');
		controller.open(original);
		controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['a.ts'] });
		const refreshed = { ...structuredClone(original), documentId: 'metadata-refresh' };
		controller.open(refreshed);
		expect(index.mock.calls[0][1]?.aborted).toBe(false);
		pending.resolve(indexed(original.fileBodies['a.ts']));
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']).toBeDefined());
		const loaded = controller.fileBodies;
		controller.open(structuredClone(refreshed));
		expect(controller.fileBodies).toBe(loaded);
		expect(index).toHaveBeenCalledOnce();
		controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['b.ts'] });
		expect(index).toHaveBeenCalledTimes(2);
		controller.close();
	});
	it.each(['other-executor:repository:1', 'executor:other-repository:1', 'executor:repository:2'])(
		'fences unchanged bodies when the owning review changes to %s',
		async (reviewId) => {
			const pending = Promise.withResolvers<GitReviewFileBody>();
			const index = vi.fn(
				(_body: GitReviewFilePatchBody, _signal?: AbortSignal) => pending.promise,
			);
			const controller = new PullRequestDiffController(index, plainSyntax());
			const original = document('same');
			controller.open(original);
			controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['a.ts'] });
			controller.open({ ...structuredClone(original), reviewId });
			expect(index.mock.calls[0][1]?.aborted).toBe(true);
			pending.resolve(indexed(original.fileBodies['a.ts']));
			await Promise.resolve();
			expect(controller.fileBodies).toEqual({});
			controller.close();
		},
	);
	it('fences changed patch digests even when document and fingerprint are unchanged', async () => {
		const pending = Promise.withResolvers<GitReviewFileBody>();
		const index = vi.fn((_body: GitReviewFilePatchBody, _signal?: AbortSignal) => pending.promise);
		const controller = new PullRequestDiffController(index, plainSyntax());
		const original = document('same');
		controller.open(original);
		controller.handleDemand({ documentId: 'same', kind: 'viewport', filePaths: ['a.ts'] });
		const replacement = structuredClone(original);
		replacement.fileBodies['a.ts'].patchDigest = 'b'.repeat(64);
		controller.open(replacement);
		expect(index.mock.calls[0][1]?.aborted).toBe(true);
		pending.resolve(indexed(original.fileBodies['a.ts']));
		await Promise.resolve();
		expect(controller.fileBodies).toEqual({});
		controller.close();
	});
	it('indexes only demanded files and closes all owned work', async () => {
		const index = vi.fn(async (body: GitReviewFilePatchBody) => indexed(body));
		const controller = new PullRequestDiffController(index, plainSyntax());
		controller.open(document('first'));
		expect(index).not.toHaveBeenCalled();
		controller.handleDemand({ documentId: 'first', kind: 'viewport', filePaths: ['b.ts'] });
		await vi.waitFor(() => expect(controller.fileBodies['b.ts']?.patchIndex?.rowCount).toBe(2));
		expect(index).toHaveBeenCalledOnce();
		controller.close();
		expect(controller.fileBodies).toEqual({});
	});
	it('fences late indexing on rapid same-path document switches', async () => {
		let finish!: (body: GitReviewFileBody) => void;
		let oldSignal: AbortSignal | undefined;
		const index = vi.fn((body: GitReviewFilePatchBody, signal?: AbortSignal) => {
			if (body.bodyFingerprint.startsWith('old:')) {
				oldSignal = signal;
				return new Promise<GitReviewFileBody>((resolve) => {
					finish = resolve;
				});
			}
			return Promise.resolve(indexed(body));
		});
		const controller = new PullRequestDiffController(index, plainSyntax());
		const old = document('old');
		controller.open(old);
		controller.handleDemand({ documentId: 'old', kind: 'viewport', filePaths: ['a.ts', 'b.ts'] });
		controller.open(document('new'));
		controller.handleDemand({ documentId: 'new', kind: 'viewport', filePaths: ['a.ts'] });
		expect(oldSignal?.aborted).toBe(true);
		finish(indexed(old.fileBodies['a.ts']));
		await vi.waitFor(() => expect(controller.fileBodies['a.ts']?.bodyFingerprint).toBe('new:a.ts'));
		expect(index).toHaveBeenCalledTimes(2);
		controller.close();
	});
	it('cancels work leaving the viewport and retains actionable index errors', async () => {
		let oldSignal: AbortSignal | undefined;
		const index = vi.fn((_body: GitReviewFilePatchBody, signal?: AbortSignal) => {
			if (!oldSignal) {
				oldSignal = signal;
				return new Promise<GitReviewFileBody>((_resolve, reject) =>
					signal?.addEventListener('abort', () =>
						reject(new DOMException('Cancelled', 'AbortError')),
					),
				);
			}
			return Promise.reject(new Error('Synthetic Worker failure'));
		});
		const controller = new PullRequestDiffController(index, plainSyntax());
		controller.open(document('first'));
		controller.handleDemand({ documentId: 'first', kind: 'viewport', filePaths: ['a.ts', 'b.ts'] });
		controller.handleDemand({ documentId: 'first', kind: 'viewport', filePaths: ['c.ts'] });
		expect(oldSignal?.aborted).toBe(true);
		await vi.waitFor(() =>
			expect(controller.fileBodies['c.ts']?.error).toBe('Synthetic Worker failure'),
		);
		expect(index).toHaveBeenCalledTimes(2);
		controller.close();
	});
});

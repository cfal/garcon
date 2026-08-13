import { describe, expect, it, vi } from 'vitest';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import {
	GitDiffSyntaxController,
	type GitDiffSyntaxControllerDependencies,
	type GitDiffSyntaxHighlighterPort,
} from '$lib/git/review/git-diff-syntax-controller.svelte.js';
import {
	gitDiffSyntaxCacheKey,
	type GitDiffFileSyntaxResult,
	type GitDiffSyntaxAttempt,
	type GitDiffSyntaxFileInput,
} from '$lib/git/review/git-diff-syntax.js';

const PATCH = '@@ -1 +1 @@\n-const oldValue = 1;\n+const newValue = 2;\n';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function file(path: string, fingerprint = `fingerprint:${path}`): GitReviewFileSummary {
	return {
		path,
		indexStatus: 'M',
		workTreeStatus: ' ',
		category: 'normal',
		additions: 1,
		deletions: 1,
		estimatedRows: 3,
		bodyState: 'unloaded',
		bodyFingerprint: fingerprint,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function body(path: string, fingerprint = `fingerprint:${path}`): GitReviewFileBody {
	const patchIndex = createGitPatchIndex(PATCH);
	return {
		path,
		bodyFingerprint: fingerprint,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: patchIndex.rowCount,
		patchBytes: PATCH.length,
		patch: PATCH,
		patchIndex,
	};
}

function highlighted(input: GitDiffSyntaxFileInput, weight = 1): GitDiffSyntaxAttempt {
	const result: GitDiffFileSyntaxResult = {
		cacheKey: gitDiffSyntaxCacheKey(input.documentId, input.file, input.body),
		filePath: input.file.path,
		bodyFingerprint: input.body.bodyFingerprint,
		before: {
			path: input.file.originalPath ?? input.file.path,
			languageKey: 'typescript',
			lines: new Map([[0, [{ text: 'const oldValue = 1;', className: 'cm-code-keyword' }]]]),
			characterCount: weight,
			segmentCount: weight,
		},
		after: null,
		characterCount: weight,
		segmentCount: weight,
	};
	return { status: 'highlighted', result };
}

function dependencies(
	highlightGitDiffFile: GitDiffSyntaxHighlighterPort['highlightGitDiffFile'],
	overrides: Partial<GitDiffSyntaxControllerDependencies> = {},
): GitDiffSyntaxControllerDependencies {
	return {
		waitForWorkSlot: async () => {},
		loadHighlighter: async () => ({ highlightGitDiffFile }),
		...overrides,
	};
}

function demand(documentId: string, paths: string[], kind: 'viewport' | 'navigation' = 'viewport') {
	return { kind, documentId, filePaths: paths } as const;
}

async function flushPromises(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('GitDiffSyntaxController demand', () => {
	it('waits for both eligible demand and a matching loaded body', async () => {
		const loadHighlighter = vi.fn(async () => ({ highlightGitDiffFile: vi.fn() }));
		const controller = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter,
		});
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, {});

		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		expect(loadHighlighter).not.toHaveBeenCalled();

		controller.replaceBodies({ 'a.ts': body('a.ts') });
		await flushPromises();
		expect(loadHighlighter).toHaveBeenCalledOnce();
	});

	it('does not highlight a prefetched body without viewport or navigation demand', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value));
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');

		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });
		await flushPromises();

		expect(highlighter).not.toHaveBeenCalled();
	});

	it('waits for the scheduled work slot before importing the highlighter', async () => {
		const workSlot = deferred<void>();
		const loadHighlighter = vi.fn(async () => ({
			highlightGitDiffFile: vi.fn(
				async () =>
					({
						status: 'plain',
						reason: 'unsupported-language',
					}) as const,
			),
		}));
		const controller = new GitDiffSyntaxController({
			waitForWorkSlot: () => workSlot.promise,
			loadHighlighter,
		});
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });

		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		expect(loadHighlighter).not.toHaveBeenCalled();

		workSlot.resolve();
		await flushPromises();
		expect(loadHighlighter).toHaveBeenCalledOnce();
	});

	it('caches an ineligible demand without importing the highlighter', async () => {
		const loadHighlighter = vi.fn(async () => ({ highlightGitDiffFile: vi.fn() }));
		const generated = {
			...file('generated.ts'),
			category: 'generated' as const,
			isGenerated: true,
		};
		const controller = new GitDiffSyntaxController({
			waitForWorkSlot: async () => {},
			loadHighlighter,
		});
		controller.open(
			{ documentId: 'doc', files: [generated] },
			{ 'generated.ts': body('generated.ts') },
		);

		controller.handleDemand(demand('doc', ['generated.ts']));
		await flushPromises();

		expect(loadHighlighter).not.toHaveBeenCalled();
	});

	it('deduplicates duplicate viewport and navigation demand', async () => {
		const pending = deferred<GitDiffSyntaxAttempt>();
		const highlighter = vi.fn(() => pending.promise);
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });

		controller.handleDemand(demand('doc', ['a.ts']));
		controller.handleDemand(demand('doc', ['a.ts'], 'navigation'));
		await flushPromises();

		expect(highlighter).toHaveBeenCalledOnce();
		pending.resolve(highlighted(highlighter.mock.calls[0][0]));
		await flushPromises();
	});

	it('runs files sequentially and prioritizes navigation over queued viewport work', async () => {
		const attempts = new Map<string, Deferred<GitDiffSyntaxAttempt>>();
		const order: string[] = [];
		const highlighter = vi.fn((value: GitDiffSyntaxFileInput) => {
			order.push(value.file.path);
			const pending = deferred<GitDiffSyntaxAttempt>();
			attempts.set(value.file.path, pending);
			return pending.promise;
		});
		const files = [file('a.ts'), file('b.ts'), file('c.ts')];
		const bodies = Object.fromEntries(files.map((value) => [value.path, body(value.path)]));
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		controller.open({ documentId: 'doc', files }, bodies);

		controller.handleDemand(demand('doc', ['a.ts', 'b.ts']));
		await flushPromises();
		controller.handleDemand(demand('doc', ['c.ts'], 'navigation'));
		attempts.get('a.ts')?.resolve(highlighted(highlighter.mock.calls[0][0]));
		await flushPromises();

		expect(order).toEqual(['a.ts', 'c.ts']);
		attempts.get('c.ts')?.resolve(highlighted(highlighter.mock.calls[1][0]));
		await flushPromises();
		expect(order).toEqual(['a.ts', 'c.ts', 'b.ts']);
		attempts.get('b.ts')?.resolve(highlighted(highlighter.mock.calls[2][0]));
		await flushPromises();
	});
});

describe('GitDiffSyntaxController stale work', () => {
	it('discards a result after document replacement', async () => {
		const pending = deferred<GitDiffSyntaxAttempt>();
		const highlighter = vi.fn(() => pending.promise);
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileA = file('a.ts');
		controller.open({ documentId: 'doc-a', files: [fileA] }, { 'a.ts': body('a.ts') });
		controller.handleDemand(demand('doc-a', ['a.ts']));
		await flushPromises();
		const oldInput = highlighter.mock.calls[0][0];

		controller.open({ documentId: 'doc-b', files: [file('b.ts')] }, { 'b.ts': body('b.ts') });
		pending.resolve(highlighted(oldInput));
		await flushPromises();

		expect(controller.results).toEqual({});
	});

	it('discards a result after body fingerprint replacement and accepts the new key', async () => {
		const attempts: Deferred<GitDiffSyntaxAttempt>[] = [];
		const highlighter = vi.fn(() => {
			const pending = deferred<GitDiffSyntaxAttempt>();
			attempts.push(pending);
			return pending.promise;
		});
		const oldFile = file('a.ts', 'old');
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		controller.open({ documentId: 'doc', files: [oldFile] }, { 'a.ts': body('a.ts', 'old') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		const oldInput = highlighter.mock.calls[0][0];

		const newFile = file('a.ts', 'new');
		controller.open({ documentId: 'doc', files: [newFile] }, { 'a.ts': body('a.ts', 'new') });
		controller.handleDemand(demand('doc', ['a.ts']));
		attempts[0].resolve(highlighted(oldInput));
		await flushPromises();
		const newInput = highlighter.mock.calls[1][0];
		attempts[1].resolve(highlighted(newInput));
		await flushPromises();

		expect(controller.results['a.ts']?.bodyFingerprint).toBe('new');
	});

	it('rejects a highlighted result with mismatched identity fields', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => {
			const attempt = highlighted(value);
			if (attempt.status !== 'highlighted') return attempt;
			return { ...attempt, result: { ...attempt.result, cacheKey: 'wrong' } };
		});
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });

		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();

		expect(controller.results).toEqual({});
	});
});

describe('GitDiffSyntaxController cache lifecycle', () => {
	it('reactivates a cached result after body eviction and reload', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value));
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		expect(controller.results['a.ts']).toBeDefined();

		controller.replaceBodies({});
		expect(controller.results['a.ts']).toBeUndefined();
		controller.replaceBodies({ 'a.ts': body('a.ts') });
		await flushPromises();

		expect(controller.results['a.ts']).toBeDefined();
		expect(highlighter).toHaveBeenCalledOnce();
	});

	it('caches terminal plain attempts without retrying on later demand', async () => {
		const highlighter = vi.fn(async () => ({ status: 'plain', reason: 'parse-timeout' }) as const);
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });

		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		controller.handleDemand(demand('doc', []));
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();

		expect(highlighter).toHaveBeenCalledOnce();
	});

	it('preserves cache on close but clears it on reset', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value));
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		const fileValue = file('a.ts');
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();

		controller.close({ preserveCache: true });
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		expect(highlighter).toHaveBeenCalledOnce();

		controller.reset();
		controller.open({ documentId: 'doc', files: [fileValue] }, { 'a.ts': body('a.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		expect(highlighter).toHaveBeenCalledTimes(2);
	});

	it('removes active and cached data on explicit invalidation and path pruning', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value));
		const files = [file('a.ts'), file('b.ts')];
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		controller.open({ documentId: 'doc', files }, { 'a.ts': body('a.ts'), 'b.ts': body('b.ts') });
		controller.handleDemand(demand('doc', ['a.ts', 'b.ts']));
		await flushPromises();

		controller.replaceBodies({ 'b.ts': body('b.ts') });
		controller.invalidateFile('a.ts');
		controller.pruneToFilePaths(new Set(['b.ts']));

		expect(controller.results['a.ts']).toBeUndefined();
		expect(controller.results['b.ts']).toBeDefined();
	});

	it.each([
		{ files: 1, characters: 100, segments: 100 },
		{ files: 10, characters: 3, segments: 100 },
		{ files: 10, characters: 100, segments: 3 },
	])('enforces the cache limits %j', async (limits) => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value, 2));
		const files = [file('a.ts'), file('b.ts')];
		const controller = new GitDiffSyntaxController(dependencies(highlighter), limits);
		controller.open({ documentId: 'doc', files }, { 'a.ts': body('a.ts'), 'b.ts': body('b.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		controller.handleDemand(demand('doc', ['b.ts']));
		await flushPromises();

		expect(controller.results['a.ts']).toBeUndefined();
		expect(controller.results['b.ts']).toBeDefined();
	});

	it('publishes immutable result records', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => highlighted(value));
		const files = [file('a.ts'), file('b.ts')];
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		controller.open({ documentId: 'doc', files }, { 'a.ts': body('a.ts'), 'b.ts': body('b.ts') });
		controller.handleDemand(demand('doc', ['a.ts']));
		await flushPromises();
		const firstResults = controller.results;

		controller.handleDemand(demand('doc', ['a.ts', 'b.ts']));
		await flushPromises();

		expect(controller.results).not.toBe(firstResults);
		expect(firstResults['b.ts']).toBeUndefined();
		expect(controller.results['b.ts']).toBeDefined();
	});

	it('contains a thrown highlighter and continues the queue', async () => {
		const highlighter = vi.fn(async (value: GitDiffSyntaxFileInput) => {
			if (value.file.path === 'a.ts') throw new Error('parser failed');
			return highlighted(value);
		});
		const files = [file('a.ts'), file('b.ts')];
		const controller = new GitDiffSyntaxController(dependencies(highlighter));
		controller.open({ documentId: 'doc', files }, { 'a.ts': body('a.ts'), 'b.ts': body('b.ts') });

		controller.handleDemand(demand('doc', ['a.ts', 'b.ts']));
		await flushPromises();

		expect(controller.results['a.ts']).toBeUndefined();
		expect(controller.results['b.ts']).toBeDefined();
		expect(highlighter).toHaveBeenCalledTimes(2);
	});
});

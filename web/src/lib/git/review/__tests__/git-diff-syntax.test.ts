import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type { LoadedCodeMirrorLanguage } from '$lib/highlighting/codemirror-language-registry.js';
import { loadCodeMirrorLanguageForFile } from '$lib/highlighting/codemirror-language-registry.js';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import {
	GIT_DIFF_SYNTAX_LIMITS,
	buildGitDiffSyntheticSides,
	gitDiffSyntaxCacheKey,
	gitDiffSyntaxSkipReason,
	waitForGitDiffSyntaxWorkSlot,
	type GitDiffSyntheticSide,
	type GitDiffSyntaxFileInput,
	type GitDiffSyntaxSideAttempt,
} from '$lib/git/review/git-diff-syntax.js';
import {
	highlightGitDiffFile,
	highlightGitDiffSyntheticSide,
	type GitDiffSyntaxHighlightDependencies,
} from '$lib/git/review/git-diff-syntax-highlighter.js';

const PATCH = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 function example() {
-\tconst oldValue = "old";
+\tconst newValue = "new";
 }
@@ -10 +10 @@
-const tail = false;
+const tail = true;
`;

function file(
	path = 'src/example.ts',
	overrides: Partial<GitReviewFileSummary> = {},
): GitReviewFileSummary {
	return {
		path,
		indexStatus: 'M',
		workTreeStatus: ' ',
		category: 'normal',
		additions: 2,
		deletions: 2,
		estimatedRows: 9,
		bodyState: 'unloaded',
		bodyFingerprint: `fingerprint:${path}`,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
		...overrides,
	};
}

function body(
	path = 'src/example.ts',
	patch = PATCH,
	overrides: Partial<GitReviewFileBody> = {},
): GitReviewFileBody {
	const patchIndex = createGitPatchIndex(patch);
	return {
		path,
		bodyFingerprint: `fingerprint:${path}`,
		bodyState: 'loaded',
		category: 'normal',
		isBinary: false,
		isTooLarge: false,
		renderedRowCount: patchIndex.rowCount,
		patchBytes: new TextEncoder().encode(patch).byteLength,
		patch,
		patchIndex,
		...overrides,
	};
}

function input(
	fileValue = file(),
	bodyValue = body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint }),
): GitDiffSyntaxFileInput {
	return { documentId: 'document:syntax', file: fileValue, body: bodyValue };
}

function projectSide(
	side: GitDiffSyntheticSide,
	path: string,
	loaded: LoadedCodeMirrorLanguage,
): GitDiffSyntaxSideAttempt {
	return {
		status: 'highlighted',
		result: {
			path,
			languageKey: loaded.key,
			lines: new Map(
				side.lines.flatMap((line) =>
					line.diffLineIndex === null
						? []
						: [[line.diffLineIndex, [{ text: line.text, className: null }]] as const],
				),
			),
			characterCount: side.characterCount,
			segmentCount: side.lines.filter((line) => line.diffLineIndex !== null).length,
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('Git diff syntax reconstruction', () => {
	it('builds independent before and after snippets with unmapped hunk separators', () => {
		const reconstructed = buildGitDiffSyntheticSides(body());

		expect(reconstructed.sides.before?.text).toBe(
			'function example() {\n\tconst oldValue = "old";\n}\n\nconst tail = false;',
		);
		expect(reconstructed.sides.after?.text).toBe(
			'function example() {\n\tconst newValue = "new";\n}\n\nconst tail = true;',
		);
		expect(reconstructed.sides.before?.lines.map((line) => line.diffLineIndex)).toEqual([
			0,
			1,
			3,
			null,
			4,
		]);
		expect(reconstructed.sides.after?.lines.map((line) => line.diffLineIndex)).toEqual([
			0,
			2,
			3,
			null,
			5,
		]);
	});

	it('preserves mapped empty rows separately from hunk separators', () => {
		const patch = `@@ -1,2 +1,2 @@\n context\n-\n+replacement\n`;
		const reconstructed = buildGitDiffSyntheticSides(body('empty.ts', patch));

		expect(reconstructed.sides.before?.lines).toEqual([
			{ text: 'context', diffLineIndex: 0 },
			{ text: '', diffLineIndex: 1 },
		]);
	});

	it('discards only the synthetic side that exceeds its character budget', () => {
		const longDeletion = 'x'.repeat(GIT_DIFF_SYNTAX_LIMITS.maxSyntheticCharactersPerSide + 1);
		const patch = `@@ -1 +1 @@\n-${longDeletion}\n+const next = true;\n`;
		const reconstructed = buildGitDiffSyntheticSides(body('large.ts', patch));

		expect(reconstructed.beforeExceeded).toBe(true);
		expect(reconstructed.sides.before).toBeNull();
		expect(reconstructed.sides.after?.text).toBe('const next = true;');
	});
});

describe('Git diff syntax eligibility', () => {
	it.each<[Partial<GitReviewFileSummary>, 'excluded']>([
		[{ category: 'generated', isGenerated: true }, 'excluded'],
		[{ category: 'lockfile' }, 'excluded'],
		[{ category: 'binary', isBinary: true }, 'excluded'],
		[{ category: 'large', isTooLarge: true }, 'excluded'],
	])('skips excluded file metadata %j', (overrides, reason) => {
		const fileValue = file('asset.ts', overrides);

		expect(
			gitDiffSyntaxSkipReason(
				input(
					fileValue,
					body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint }),
				),
			),
		).toBe(reason);
	});

	it('skips row-heavy bodies before loading a language', () => {
		const bodyValue = body('large.ts', PATCH, {
			renderedRowCount: GIT_DIFF_SYNTAX_LIMITS.maxRenderedRows + 1,
		});

		expect(gitDiffSyntaxSkipReason(input(file('large.ts'), bodyValue))).toBe('row-limit');
	});

	it('keys results by version, document, fingerprint, and both rename paths', () => {
		const fileValue = file('src/after.py', { originalPath: 'src/before.js' });
		const bodyValue = body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint });

		expect(JSON.parse(gitDiffSyntaxCacheKey('doc', fileValue, bodyValue))).toEqual([
			1,
			'doc',
			fileValue.bodyFingerprint,
			'src/before.js',
			'src/after.py',
		]);
	});
});

describe('Git diff syntax highlighting', () => {
	it('highlights a multiline side and preserves every source character', async () => {
		const loaded = await loadCodeMirrorLanguageForFile('src/example.ts');
		const side = buildGitDiffSyntheticSides(body()).sides.after;
		expect(loaded).not.toBeNull();
		expect(side).not.toBeNull();
		if (!loaded || !side) return;
		loaded.language.parser.parse(side.text);

		const result = highlightGitDiffSyntheticSide(side, 'src/example.ts', loaded);

		expect(result.status).toBe('highlighted');
		if (result.status !== 'highlighted') return;
		for (const line of side.lines) {
			if (line.diffLineIndex === null) continue;
			expect(
				result.result.lines
					.get(line.diffLineIndex)
					?.map((segment) => segment.text)
					.join(''),
			).toBe(line.text);
		}
		expect(
			Array.from(result.result.lines.values()).some((segments) =>
				segments.some((segment) => segment.className === 'cm-code-keyword'),
			),
		).toBe(true);
	});

	it('retains multiline parser state when the opener is present in hunk context', async () => {
		const patch = '@@ -1,3 +1,3 @@\n value = """\n-old\n+new\n """\n';
		const side = buildGitDiffSyntheticSides(body('example.py', patch)).sides.after;
		const loaded = await loadCodeMirrorLanguageForFile('example.py');
		expect(side).not.toBeNull();
		expect(loaded).not.toBeNull();
		if (!side || !loaded) return;
		loaded.language.parser.parse(side.text);

		const result = highlightGitDiffSyntheticSide(side, 'example.py', loaded);

		expect(result.status).toBe('highlighted');
		if (result.status !== 'highlighted') return;
		expect(
			result.result.lines
				.get(2)
				?.map((segment) => segment.text)
				.join(''),
		).toBe('new');
		expect(
			result.result.lines
				.get(2)
				?.some((segment) => segment.className?.split(/\s+/).includes('cm-code-string')),
		).toBe(true);
	});

	it('loads distinct before and after languages for a rename', async () => {
		const fileValue = file('src/after.py', { originalPath: 'src/before.js' });
		const bodyValue = body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint });
		const loadedPaths: string[] = [];
		const deps: GitDiffSyntaxHighlightDependencies = {
			loadLanguage: async (path) => {
				loadedPaths.push(path);
				return loadCodeMirrorLanguageForFile(path);
			},
			waitForWorkSlot: async () => {},
			highlightSide: projectSide,
		};

		const result = await highlightGitDiffFile(
			input(fileValue, bodyValue),
			new AbortController().signal,
			deps,
		);

		expect(result.status).toBe('highlighted');
		expect(loadedPaths).toEqual(['src/after.py', 'src/before.js']);
		if (result.status !== 'highlighted') return;
		expect(result.result.before?.languageKey).toBe('javascript');
		expect(result.result.after?.languageKey).toBe('python');
	});

	it('returns a partial result when one side is unsupported', async () => {
		const fileValue = file('src/after.ts', { originalPath: 'src/before.unknown' });
		const bodyValue = body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint });
		const deps: GitDiffSyntaxHighlightDependencies = {
			loadLanguage: loadCodeMirrorLanguageForFile,
			waitForWorkSlot: async () => {},
			highlightSide: projectSide,
		};

		const result = await highlightGitDiffFile(
			input(fileValue, bodyValue),
			new AbortController().signal,
			deps,
		);

		expect(result.status).toBe('highlighted');
		if (result.status !== 'highlighted') return;
		expect(result.result.before).toBeNull();
		expect(result.result.after?.lines.size).toBeGreaterThan(0);
	});

	it.each([
		['@@ -0,0 +1 @@\n+const added = true;\n', 'after'],
		['@@ -1 +0,0 @@\n-const deleted = true;\n', 'before'],
	] as const)('loads only the existing side for %s', async (patch, expectedSide) => {
		const loadLanguage = vi.fn(loadCodeMirrorLanguageForFile);
		const fileValue = file('single.ts');
		const bodyValue = body(fileValue.path, patch, { bodyFingerprint: fileValue.bodyFingerprint });

		const result = await highlightGitDiffFile(
			input(fileValue, bodyValue),
			new AbortController().signal,
			{
				loadLanguage,
				waitForWorkSlot: async () => {},
				highlightSide: projectSide,
			},
		);

		expect(result.status).toBe('highlighted');
		expect(loadLanguage).toHaveBeenCalledOnce();
		if (result.status !== 'highlighted') return;
		expect(result.result[expectedSide]).not.toBeNull();
		expect(result.result[expectedSide === 'after' ? 'before' : 'after']).toBeNull();
	});

	it('keeps the other side when one synthetic side exceeds the character limit', async () => {
		const deletion = 'x'.repeat(GIT_DIFF_SYNTAX_LIMITS.maxSyntheticCharactersPerSide + 1);
		const patch = `@@ -1 +1 @@\n-${deletion}\n+const next = true;\n`;
		const fileValue = file('large.ts');
		const bodyValue = body(fileValue.path, patch, { bodyFingerprint: fileValue.bodyFingerprint });

		const result = await highlightGitDiffFile(
			input(fileValue, bodyValue),
			new AbortController().signal,
			{
				loadLanguage: loadCodeMirrorLanguageForFile,
				waitForWorkSlot: async () => {},
				highlightSide: projectSide,
			},
		);

		expect(result.status).toBe('highlighted');
		if (result.status !== 'highlighted') return;
		expect(result.result.before).toBeNull();
		expect(result.result.after).not.toBeNull();
	});

	it.each(['parse-timeout', 'segment-limit', 'invalid-segment-text', 'error'] as const)(
		'falls back to plain text for a %s side outcome',
		async (reason) => {
			const loaded = await loadCodeMirrorLanguageForFile('src/example.ts');
			const deps: GitDiffSyntaxHighlightDependencies = {
				loadLanguage: async () => loaded,
				waitForWorkSlot: async () => {},
				highlightSide: () => ({ status: 'plain', reason }),
			};

			await expect(
				highlightGitDiffFile(input(), new AbortController().signal, deps),
			).resolves.toEqual({ status: 'plain', reason });
		},
	);

	it('does not load a language for an ineligible file', async () => {
		const loadLanguage = vi.fn(loadCodeMirrorLanguageForFile);
		const fileValue = file('generated.ts', { category: 'generated', isGenerated: true });
		const bodyValue = body(fileValue.path, PATCH, { bodyFingerprint: fileValue.bodyFingerprint });

		await expect(
			highlightGitDiffFile(input(fileValue, bodyValue), new AbortController().signal, {
				loadLanguage,
				waitForWorkSlot: async () => {},
				highlightSide: projectSide,
			}),
		).resolves.toEqual({ status: 'plain', reason: 'excluded' });
		expect(loadLanguage).not.toHaveBeenCalled();
	});

	it('cancels after a deferred language load without parsing', async () => {
		let resolveLanguage!: (value: LoadedCodeMirrorLanguage | null) => void;
		const pendingLanguage = new Promise<LoadedCodeMirrorLanguage | null>((resolve) => {
			resolveLanguage = resolve;
		});
		const abort = new AbortController();
		const highlightSide = vi.fn(projectSide);
		const attempt = highlightGitDiffFile(input(), abort.signal, {
			loadLanguage: () => pendingLanguage,
			waitForWorkSlot: async () => {},
			highlightSide,
		});

		abort.abort();
		resolveLanguage(await loadCodeMirrorLanguageForFile('src/example.ts'));

		await expect(attempt).resolves.toEqual({ status: 'cancelled' });
		expect(highlightSide).not.toHaveBeenCalled();
	});

	it('contains patch-index and parser exceptions as plain text outcomes', async () => {
		const bodyValue = body();
		const malformedBody: GitReviewFileBody = {
			...bodyValue,
			get patchIndex(): never {
				throw new Error('malformed patch');
			},
		};

		await expect(
			highlightGitDiffFile(input(file(), malformedBody), new AbortController().signal, {
				loadLanguage: loadCodeMirrorLanguageForFile,
				waitForWorkSlot: async () => {},
				highlightSide: projectSide,
			}),
		).resolves.toEqual({ status: 'plain', reason: 'error' });

		await expect(
			highlightGitDiffFile(input(), new AbortController().signal, {
				loadLanguage: loadCodeMirrorLanguageForFile,
				waitForWorkSlot: async () => {},
				highlightSide: () => {
					throw new Error('parser failed');
				},
			}),
		).resolves.toEqual({ status: 'plain', reason: 'error' });
	});
});

describe('Git diff syntax work slots', () => {
	it('uses the timer fallback when requestIdleCallback is unavailable', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('requestIdleCallback', undefined);
		const pending = waitForGitDiffSyntaxWorkSlot(new AbortController().signal);
		let finished = false;
		void pending.then(() => {
			finished = true;
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(finished).toBe(true);
	});

	it('resolves promptly when a pending work slot is aborted', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('requestIdleCallback', undefined);
		const abort = new AbortController();
		const pending = waitForGitDiffSyntaxWorkSlot(abort.signal);

		abort.abort();

		await expect(pending).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});

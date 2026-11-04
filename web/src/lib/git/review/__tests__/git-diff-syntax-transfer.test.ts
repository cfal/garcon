import { describe, expect, it } from 'vitest';
import { createGitPatchIndex, getGitSplitPatchIndex } from '../git-patch-index.js';
import { highlightGitDiffFile } from '../git-diff-syntax-highlighter.js';
import {
	gitDiffSyntaxTransferBuffers,
	packGitDiffSyntax,
	restoreGitDiffSyntax,
} from '../git-diff-syntax-transfer.js';
import type { GitDiffSyntaxAttempt } from '../git-diff-syntax.js';

describe('compact syntax transfer', () => {
	it.each<GitDiffSyntaxAttempt>([
		{ status: 'cancelled' },
		{ status: 'plain', reason: 'segment-limit' },
	])('preserves $status outcomes', (attempt) => {
		const packed = packGitDiffSyntax(attempt);
		expect(gitDiffSyntaxTransferBuffers(packed)).toEqual([]);
		expect(restoreGitDiffSyntax(structuredClone(packed))).toEqual(attempt);
	});

	it('transfers UTF-16 segments, empty lines, and separated hunks without rich row cloning', async () => {
		const patch =
			'@@ -1,3 +1,3 @@\n const text = "\u4e2d\ud83d\ude80e\u0301";\r\n-\n+const next = true;\n \n@@ -100 +100 @@\n-const old = 1;\n+const updated = 2;\n';
		const index = createGitPatchIndex(patch);
		const file = {
			path: 'synthetic.ts',
			bodyFingerprint: 'synthetic',
			category: 'normal' as const,
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
		};
		const original = await highlightGitDiffFile(
			{
				documentId: 'synthetic',
				file,
				body: {
					...file,
					bodyState: 'loaded',
					patch,
					patchBytes: patch.length,
					renderedRowCount: index.rowCount,
					patchIndex: index,
				},
			},
			new AbortController().signal,
		);
		expect(original.status).toBe('highlighted');
		if (original.status !== 'highlighted') throw new Error('Expected syntax');
		const packed = packGitDiffSyntax(original);
		const transfer = gitDiffSyntaxTransferBuffers(packed);
		expect(transfer).toHaveLength(8);
		const copied = structuredClone(packed, { transfer });
		expect(transfer.every((buffer) => buffer.byteLength === 0)).toBe(true);
		const restored = restoreGitDiffSyntax(copied);
		if (restored.status !== 'highlighted') throw new Error('Expected restored syntax');
		for (const side of ['before', 'after'] as const) {
			const expected = original.result[side]!;
			const actual = restored.result[side]!;
			expect({ ...actual, lines: [...actual.lines] }).toEqual({
				...expected,
				lines: [...expected.lines],
			});
			expect([...actual.lines.keys()]).toEqual([...expected.lines.keys()]);
			expect([...actual.lines.values()]).toEqual([...expected.lines.values()]);
			for (const line of [NaN, Infinity, -1, 0.5, 10000]) {
				expect(actual.lines.has(line)).toBe(false);
				expect(actual.lines.get(line)).toBeUndefined();
			}
			const visited: number[] = [];
			actual.lines.forEach(function (this: number[], value, key, map) {
				expect(this).toBe(visited);
				expect(map).toBe(actual.lines);
				expect(value).toEqual(expected.lines.get(key));
				visited.push(key);
			}, visited);
			expect(visited).toEqual([...expected.lines.keys()]);
		}
		const split = getGitSplitPatchIndex(index);
		for (let row = 0; row < index.rowCount; row += 1) {
			const unified = index.rowAt(row);
			if (unified.kind === 'hunk') continue;
			for (const side of ['before', 'after'] as const) {
				expect(restored.result[side]?.lines.get(unified.diffLineIndex)).toEqual(
					original.result[side]?.lines.get(unified.diffLineIndex),
				);
			}
		}
		expect(split.rowCount).toBeLessThan(index.rowCount);
	});
});

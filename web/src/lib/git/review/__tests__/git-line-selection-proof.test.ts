import { describe, expect, it } from 'vitest';
import { GitLineSelectionState, makeLineSelectionKey } from '../git-line-selection.svelte.js';
import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';

const target: GitDiffActionTarget = {
	filePath: 'file.ts',
	tab: 'unstaged',
	mode: 'stage',
	contextLines: 5,
	proof: {
		document: { executorId: 'remote', instanceId: 'instance-a', documentId: 'document-a' },
		bodyFingerprint: 'fingerprint',
		patchDigest: 'a'.repeat(64),
	},
};

describe('partial staging selection provenance', () => {
	it('updates proof once per range and excludes keys from other files or tabs', () => {
		const selection = new GitLineSelectionState();
		const key = (index: number) => makeLineSelectionKey('file.ts', 'unstaged', 'after', index);
		selection.toggleLineSelection(key(0), target);
		const replacement = {
			...target,
			proof: { ...target.proof, document: { ...target.proof.document, instanceId: 'replacement' } },
		};
		const validKeys = Array.from({ length: 2_000 }, (_, index) => key(index + 1));
		const mixed = [
			validKeys[0],
			makeLineSelectionKey('other.ts', 'unstaged', 'after', 1),
			makeLineSelectionKey('file.ts', 'staged', 'after', 1),
			...validKeys.slice(1),
		];
		selection.selectLineRange(key(1), key(2_000), mixed, replacement);
		expect(selection.selectedLineKeys).toEqual(new Set(validKeys));
		const selected = selection.selectedLineKeys;
		selection.pruneToFilePaths(new Set(['file.ts']));
		expect(selection.selectedLineKeys).toBe(selected);
		expect(selection.groupSelectedLineIndicesByTarget('stage')).toEqual([
			{ target: replacement, lineIndices: Array.from({ length: 2_000 }, (_, index) => index + 1) },
		]);
	});

	it('captures the displayed proof and discards old indices after a body change', () => {
		const selection = new GitLineSelectionState();
		selection.toggleLineSelection(makeLineSelectionKey('file.ts', 'unstaged', 'after', 1), target);
		expect(selection.groupSelectedLineIndicesByTarget('stage')).toEqual([
			{ target, lineIndices: [1] },
		]);
		const replacement = { ...target, proof: { ...target.proof, patchDigest: 'b'.repeat(64) } };
		selection.toggleLineSelection(
			makeLineSelectionKey('file.ts', 'unstaged', 'after', 5),
			replacement,
		);
		expect(selection.groupSelectedLineIndicesByTarget('stage')).toEqual([
			{ target: replacement, lineIndices: [5] },
		]);
	});
});

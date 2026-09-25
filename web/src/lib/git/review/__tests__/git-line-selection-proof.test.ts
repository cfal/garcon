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

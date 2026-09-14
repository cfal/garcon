import { describe, expect, it } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';

function document() {
	return new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'src/file.ts' },
		'["/workspace","src/file.ts"]',
	);
}

describe('FileDocumentState', () => {
	it('owns buffer dirtiness without a mounted editor', () => {
		const value = document();
		value.baseline = 'initial';
		value.content = 'changed';

		expect(value.currentContent()).toBe('changed');
		expect(value.dirty).toBe(true);
		expect(value.bufferVersion).toBe(1);
	});

	it('guards destructive mutations only during live operations', () => {
		const value = document();
		value.saving = true;
		expect(value.mutationGuarded).toBe(true);
		value.saving = false;
		value.recoveryError = 'storage unavailable';
		expect(value.mutationGuarded).toBe(false);
	});
});

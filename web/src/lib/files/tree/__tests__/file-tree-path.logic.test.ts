import { describe, expect, it } from 'vitest';
import { filePathRelativeToTreeRoot } from '../file-tree-path.js';

describe('file tree paths', () => {
	it('projects repository-relative files under the explorer root', () => {
		expect(filePathRelativeToTreeRoot('/workspace', '/workspace/repo', 'src/index.ts')).toBe(
			'repo/src/index.ts',
		);
	});

	it('preserves paths already relative to the explorer root', () => {
		expect(filePathRelativeToTreeRoot('/workspace', '/workspace', 'src/index.ts')).toBe(
			'src/index.ts',
		);
	});

	it('rejects files outside the explorer root and normalizes Windows separators', () => {
		expect(filePathRelativeToTreeRoot('/workspace', '/sibling', 'index.ts')).toBeNull();
		expect(filePathRelativeToTreeRoot('C:\\work', 'c:\\work\\repo', 'src\\index.ts')).toBe(
			'repo/src/index.ts',
		);
	});
});

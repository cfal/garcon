import { describe, expect, it } from 'vitest';
import type { FileTreeEntry } from '$shared/file-contracts';
import {
	FILE_TREE_COLD_BYTE_LIMIT,
	FILE_TREE_COLD_DIRECTORY_LIMIT,
	FILE_TREE_COLD_ROW_LIMIT,
	pruneFileTreeCache,
} from '../file-tree-cache';

function entry(name = 'synthetic.txt'): FileTreeEntry {
	return {
		name,
		path: `/project/${name}`,
		relativePath: name,
		type: 'file',
		size: 1,
		modified: null,
		permissionsRwx: '-rw-r--r--',
	};
}

describe('cold file tree listings', () => {
	it('keeps recent collapsed directories without evicting expanded demand', () => {
		const cache = new Map<string, FileTreeEntry[]>([['visible', [entry()]]]);
		for (let index = 0; index <= FILE_TREE_COLD_DIRECTORY_LIMIT; index += 1)
			cache.set(`cold-${index}`, []);
		const retained = pruneFileTreeCache(cache, new Set(['visible']));
		expect(retained.size).toBe(FILE_TREE_COLD_DIRECTORY_LIMIT + 1);
		expect(retained.has('visible')).toBe(true);
		expect(retained.has('cold-0')).toBe(false);
		expect(retained.has(`cold-${FILE_TREE_COLD_DIRECTORY_LIMIT}`)).toBe(true);
		expect(cache.has('cold-0')).toBe(true);
	});

	it('bounds aggregate rows and rejects oversized cold listings', () => {
		const rows = Array.from({ length: FILE_TREE_COLD_ROW_LIMIT }, () => entry());
		const cache = new Map([
			['old', [entry()]],
			['latest', rows],
			['oversized', [...rows, entry()]],
		]);
		const retained = pruneFileTreeCache(cache, new Set());
		expect([...retained.keys()]).toEqual(['latest']);
		expect(pruneFileTreeCache(cache, new Set(['oversized'])).has('oversized')).toBe(true);
	});

	it('accounts for long paths as well as directory and row counts', () => {
		const large = entry('x'.repeat(FILE_TREE_COLD_BYTE_LIMIT / 6));
		const cache = new Map([
			['large', [large]],
			['small', [entry()]],
		]);
		expect([...pruneFileTreeCache(cache, new Set()).keys()]).toEqual(['small']);
	});

	it('preserves map identity when no eviction is necessary', () => {
		const cache = new Map([['one', [entry()]]]);
		expect(pruneFileTreeCache(cache, new Set())).toBe(cache);
	});
});

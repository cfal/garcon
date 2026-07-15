import { describe, expect, it } from 'vitest';
import { buildVisibleFileRows, filterFileRows } from '$lib/files/tree/file-tree-rows.js';
import type { FileTreeEntry } from '$shared/file-contracts';

function entry(name: string, type: 'file' | 'directory', parent = '/root'): FileTreeEntry {
	return {
		name,
		path: `${parent}/${name}`,
		relativePath: `${parent.slice(1)}/${name}`,
		type,
		size: 1,
		modified: null,
		permissionsRwx: 'rw-r--r--',
	};
}

describe('file tree rows', () => {
	const src = entry('src', 'directory');
	const lib = entry('lib', 'directory', src.path);
	const app = entry('App.svelte', 'file', lib.path);
	const readme = entry('README.md', 'file');
	const children = new Map([
		[src.path, [lib]],
		[lib.path, [app]],
	]);
	const sortEntries = (entries: readonly FileTreeEntry[]) =>
		[...entries].sort((left, right) => left.name.localeCompare(right.name));

	it('flattens expanded children in display order with ancestry', () => {
		const rows = buildVisibleFileRows({
			rootEntries: [src, readme],
			childrenByDirectory: children,
			expandedDirectories: new Set([src.path, lib.path]),
			sortEntries,
		});

		expect(rows.map((row) => row.entry.name)).toEqual(['README.md', 'src', 'lib', 'App.svelte']);
		expect(rows.at(-1)).toMatchObject({
			level: 3,
			parentKey: rows[2]?.key,
			ancestorKeys: [rows[1]?.key, rows[2]?.key],
		});
	});

	it('does not materialize cached descendants of collapsed directories', () => {
		const rows = buildVisibleFileRows({
			rootEntries: [src],
			childrenByDirectory: children,
			expandedDirectories: new Set(),
			sortEntries,
		});

		expect(rows.map((row) => row.entry.name)).toEqual(['src']);
	});

	it('filters names case-insensitively and retains materialized ancestors', () => {
		const rows = buildVisibleFileRows({
			rootEntries: [src, readme],
			childrenByDirectory: children,
			expandedDirectories: new Set([src.path, lib.path]),
			sortEntries,
		});

		expect(filterFileRows(rows, 'APP').map((row) => row.entry.name)).toEqual([
			'src',
			'lib',
			'App.svelte',
		]);
		expect(filterFileRows(rows, 'missing')).toEqual([]);
	});

	it('uses occurrence-specific keys for the same canonical children under aliases', () => {
		const alias = entry('alias', 'directory');
		const real = entry('real', 'directory');
		const canonicalChild = entry('shared.ts', 'file', real.path);
		const rows = buildVisibleFileRows({
			rootEntries: [alias, real],
			childrenByDirectory: new Map([
				[alias.path, [canonicalChild]],
				[real.path, [canonicalChild]],
			]),
			expandedDirectories: new Set([alias.path, real.path]),
			sortEntries,
		});

		const sharedRows = rows.filter((row) => row.entry.path === canonicalChild.path);
		expect(sharedRows).toHaveLength(2);
		expect(new Set(sharedRows.map((row) => row.key)).size).toBe(2);
	});

	it('stops materializing a branch when it points back to an ancestor path', () => {
		const self = entry('self', 'directory');
		const rows = buildVisibleFileRows({
			rootEntries: [self],
			childrenByDirectory: new Map([[self.path, [self]]]),
			expandedDirectories: new Set([self.path]),
			sortEntries,
		});

		expect(rows.map((row) => row.entry.name)).toEqual(['self']);
	});
});

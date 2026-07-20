import { describe, expect, it } from 'vitest';
import type { FileTreeEntry } from '$shared/file-contracts';
import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import {
	buildFileTreeRenderModel,
	FILE_TREE_PARENT_ROW_KEY,
	isFileTreeRenderRowFocusable,
} from '$lib/files/tree/file-tree-render-rows.js';

function row(name: string, type: 'file' | 'directory', level = 1): FileTableRow {
	const entry: FileTreeEntry = {
		name,
		path: `/workspace/${name}`,
		relativePath: name,
		type,
		size: 1,
		modified: null,
		permissionsRwx: 'rw-r--r--',
	};
	return { kind: 'entry', key: entry.path, entry, level, parentKey: null, ancestorKeys: [] };
}

describe('file tree render rows', () => {
	it('projects parent, entries, and child state into one indexed visual order', () => {
		const source = row('src', 'directory');
		const readme = row('README.md', 'file');
		const model = buildFileTreeRenderModel({
			rows: [source, readme],
			parentPath: '/workspace',
			expandedDirectories: new Set([source.entry.path]),
			loadingDirectories: new Set([source.entry.path]),
			childErrors: new Map(),
		});

		expect(model.rows.map((item) => item.kind)).toEqual([
			'parent',
			'entry',
			'child-status',
			'entry',
		]);
		expect(model.rows[0]?.key).toBe(FILE_TREE_PARENT_ROW_KEY);
		expect(model.rows[2]).toMatchObject({
			kind: 'child-status',
			status: 'loading',
			parentKey: source.key,
		});
		expect([...model.renderIndexByKey.values()]).toEqual([0, 1, 2, 3]);
	});

	it('keeps child status identity stable while making only errors focusable', () => {
		const source = row('src', 'directory');
		const args = {
			rows: [source],
			parentPath: null,
			expandedDirectories: new Set([source.entry.path]),
		};
		const loading = buildFileTreeRenderModel({
			...args,
			loadingDirectories: new Set([source.entry.path]),
			childErrors: new Map(),
		});
		const failed = buildFileTreeRenderModel({
			...args,
			loadingDirectories: new Set(),
			childErrors: new Map([[source.entry.path, new Error('failed')]]),
		});

		expect(loading.rows[1]?.key).toBe(failed.rows[1]?.key);
		expect(isFileTreeRenderRowFocusable(loading.rows[1])).toBe(false);
		expect(isFileTreeRenderRowFocusable(failed.rows[1])).toBe(true);
	});

	it('does not add state rows for collapsed or non-directory entries', () => {
		const source = row('src', 'directory');
		const readme = row('README.md', 'file');
		const model = buildFileTreeRenderModel({
			rows: [source, readme],
			parentPath: null,
			expandedDirectories: new Set([readme.entry.path]),
			loadingDirectories: new Set([source.entry.path, readme.entry.path]),
			childErrors: new Map(),
		});

		expect(model.rows).toEqual([source, readme]);
	});

	it('indexes 100,000 entry rows without recursion or duplicate keys', () => {
		const rows = Array.from({ length: 100_000 }, (_, index) => row(`file-${index}.ts`, 'file'));
		const model = buildFileTreeRenderModel({
			rows,
			parentPath: null,
			expandedDirectories: new Set(),
			loadingDirectories: new Set(),
			childErrors: new Map(),
		});

		expect(model.rows).toHaveLength(100_000);
		expect(model.renderIndexByKey.size).toBe(100_000);
		expect(model.renderIndexByKey.get('/workspace/file-99999.ts')).toBe(99_999);
	});
});

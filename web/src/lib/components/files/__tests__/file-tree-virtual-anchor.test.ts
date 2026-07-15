import { describe, expect, it } from 'vitest';
import type { VirtualItem } from '@tanstack/svelte-virtual';
import type { FileTreeEntry } from '$shared/file-contracts';
import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import { buildFileTreeRenderModel } from '$lib/files/tree/file-tree-render-rows.js';
import {
	captureFileTreeVirtualAnchor,
	resolveFileTreeAnchorIndex,
} from '../file-tree-virtual-anchor.js';

function row(name: string): FileTableRow {
	const entry: FileTreeEntry = {
		name,
		path: `/workspace/${name}`,
		relativePath: name,
		type: 'file',
		size: 1,
		modified: null,
		permissionsRwx: 'rw-r--r--',
	};
	return { kind: 'entry', key: entry.path, entry, level: 1, parentKey: null, ancestorKeys: [] };
}

function item(index: number, start: number, size = 32): VirtualItem {
	return { index, key: index, start, size, end: start + size, lane: 0 };
}

function model(rows: readonly FileTableRow[]) {
	return buildFileTreeRenderModel({
		rows,
		parentPath: null,
		expandedDirectories: new Set(),
		loadingDirectories: new Set(),
		childErrors: new Map(),
	});
}

describe('file tree virtual anchor', () => {
	it('captures the first row intersecting the content viewport with its pixel offset', () => {
		const rows = [row('a'), row('b'), row('c')];
		expect(captureFileTreeVirtualAnchor(rows, [item(0, 32), item(1, 64)], 48)).toEqual({
			key: rows[0]?.key,
			previousIndex: 0,
			offsetFromContentViewport: -16,
		});
	});

	it('ignores a retained offscreen focus item before the visible range', () => {
		const rows = [row('a'), row('b'), row('c'), row('d')];
		expect(captureFileTreeVirtualAnchor(rows, [item(0, 32), item(3, 128)], 120)?.key).toBe(
			rows[3]?.key,
		);
	});

	it('resolves an exact stable key after rows are inserted above it', () => {
		const a = row('a');
		const b = row('b');
		const anchor = { key: b.key, previousIndex: 1, offsetFromContentViewport: -5 };
		expect(resolveFileTreeAnchorIndex(anchor, [a, b], model([row('new'), a, b]))).toBe(2);
	});

	it('falls back to the nearest surviving predecessor and then the first row', () => {
		const a = row('a');
		const b = row('b');
		const c = row('c');
		const anchor = { key: c.key, previousIndex: 2, offsetFromContentViewport: 0 };
		expect(resolveFileTreeAnchorIndex(anchor, [a, b, c], model([a]))).toBe(0);
		expect(resolveFileTreeAnchorIndex(anchor, [a, b, c], model([]))).toBeNull();
	});
});

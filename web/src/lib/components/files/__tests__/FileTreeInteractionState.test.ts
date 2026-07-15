import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry, FileTreeResponse } from '$shared/file-contracts';
import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import {
	buildFileTreeRenderModel,
	FILE_TREE_PARENT_ROW_KEY,
	type FileTreeRenderModel,
} from '$lib/files/tree/file-tree-render-rows.js';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import { FileTreeInteractionState } from '../FileTreeInteractionState.svelte.js';

function row(name: string, type: 'file' | 'directory'): FileTableRow {
	const entry: FileTreeEntry = {
		name,
		path: `/workspace/project/${name}`,
		relativePath: `project/${name}`,
		type,
		size: 1,
		modified: null,
		permissionsRwx: 'rw-r--r--',
	};
	return { kind: 'entry', key: entry.path, entry, level: 1, parentKey: null, ancestorKeys: [] };
}

function response(entries: FileTreeEntry[]): FileTreeResponse {
	return {
		fileRootPath: '/workspace',
		directory: {
			path: '/workspace/project',
			relativePath: 'project',
			parentPath: '/workspace',
			breadcrumbs: [
				{ name: 'workspace', path: '/workspace' },
				{ name: 'project', path: '/workspace/project' },
			],
		},
		entries,
	};
}

function project(
	rows: readonly FileTableRow[],
	store: FileTreeStore,
	status: 'loading' | 'error' | null = null,
): FileTreeRenderModel {
	const directory = rows.find((item) => item.entry.type === 'directory');
	return buildFileTreeRenderModel({
		rows,
		parentPath: store.parentPath,
		expandedDirectories: directory ? new Set([directory.entry.path]) : new Set(),
		loadingDirectories:
			status === 'loading' && directory ? new Set([directory.entry.path]) : new Set(),
		childErrors:
			status === 'error' && directory
				? new Map([[directory.entry.path, new Error('failed')]])
				: new Map(),
	});
}

describe('FileTreeInteractionState', () => {
	let store: FileTreeStore;
	let source: FileTableRow;
	let readme: FileTableRow;
	let currentModel: FileTreeRenderModel;
	let requested: string[];
	let activated: FileTableRow[];
	let interaction: FileTreeInteractionState;

	beforeEach(() => {
		localStorage.clear();
		store = new FileTreeStore();
		source = row('src', 'directory');
		readme = row('README.md', 'file');
		store.navigation = { kind: 'ready', response: response([source.entry, readme.entry]) };
		store.expandedDirs = new Set([source.entry.path]);
		currentModel = project([source, readme], store, 'loading');
		requested = [];
		activated = [];
		interaction = new FileTreeInteractionState({
			get model() {
				return currentModel;
			},
			get store() {
				return store;
			},
			requestDomFocus: (key) => requested.push(key),
			activateEntry: (entryRow) => activated.push(entryRow),
		});
	});

	it('moves across the complete logical model while skipping loading rows', () => {
		interaction.setFocusedKey(source.key);
		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }),
			source,
		);

		expect(interaction.focusedKey).toBe(readme.key);
		expect(requested).toEqual([readme.key]);
	});

	it('supports Home, End, parent activation, and entry activation', () => {
		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'End', cancelable: true }),
			currentModel.rows[0]!,
		);
		expect(requested.at(-1)).toBe(readme.key);

		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'Home', cancelable: true }),
			readme,
		);
		expect(requested.at(-1)).toBe(FILE_TREE_PARENT_ROW_KEY);

		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
			readme,
		);
		expect(activated).toEqual([readme]);

		const goToParent = vi.spyOn(store, 'goToParent').mockResolvedValue();
		interaction.activateRow(currentModel.rows[0]!);
		expect(goToParent).toHaveBeenCalledOnce();
	});

	it('enters an expanded child error and retries it from the keyboard', () => {
		currentModel = project([source, readme], store, 'error');
		const errorRow = currentModel.rows.find((item) => item.kind === 'child-status');
		if (!errorRow || errorRow.kind !== 'child-status') throw new Error('Expected error row');
		const retry = vi.spyOn(store, 'retryDirectory');

		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }),
			source,
		);
		expect(requested.at(-1)).toBe(errorRow.key);
		interaction.handleRowKeydown(
			new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }),
			errorRow,
		);

		expect(requested.at(-1)).toBe(source.key);
		expect(retry).toHaveBeenCalledWith(source.entry.path);
	});

	it('reconciles a removed focused row to its nearest actionable predecessor', () => {
		const previousModel = project([source, readme], store, 'error');
		const errorRow = previousModel.rows.find((item) => item.kind === 'child-status');
		if (!errorRow) throw new Error('Expected status row');
		currentModel = previousModel;
		interaction.setFocusedKey(errorRow.key);
		currentModel = project([source, readme], store);

		expect(interaction.reconcileFocusedRow(previousModel, true)).toBe(source.key);
		expect(requested).toEqual([source.key]);
	});
});

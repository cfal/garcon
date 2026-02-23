import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileTreeStore } from '../file-tree.svelte';
import * as filesApi from '$lib/api/files';
import type { FileTreeNode } from '$lib/api/files';

vi.mock('$lib/api/files', () => ({
	getTree: vi.fn(),
}));

const mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (key: string) => mockStorage.get(key) ?? null,
	setItem: (key: string, value: string) => mockStorage.set(key, value),
	removeItem: (key: string) => mockStorage.delete(key),
	clear: () => mockStorage.clear(),
});

function node(name: string, type: 'file' | 'directory', extra?: Partial<FileTreeNode>): FileTreeNode {
	return { name, path: `/${name}`, type, ...extra } as FileTreeNode;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FileTreeStore', () => {
	let store: FileTreeStore;

	beforeEach(() => {
		vi.resetAllMocks();
		mockStorage.clear();
		store = new FileTreeStore();
	});

	describe('init', () => {
		it('fetches root on valid project/chat combination', async () => {
			vi.mocked(filesApi.getTree).mockResolvedValue([node('src', 'directory')]);

			store.init('/project', 'chat1');
			await tick();

			expect(store.rootFiles).toHaveLength(1);
			expect(store.rootFiles[0].name).toBe('src');
			expect(filesApi.getTree).toHaveBeenCalledWith(
				{ chatId: 'chat1', projectPath: '/project' },
				expect.any(Object),
			);
		});

		it('resets state when projectPath is null', () => {
			store.rootFiles = [node('a', 'file')];
			store.init(null, null);
			expect(store.rootFiles).toEqual([]);
		});

		it('skips fetch when called with same key twice', async () => {
			vi.mocked(filesApi.getTree).mockResolvedValue([]);
			store.init('/project', 'chat1');
			await tick();
			store.init('/project', 'chat1');
			await tick();
			expect(filesApi.getTree).toHaveBeenCalledTimes(1);
		});
	});

	describe('reset', () => {
		it('clears all state', async () => {
			vi.mocked(filesApi.getTree).mockResolvedValue([node('src', 'directory')]);
			store.init('/project', 'chat1');
			await tick();

			store.reset();

			expect(store.rootFiles).toEqual([]);
			expect(store.childrenCache.size).toBe(0);
			expect(store.expandedDirs.size).toBe(0);
			expect(store.loadingDirs.size).toBe(0);
			expect(store.isLoading).toBe(false);
		});
	});

	describe('toggleDirectory', () => {
		it('expands and fetches children on first toggle', async () => {
			vi.mocked(filesApi.getTree).mockResolvedValue([node('index.ts', 'file')]);
			store.init('/project', 'chat1');
			await tick();

			store.toggleDirectory('/src');
			await tick();
			await tick();

			expect(store.expandedDirs.has('/src')).toBe(true);
			expect(store.childrenCache.get('/src')).toHaveLength(1);
		});

		it('collapses on second toggle without re-fetching', async () => {
			vi.mocked(filesApi.getTree).mockResolvedValue([node('a.ts', 'file')]);
			store.init('/project', 'chat1');
			await tick();

			store.toggleDirectory('/src');
			await tick();
			await tick();
			const callCount = vi.mocked(filesApi.getTree).mock.calls.length;

			store.toggleDirectory('/src');
			expect(store.expandedDirs.has('/src')).toBe(false);

			// Re-expand uses cache
			store.toggleDirectory('/src');
			expect(store.expandedDirs.has('/src')).toBe(true);
			expect(filesApi.getTree).toHaveBeenCalledTimes(callCount);
		});
	});

	describe('sorting', () => {
		const files: FileTreeNode[] = [
			node('Z_file.txt', 'file', { size: 100 }),
			node('A_folder', 'directory'),
			node('M_file.ts', 'file', { size: 50 }),
		];

		it('sorts folders first by default', () => {
			store.childrenCache.set('/root', files);
			store.foldersFirst = true;
			store.setSortKey('name');
			store.setSortDirection('asc');

			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result[0].name).toBe('A_folder');
			expect(result[1].name).toBe('M_file.ts');
			expect(result[2].name).toBe('Z_file.txt');
		});

		it('respects descending direction', () => {
			store.childrenCache.set('/root', files);
			store.foldersFirst = false;
			store.setSortKey('name');
			store.setSortDirection('desc');

			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result[0].name).toBe('Z_file.txt');
			expect(result[result.length - 1].name).toBe('A_folder');
		});

		it('sorts by size', () => {
			store.childrenCache.set('/root', files);
			store.foldersFirst = false;
			store.setSortKey('size');
			store.setSortDirection('asc');

			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result[0].name).toBe('A_folder');
			expect(result[1].name).toBe('M_file.ts');
			expect(result[2].name).toBe('Z_file.txt');
		});

		it('sorts by modified date', () => {
			const dated: FileTreeNode[] = [
				node('old.ts', 'file', { modified: '2024-01-01T00:00:00Z' }),
				node('new.ts', 'file', { modified: '2026-01-01T00:00:00Z' }),
			];
			store.childrenCache.set('/root', dated);
			store.foldersFirst = false;
			store.setSortKey('modified');
			store.setSortDirection('asc');

			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result[0].name).toBe('old.ts');
			expect(result[1].name).toBe('new.ts');
		});
	});

	describe('toggleSort', () => {
		it('reverses direction for same key', () => {
			store.setSortKey('name');
			store.setSortDirection('asc');
			store.toggleSort('name');
			expect(store.sortDirection).toBe('desc');
			store.toggleSort('name');
			expect(store.sortDirection).toBe('asc');
		});

		it('switches key and resets to ascending', () => {
			store.setSortKey('name');
			store.setSortDirection('desc');
			store.toggleSort('size');
			expect(store.sortKey).toBe('size');
			expect(store.sortDirection).toBe('asc');
		});
	});

	describe('hidden files', () => {
		const items: FileTreeNode[] = [
			node('.gitignore', 'file'),
			node('README.md', 'file'),
		];

		it('filters dotfiles when showHiddenFiles is false', () => {
			store.childrenCache.set('/root', items);
			store.setShowHiddenFiles(false);
			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('README.md');
		});

		it('shows dotfiles when showHiddenFiles is true', () => {
			store.childrenCache.set('/root', items);
			store.setShowHiddenFiles(true);
			const result = store.getChildren(node('root', 'directory', { path: '/root' }))!;
			expect(result).toHaveLength(2);
		});
	});

	describe('localStorage persistence', () => {
		it('persists sort key', () => {
			store.setSortKey('size');
			expect(mockStorage.get('file-tree-sort-key')).toBe('size');
		});

		it('persists sort direction', () => {
			store.setSortDirection('desc');
			expect(mockStorage.get('file-tree-sort-direction')).toBe('desc');
		});

		it('persists foldersFirst', () => {
			store.setFoldersFirst(false);
			expect(mockStorage.get('file-tree-folders-first')).toBe('false');
		});

		it('persists showHiddenFiles', () => {
			store.setShowHiddenFiles(false);
			expect(mockStorage.get('file-tree-show-hidden-files')).toBe('false');
		});

		it('loads preferences from localStorage on construction', () => {
			mockStorage.set('file-tree-sort-key', 'modified');
			mockStorage.set('file-tree-sort-direction', 'desc');
			mockStorage.set('file-tree-folders-first', 'false');
			mockStorage.set('file-tree-show-hidden-files', 'false');

			const s = new FileTreeStore();
			expect(s.sortKey).toBe('modified');
			expect(s.sortDirection).toBe('desc');
			expect(s.foldersFirst).toBe(false);
			expect(s.showHiddenFiles).toBe(false);
		});

		it('ignores invalid localStorage values', () => {
			mockStorage.set('file-tree-sort-key', 'invalid');
			mockStorage.set('file-tree-sort-direction', 'sideways');

			const s = new FileTreeStore();
			expect(s.sortKey).toBe('name');
			expect(s.sortDirection).toBe('asc');
		});
	});

	describe('buildTree', () => {
		it('returns sorted tree with nested cached children', () => {
			const root: FileTreeNode[] = [
				node('lib', 'directory', { path: '/lib' }),
				node('app.ts', 'file'),
			];
			store.childrenCache.set('/lib', [
				node('utils.ts', 'file', { path: '/lib/utils.ts' }),
				node('index.ts', 'file', { path: '/lib/index.ts' }),
			]);

			const tree = store.buildTree(root);
			expect(tree[0].name).toBe('lib');
			expect(tree[0].children).toHaveLength(2);
			expect(tree[0].children![0].name).toBe('index.ts');
			expect(tree[0].children![1].name).toBe('utils.ts');
			expect(tree[1].name).toBe('app.ts');
		});
	});

	describe('filterTree', () => {
		it('filters by name case-insensitively', () => {
			const tree = [node('App.svelte', 'file'), node('utils.ts', 'file')];
			const result = store.filterTree(tree, 'app');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('App.svelte');
		});

		it('includes directories with matching children', () => {
			const tree: FileTreeNode[] = [{
				name: 'src', path: '/src', type: 'directory',
				children: [
					node('App.svelte', 'file', { path: '/src/App.svelte' }),
					node('utils.ts', 'file', { path: '/src/utils.ts' }),
				],
			} as FileTreeNode];

			const result = store.filterTree(tree, 'utils');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('src');
			expect(result[0].children).toHaveLength(1);
			expect(result[0].children![0].name).toBe('utils.ts');
		});

		it('returns empty array when nothing matches', () => {
			expect(store.filterTree([node('foo.ts', 'file')], 'zzz')).toEqual([]);
		});
	});

	describe('error handling', () => {
		it('clears rootFiles on non-abort fetch error', async () => {
			vi.mocked(filesApi.getTree).mockRejectedValue(new Error('Network error'));
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

			store.init('/project', 'chat1');
			await tick();

			expect(store.rootFiles).toEqual([]);
			expect(store.isLoading).toBe(false);
			spy.mockRestore();
		});

		it('silently ignores AbortError', async () => {
			vi.mocked(filesApi.getTree).mockRejectedValue(
				new DOMException('aborted', 'AbortError'),
			);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

			store.init('/project', 'chat1');
			await tick();

			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});
	});

	describe('getChildren', () => {
		it('returns null when no cached children exist', () => {
			expect(store.getChildren(node('x', 'directory', { path: '/x' }))).toBeNull();
		});

		it('returns inline children if present on node', () => {
			const n: FileTreeNode = {
				name: 'src', path: '/src', type: 'directory',
				children: [node('a.ts', 'file')],
			};
			expect(store.getChildren(n)).toEqual(n.children);
		});
	});
});

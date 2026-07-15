import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import { FILE_TREE_PARENT_ROW_KEY, type FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';

interface FileTreeInteractionOptions {
	get rowKeys(): readonly string[];
	get rows(): readonly FileTableRow[];
	get rowLevels(): ReadonlyMap<string, number>;
	get treegrid(): HTMLElement | null;
	get store(): FileTreeStore;
	activateEntry(row: FileTableRow): void;
}

export class FileTreeInteractionState {
	focusedKey = $state<string | null>(null);

	constructor(private readonly options: FileTreeInteractionOptions) {}

	get activeFocusKey(): string | null {
		const rowKeys = this.options.rowKeys;
		return this.focusedKey && rowKeys.includes(this.focusedKey)
			? this.focusedKey
			: (rowKeys[0] ?? null);
	}

	setFocusedKey(key: string): void {
		this.focusedKey = key;
	}

	focusRow(key: string | null): void {
		if (!key) return;
		this.focusedKey = key;
		queueMicrotask(() => {
			const treegrid = this.options.treegrid;
			const element = [
				...(treegrid?.querySelectorAll<HTMLElement>('[data-file-tree-row]') ?? []),
			].find((row) => row.dataset.fileTreeRowKey === key);
			(element ?? treegrid?.querySelector<HTMLElement>('[data-file-tree-row]'))?.focus();
		});
	}

	handleEntryKeydown(event: KeyboardEvent, row: FileTableRow): void {
		if (this.#handleSharedNavigationKey(event, row.key)) return;
		const store = this.options.store;
		if (event.key === 'Enter') {
			event.preventDefault();
			this.options.activateEntry(row);
			return;
		}
		if (event.key === 'ArrowRight' && row.entry.type === 'directory') {
			event.preventDefault();
			if (!store.expandedDirs.has(row.entry.path)) {
				store.toggleDirectory(row.entry.path);
				return;
			}
			const rowKeys = this.options.rowKeys;
			const index = rowKeys.indexOf(row.key);
			const childKey = rowKeys[index + 1];
			if (childKey && (this.options.rowLevels.get(childKey) ?? 0) > row.level) {
				this.focusRow(childKey);
			}
			return;
		}
		if (event.key !== 'ArrowLeft') return;
		event.preventDefault();
		if (row.entry.type === 'directory' && store.expandedDirs.has(row.entry.path)) {
			store.toggleDirectory(row.entry.path);
			return;
		}
		this.focusRow(row.parentKey ?? (store.parentPath ? FILE_TREE_PARENT_ROW_KEY : null));
	}

	handleChildErrorKeydown(
		event: KeyboardEvent,
		key: string,
		parentKey: string,
		retry: () => void,
	): void {
		if (this.#handleSharedNavigationKey(event, key)) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			retry();
			return;
		}
		if (event.key !== 'ArrowLeft') return;
		event.preventDefault();
		this.focusRow(parentKey);
	}

	handleParentKeydown(event: KeyboardEvent): void {
		if (this.#handleSharedNavigationKey(event, FILE_TREE_PARENT_ROW_KEY)) return;
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void this.options.store.goToParent();
	}

	#handleSharedNavigationKey(event: KeyboardEvent, key: string): boolean {
		if (event.key === 'ArrowUp') return this.#moveFocus(event, key, 'previous');
		if (event.key === 'ArrowDown') return this.#moveFocus(event, key, 'next');
		if (event.key === 'Home') return this.#moveFocus(event, key, 'first');
		if (event.key === 'End') return this.#moveFocus(event, key, 'last');
		return false;
	}

	#moveFocus(
		event: KeyboardEvent,
		key: string,
		movement: 'previous' | 'next' | 'first' | 'last',
	): boolean {
		const rowKeys = this.options.rowKeys;
		const index = rowKeys.indexOf(key);
		let targetIndex = index;
		if (movement === 'previous') targetIndex = Math.max(0, index - 1);
		if (movement === 'next') targetIndex = Math.min(rowKeys.length - 1, index + 1);
		if (movement === 'first') targetIndex = 0;
		if (movement === 'last') targetIndex = rowKeys.length - 1;
		const target = rowKeys[targetIndex];
		if (!target) return false;
		event.preventDefault();
		this.focusRow(target);
		return true;
	}
}

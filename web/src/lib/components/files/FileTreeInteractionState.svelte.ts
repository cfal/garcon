import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
import {
	FILE_TREE_PARENT_ROW_KEY,
	isFileTreeRenderRowFocusable,
	type FileTreeRenderModel,
	type FileTreeRenderRow,
} from '$lib/files/tree/file-tree-render-rows.js';
import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';

interface FileTreeInteractionOptions {
	get model(): FileTreeRenderModel;
	get store(): FileTreeStore;
	requestDomFocus(key: string): void;
	activateEntry(row: FileTableRow): void;
}

export class FileTreeInteractionState {
	focusedKey = $state<string | null>(null);

	constructor(private readonly options: FileTreeInteractionOptions) {}

	get activeFocusKey(): string | null {
		const { rows, renderIndexByKey } = this.options.model;
		const focusedIndex = this.focusedKey ? renderIndexByKey.get(this.focusedKey) : undefined;
		if (focusedIndex !== undefined && isFileTreeRenderRowFocusable(rows[focusedIndex])) {
			return this.focusedKey;
		}
		return rows.find(isFileTreeRenderRowFocusable)?.key ?? null;
	}

	setFocusedKey(key: string): void {
		const { rows, renderIndexByKey } = this.options.model;
		const index = renderIndexByKey.get(key);
		if (index !== undefined && isFileTreeRenderRowFocusable(rows[index])) {
			this.focusedKey = key;
		}
	}

	focusRow(key: string | null): void {
		if (!key) return;
		const { rows, renderIndexByKey } = this.options.model;
		const index = renderIndexByKey.get(key);
		if (index === undefined || !isFileTreeRenderRowFocusable(rows[index])) return;
		this.focusedKey = key;
		this.options.requestDomFocus(key);
	}

	activateRow(row: FileTreeRenderRow): void {
		switch (row.kind) {
			case 'parent':
				void this.options.store.goToParent();
				break;
			case 'entry':
				this.options.activateEntry(row);
				break;
			case 'child-status':
				if (row.status === 'error') {
					this.focusRow(row.parentKey);
					this.options.store.retryDirectory(row.directoryPath);
				}
				break;
		}
	}

	handleRowKeydown(event: KeyboardEvent, row: FileTreeRenderRow): void {
		if (this.#handleSharedNavigationKey(event, row.key)) return;
		switch (row.kind) {
			case 'parent':
				if (event.key === 'Enter') {
					event.preventDefault();
					void this.options.store.goToParent();
				}
				break;
			case 'entry':
				this.#handleEntryKeydown(event, row);
				break;
			case 'child-status':
				this.#handleChildStatusKeydown(event, row);
				break;
		}
	}

	reconcileFocusedRow(previousModel: FileTreeRenderModel, restoreDomFocus: boolean): string | null {
		const focusedKey = this.focusedKey;
		if (!focusedKey) return null;
		const currentIndex = this.options.model.renderIndexByKey.get(focusedKey);
		if (
			currentIndex !== undefined &&
			isFileTreeRenderRowFocusable(this.options.model.rows[currentIndex])
		) {
			return focusedKey;
		}

		const previousIndex = previousModel.renderIndexByKey.get(focusedKey);
		let replacement: FileTreeRenderRow | undefined;
		for (
			let index = Math.min(
				(previousIndex ?? previousModel.rows.length) - 1,
				previousModel.rows.length - 1,
			);
			index >= 0;
			index -= 1
		) {
			const candidateKey = previousModel.rows[index]?.key;
			const candidateIndex = candidateKey
				? this.options.model.renderIndexByKey.get(candidateKey)
				: undefined;
			const candidate =
				candidateIndex !== undefined ? this.options.model.rows[candidateIndex] : undefined;
			if (isFileTreeRenderRowFocusable(candidate)) {
				replacement = candidate;
				break;
			}
		}
		replacement ??= this.options.model.rows.find(isFileTreeRenderRowFocusable);
		this.focusedKey = replacement?.key ?? null;
		if (restoreDomFocus && replacement) this.options.requestDomFocus(replacement.key);
		return replacement?.key ?? null;
	}

	#handleEntryKeydown(event: KeyboardEvent, row: FileTableRow): void {
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
			const child = this.#nextFocusableRow(row.key, 1);
			if (child && child.level > row.level) this.focusRow(child.key);
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

	#handleChildStatusKeydown(
		event: KeyboardEvent,
		row: Extract<FileTreeRenderRow, { kind: 'child-status' }>,
	): void {
		if (row.status !== 'error') return;
		if (event.key === 'Enter') {
			event.preventDefault();
			this.focusRow(row.parentKey);
			this.options.store.retryDirectory(row.directoryPath);
			return;
		}
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			this.focusRow(row.parentKey);
		}
	}

	#handleSharedNavigationKey(event: KeyboardEvent, key: string): boolean {
		let target: FileTreeRenderRow | undefined;
		if (event.key === 'ArrowUp') target = this.#nextFocusableRow(key, -1);
		else if (event.key === 'ArrowDown') target = this.#nextFocusableRow(key, 1);
		else if (event.key === 'Home') {
			target = this.options.model.rows.find(isFileTreeRenderRowFocusable);
		} else if (event.key === 'End') {
			target = this.options.model.rows.findLast(isFileTreeRenderRowFocusable);
		} else {
			return false;
		}
		if (!target) return false;
		event.preventDefault();
		this.focusRow(target.key);
		return true;
	}

	#nextFocusableRow(key: string, direction: -1 | 1): FileTreeRenderRow | undefined {
		const { rows, renderIndexByKey } = this.options.model;
		const index = renderIndexByKey.get(key);
		if (index === undefined) return undefined;
		for (let candidateIndex = index + direction; ; candidateIndex += direction) {
			const candidate = rows[candidateIndex];
			if (!candidate) return undefined;
			if (isFileTreeRenderRowFocusable(candidate)) return candidate;
		}
	}
}

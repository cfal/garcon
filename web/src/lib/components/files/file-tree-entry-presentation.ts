import type { FileTreeEntry } from '$shared/file-contracts';
import type {
	FileTreeColumnKey,
	OptionalFileTreeColumnKey,
} from '$lib/files/tree/file-tree.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface FileTreeDetailPresentation {
	readonly key: OptionalFileTreeColumnKey;
	readonly value: string | null;
	readonly monospace: boolean;
}

const FILE_TREE_FIELD_LABELS = {
	name: m.filetree_name,
	size: m.filetree_size,
	modified: m.filetree_modified,
	permissions: m.filetree_permissions,
} satisfies Record<FileTreeColumnKey, () => string>;

export function fileTreeFieldLabel(key: FileTreeColumnKey): string {
	return FILE_TREE_FIELD_LABELS[key]();
}

export function formatFileTreeSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** unitIndex;
	return `${Number(value.toFixed(1))} ${units[unitIndex]}`;
}

export function formatFileTreeModified(value: string | null, now = Date.now()): string | null {
	if (!value) return null;
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) return null;
	let remaining = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (remaining < 60) return m.filetree_just_now();
	remaining = Math.floor(remaining / 60);
	if (remaining < 60) return m.filetree_min_ago({ count: remaining });
	remaining = Math.floor(remaining / 60);
	if (remaining < 24) return m.filetree_hours_ago({ count: remaining });
	remaining = Math.floor(remaining / 24);
	if (remaining < 30) return m.filetree_days_ago({ count: remaining });
	return new Date(timestamp).toLocaleDateString();
}

export function presentFileTreeDetail(
	entry: FileTreeEntry,
	key: OptionalFileTreeColumnKey,
	now = Date.now(),
): FileTreeDetailPresentation {
	switch (key) {
		case 'size':
			return {
				key,
				value: entry.type === 'file' ? formatFileTreeSize(entry.size) : null,
				monospace: false,
			};
		case 'modified':
			return {
				key,
				value: formatFileTreeModified(entry.modified, now),
				monospace: false,
			};
		case 'permissions':
			return {
				key,
				value: entry.permissionsRwx || null,
				monospace: true,
			};
	}
}

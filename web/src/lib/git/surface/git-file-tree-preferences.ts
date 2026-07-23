import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export const DEFAULT_GIT_FILE_TREE_WIDTH = 300;
export const MIN_GIT_FILE_TREE_WIDTH = 220;
export const MAX_GIT_FILE_TREE_WIDTH = 560;

export function clampGitFileTreeWidth(width: number): number {
	return Math.max(MIN_GIT_FILE_TREE_WIDTH, Math.min(MAX_GIT_FILE_TREE_WIDTH, Math.round(width)));
}

export function readGitFileTreeWidth(): number | null {
	const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx);
	const width = raw ? Number(raw) : NaN;
	return Number.isFinite(width) ? clampGitFileTreeWidth(width) : null;
}

export function persistGitFileTreeWidth(width: number): number {
	const clamped = clampGitFileTreeWidth(width);
	setLocalStorageItem(LOCAL_STORAGE_KEYS.gitTreePaneWidthPx, String(clamped));
	return clamped;
}

export function readGitDiffDocumentFileTreeVisible(): boolean {
	return getLocalStorageItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible) !== 'false';
}

export function persistGitDiffDocumentFileTreeVisible(visible: boolean): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.gitDiffDocumentFileTreeVisible, String(visible));
}

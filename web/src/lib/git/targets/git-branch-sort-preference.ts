import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence.js';
import { DEFAULT_GIT_REF_SORT, parseGitRefSort, type GitRefSort } from '$shared/git-refs';

function defaultSort(): GitRefSort {
	return { ...DEFAULT_GIT_REF_SORT };
}

export function readGitBranchSortPreference(): GitRefSort {
	const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.gitBranchSort);
	if (!raw) return defaultSort();

	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return defaultSort();
		}
		const record = value as Record<string, unknown>;
		return parseGitRefSort(record.key, record.direction) ?? defaultSort();
	} catch {
		return defaultSort();
	}
}

export function persistGitBranchSortPreference(sort: GitRefSort): void {
	setLocalStorageItem(
		LOCAL_STORAGE_KEYS.gitBranchSort,
		JSON.stringify({ key: sort.key, direction: sort.direction }),
	);
}

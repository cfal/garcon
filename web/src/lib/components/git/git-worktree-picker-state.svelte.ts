import type { GitWorktreeItem } from '$lib/api/git.js';
import { deriveWorktreePath } from '$lib/utils/worktree-path.js';

export type WorktreeSortOrder =
	| 'alphabetical-ascending'
	| 'alphabetical-descending'
	| 'last-modified';

export const WORKTREE_SORT_ORDERS: readonly WorktreeSortOrder[] = [
	'alphabetical-ascending',
	'alphabetical-descending',
	'last-modified',
];

export function isWorktreeSortOrder(value: string): value is WorktreeSortOrder {
	return WORKTREE_SORT_ORDERS.includes(value as WorktreeSortOrder);
}

interface GitWorktreePickerStateOptions {
	get worktrees(): GitWorktreeItem[];
	get locale(): string;
}

interface VisibleWorktreeCache {
	worktrees: GitWorktreeItem[];
	filterQuery: string;
	sortOrder: WorktreeSortOrder;
	locale: string;
	result: GitWorktreeItem[];
}

function displayName(worktree: GitWorktreeItem): string {
	return worktree.branch || worktree.name;
}

function worktreePathBasename(worktreePath: string): string {
	return worktreePath.split(/[\\/]/).filter(Boolean).at(-1) ?? worktreePath;
}

function timestampValue(value: string | null | undefined): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? null : timestamp;
}

export function filterAndSortWorktrees(
	worktrees: readonly GitWorktreeItem[],
	filterQuery: string,
	sortOrder: WorktreeSortOrder,
	locale: string,
): GitWorktreeItem[] {
	const normalizedQuery = filterQuery.trim().toLocaleLowerCase(locale);
	const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
	const result = normalizedQuery
		? worktrees.filter((worktree) =>
				[worktree.name, worktree.branch, worktreePathBasename(worktree.path)].some((value) =>
					value.toLocaleLowerCase(locale).includes(normalizedQuery),
				),
			)
		: [...worktrees];

	const compareAlphabetically = (left: GitWorktreeItem, right: GitWorktreeItem): number => {
		const nameComparison = collator.compare(displayName(left), displayName(right));
		return nameComparison || collator.compare(left.path, right.path);
	};

	result.sort((left, right) => {
		if (sortOrder === 'alphabetical-ascending') {
			return compareAlphabetically(left, right);
		}
		if (sortOrder === 'alphabetical-descending') {
			return -compareAlphabetically(left, right);
		}

		const leftTimestamp = timestampValue(left.lastModifiedAt);
		const rightTimestamp = timestampValue(right.lastModifiedAt);
		if (leftTimestamp === null && rightTimestamp === null) {
			return compareAlphabetically(left, right);
		}
		if (leftTimestamp === null) return 1;
		if (rightTimestamp === null) return -1;
		return rightTimestamp - leftTimestamp || compareAlphabetically(left, right);
	});

	return result;
}

export class GitWorktreePickerState {
	filterQuery = $state('');
	sortOrder = $state<WorktreeSortOrder>('last-modified');
	selectedPath = $state<string | null>(null);
	showCreateForm = $state(false);
	branchName = $state('');
	showAdvanced = $state(false);
	pathOverride = $state('');
	baseRefOverride = $state('');

	readonly #options: GitWorktreePickerStateOptions;
	#visibleCache: VisibleWorktreeCache | null = null;

	constructor(options: GitWorktreePickerStateOptions) {
		this.#options = options;
	}

	get worktrees(): GitWorktreeItem[] {
		return this.#options.worktrees;
	}

	get visibleWorktrees(): GitWorktreeItem[] {
		const worktrees = this.worktrees;
		const filterQuery = this.filterQuery;
		const sortOrder = this.sortOrder;
		const locale = this.#options.locale;
		const cached = this.#visibleCache;
		if (
			cached &&
			cached.worktrees === worktrees &&
			cached.filterQuery === filterQuery &&
			cached.sortOrder === sortOrder &&
			cached.locale === locale
		) {
			return cached.result;
		}

		const result = filterAndSortWorktrees(worktrees, filterQuery, sortOrder, locale);
		this.#visibleCache = { worktrees, filterQuery, sortOrder, locale, result };
		return result;
	}

	get selectableVisibleWorktrees(): GitWorktreeItem[] {
		return this.visibleWorktrees.filter((worktree) => !worktree.isPathMissing);
	}

	get selectedWorktree(): GitWorktreeItem | null {
		const selected = this.selectedPath
			? this.selectableVisibleWorktrees.find((worktree) => worktree.path === this.selectedPath)
			: null;
		return selected ?? this.selectableVisibleWorktrees[0] ?? null;
	}

	get selectedIndex(): number {
		const selectedPath = this.selectedWorktree?.path;
		return selectedPath
			? this.visibleWorktrees.findIndex((worktree) => worktree.path === selectedPath)
			: -1;
	}

	get hasActiveFilter(): boolean {
		return this.filterQuery.trim().length > 0;
	}

	get totalSelectableCount(): number {
		return this.worktrees.filter((worktree) => !worktree.isPathMissing).length;
	}

	get visibleSelectableCount(): number {
		return this.selectableVisibleWorktrees.length;
	}

	get derivedPath(): string {
		return deriveWorktreePath(this.branchName);
	}

	get effectivePath(): string {
		return this.pathOverride.trim() || this.derivedPath;
	}

	get canCreate(): boolean {
		return Boolean(this.branchName.trim() && this.effectivePath);
	}

	setSortOrder(value: string): void {
		if (isWorktreeSortOrder(value)) this.sortOrder = value;
	}

	selectPath(worktreePath: string): void {
		if (
			this.visibleWorktrees.some(
				(worktree) => worktree.path === worktreePath && !worktree.isPathMissing,
			)
		) {
			this.selectedPath = worktreePath;
		}
	}

	moveSelection(delta: number): void {
		const selectable = this.selectableVisibleWorktrees;
		if (selectable.length === 0) return;
		const selectedPath = this.selectedWorktree?.path;
		const selectedIndex = selectable.findIndex((worktree) => worktree.path === selectedPath);
		const nextIndex = Math.min(Math.max(selectedIndex + delta, 0), selectable.length - 1);
		this.selectedPath = selectable[nextIndex]?.path ?? null;
	}

	resetCreateForm(): void {
		this.showCreateForm = false;
		this.branchName = '';
		this.showAdvanced = false;
		this.pathOverride = '';
		this.baseRefOverride = '';
	}
}

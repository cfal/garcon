import type { GitWorktreeItem } from '$lib/api/git.js';
import { canonicalIsoTimestamp } from '$lib/utils/iso-timestamp.js';
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

function displayName(worktree: GitWorktreeItem): string {
	return worktree.branch || worktree.name;
}

function worktreePathBasename(worktreePath: string): string {
	return worktreePath.split(/[\\/]/).filter(Boolean).at(-1) ?? worktreePath;
}

function timestampValue(value: string | null | undefined): number | null {
	const timestamp = canonicalIsoTimestamp(value);
	return timestamp ? Date.parse(timestamp) : null;
}

export function filterAndSortWorktrees(
	worktrees: readonly GitWorktreeItem[],
	filterQuery: string,
	sortOrder: WorktreeSortOrder,
	locale: string,
): GitWorktreeItem[] {
	const normalizedQuery = filterQuery.trim().toLocaleLowerCase(locale);
	const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
	const filtered = normalizedQuery
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

	if (sortOrder === 'alphabetical-ascending') {
		return filtered.sort(compareAlphabetically);
	}
	if (sortOrder === 'alphabetical-descending') {
		return filtered.sort((left, right) => -compareAlphabetically(left, right));
	}

	const timestamped = filtered.map((worktree) => ({
		worktree,
		timestamp: timestampValue(worktree.lastModifiedAt),
	}));
	timestamped.sort((left, right) => {
		const leftTimestamp = left.timestamp;
		const rightTimestamp = right.timestamp;
		if (leftTimestamp === null && rightTimestamp === null) {
			return compareAlphabetically(left.worktree, right.worktree);
		}
		if (leftTimestamp === null) return 1;
		if (rightTimestamp === null) return -1;
		return (
			rightTimestamp - leftTimestamp || compareAlphabetically(left.worktree, right.worktree)
		);
	});

	return timestamped.map(({ worktree }) => worktree);
}

export class GitWorktreePickerState {
	readonly #options: GitWorktreePickerStateOptions;

	filterQuery = $state('');
	sortOrder = $state<WorktreeSortOrder>('last-modified');
	selectedPath = $state<string | null>(null);
	showCreateForm = $state(false);
	branchName = $state('');
	showAdvanced = $state(false);
	pathOverride = $state('');
	baseRefOverride = $state('');

	#visibleWorktrees = $derived.by(() =>
		filterAndSortWorktrees(
			this.#options.worktrees,
			this.filterQuery,
			this.sortOrder,
			this.#options.locale,
		),
	);
	#selectableVisibleWorktrees = $derived.by(() =>
		this.#visibleWorktrees.filter((worktree) => !worktree.isPathMissing),
	);
	#selectedWorktree = $derived.by(
		() =>
			this.#selectableVisibleWorktrees.find((worktree) => worktree.path === this.selectedPath) ??
			this.#selectableVisibleWorktrees[0] ??
			null,
	);
	#selectedIndex = $derived.by(() =>
		this.#selectedWorktree
			? this.#visibleWorktrees.findIndex(
					(worktree) => worktree.path === this.#selectedWorktree?.path,
				)
			: -1,
	);

	constructor(options: GitWorktreePickerStateOptions) {
		this.#options = options;
	}

	get worktrees(): GitWorktreeItem[] {
		return this.#options.worktrees;
	}

	get visibleWorktrees(): GitWorktreeItem[] {
		return this.#visibleWorktrees;
	}

	get selectableVisibleWorktrees(): GitWorktreeItem[] {
		return this.#selectableVisibleWorktrees;
	}

	get selectedWorktree(): GitWorktreeItem | null {
		return this.#selectedWorktree;
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	get hasActiveFilter(): boolean {
		return this.filterQuery.trim().length > 0;
	}

	get totalCount(): number {
		return this.worktrees.length;
	}

	get visibleCount(): number {
		return this.visibleWorktrees.length;
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
		if (this.selectedPath === worktreePath) return;
		if (
			this.visibleWorktrees.some(
				(worktree) => worktree.path === worktreePath && !worktree.isPathMissing,
			)
		) {
			this.selectedPath = worktreePath;
		}
	}

	moveSelection(delta: -1 | 1): void {
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

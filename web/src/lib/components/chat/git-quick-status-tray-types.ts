import type { GitRefKind, GitRefOption, GitRefSort, GitRefSortKey } from '$lib/api/git.js';

export interface GitQuickBranchSelectorControls {
	refs: GitRefOption[];
	sort: GitRefSort;
	isOpen: boolean;
	isLoading: boolean;
	onToggle: () => void;
	onClose: () => void;
	onCreateBranch: () => void;
	onSwitchBranch: (branch: string, refKind?: GitRefKind) => void | Promise<void>;
	onSearchRefs?: (query: string) => void | Promise<void>;
	onSortRefs: (key: GitRefSortKey, query: string) => void | Promise<void>;
	onSwitchDialogClose?: () => void;
}

import type { GitRefOption } from '$lib/api/git.js';

export interface GitQuickBranchSelectorControls {
	refs: GitRefOption[];
	isOpen: boolean;
	isLoading: boolean;
	onToggle: () => void;
	onClose: () => void;
	onCreateBranch: () => void;
	onSwitchBranch: (branch: string) => void | Promise<void>;
	onSearchRefs?: (query: string) => void | Promise<void>;
	onSwitchDialogClose?: () => void;
}

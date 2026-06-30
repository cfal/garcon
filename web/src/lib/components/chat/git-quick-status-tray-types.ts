export interface GitQuickBranchSelectorControls {
	branches: string[];
	isOpen: boolean;
	isLoading: boolean;
	onToggle: () => void;
	onClose: () => void;
	onCreateBranch: () => void;
	onSwitchBranch: (branch: string) => void;
}

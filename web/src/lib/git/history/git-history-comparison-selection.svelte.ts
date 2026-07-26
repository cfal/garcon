import type { GitComparisonDialogDefaults } from '$lib/git/review/git-comparison.svelte.js';

export type GitHistoryComparisonSelectionSlot = 'from' | 'to';

export class GitHistoryComparisonSelectionState {
	active = $state(false);
	slot = $state<GitHistoryComparisonSelectionSlot>('from');
	from = $state<string | null>(null);
	to = $state<string | null>(null);

	begin(): void {
		this.active = true;
		this.slot = 'from';
		this.from = null;
		this.to = null;
	}

	cancel(): void {
		this.active = false;
		this.slot = 'from';
		this.from = null;
		this.to = null;
	}

	select(hash: string): void {
		if (!this.active) return;
		if (this.slot === 'from') {
			this.from = hash;
			this.slot = 'to';
			return;
		}
		this.to = hash;
	}

	setSlot(slot: GitHistoryComparisonSelectionSlot): void {
		if (this.active) this.slot = slot;
	}

	take(): GitComparisonDialogDefaults | null {
		if (!this.from || !this.to) return null;
		const comparison: GitComparisonDialogDefaults = {
			fromRevision: this.from,
			toKind: 'revision',
			toRevision: this.to,
		};
		this.cancel();
		return comparison;
	}
}

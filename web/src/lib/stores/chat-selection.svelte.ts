// Multi-select state for sidebar chat items. Tracks which chats are
// selected and provides range-select, select-all, and bulk toggle.

export class ChatSelectionStore {
	selectedIds = $state<Set<string>>(new Set());
	isActive = $state(false);
	lastClickedId = $state<string | null>(null);

	get count(): number {
		return this.selectedIds.size;
	}

	isSelected(id: string): boolean {
		return this.selectedIds.has(id);
	}

	// Enters multi-select mode, optionally selecting an initial chat.
	enter(initialId?: string): void {
		this.isActive = true;
		if (initialId) {
			this.selectedIds = new Set([initialId]);
			this.lastClickedId = initialId;
		}
	}

	exit(): void {
		this.isActive = false;
		this.selectedIds = new Set();
		this.lastClickedId = null;
	}

	toggle(id: string): void {
		const next = new Set(this.selectedIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		this.selectedIds = next;
		this.lastClickedId = id;
	}

	// Selects a contiguous range from lastClickedId to targetId within
	// an ordered list. Additive: existing selections are preserved.
	selectRange(orderedIds: string[], targetId: string): void {
		if (!this.lastClickedId) {
			this.toggle(targetId);
			return;
		}
		const lastIdx = orderedIds.indexOf(this.lastClickedId);
		const targetIdx = orderedIds.indexOf(targetId);
		if (lastIdx === -1 || targetIdx === -1) {
			this.toggle(targetId);
			return;
		}
		const from = Math.min(lastIdx, targetIdx);
		const to = Math.max(lastIdx, targetIdx);
		const next = new Set(this.selectedIds);
		for (let i = from; i <= to; i++) {
			next.add(orderedIds[i]);
		}
		this.selectedIds = next;
	}

	selectAll(ids: string[]): void {
		this.selectedIds = new Set(ids);
	}

	deselectAll(): void {
		this.selectedIds = new Set();
		this.lastClickedId = null;
	}

	// Removes ids that no longer exist in the visible chat list.
	pruneToVisible(visibleIds: Set<string>): void {
		const next = new Set<string>();
		for (const id of this.selectedIds) {
			if (visibleIds.has(id)) next.add(id);
		}
		if (next.size !== this.selectedIds.size) {
			this.selectedIds = next;
		}
	}
}

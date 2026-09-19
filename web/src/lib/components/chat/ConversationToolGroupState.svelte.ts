export class ConversationToolGroupState {
	#surfaceIdentity: string | null = null;
	#expandedMemberIds = $state.raw<ReadonlySet<string>>(new Set());

	get expandedMemberIds(): ReadonlySet<string> {
		return this.#expandedMemberIds;
	}

	setExpanded(memberIds: readonly string[], expanded: boolean): void {
		const next = new Set(this.#expandedMemberIds);
		for (const id of memberIds) {
			if (expanded) next.add(id);
			else next.delete(id);
		}
		if (next.size !== this.#expandedMemberIds.size) this.#expandedMemberIds = next;
	}

	reconcile(surfaceIdentity: string, validRowIds: ReadonlySet<string>): void {
		if (this.#surfaceIdentity !== surfaceIdentity) {
			this.#surfaceIdentity = surfaceIdentity;
			this.#expandedMemberIds = new Set();
			return;
		}
		if (this.#expandedMemberIds.size === 0) return;
		const next = new Set([...this.#expandedMemberIds].filter((id) => validRowIds.has(id)));
		if (next.size !== this.#expandedMemberIds.size) this.#expandedMemberIds = next;
	}
}

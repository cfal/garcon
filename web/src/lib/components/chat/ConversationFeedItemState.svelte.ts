export type ConversationDisclosureKind =
	'thinking' | 'tool-input' | 'tool-result' | 'compaction' | 'cli-body';

export interface ConversationDisclosureStatePort {
	open(kind: ConversationDisclosureKind, localId: string, defaultOpen: boolean): boolean;
	setOpen(
		kind: ConversationDisclosureKind,
		localId: string,
		open: boolean,
		defaultOpen: boolean,
	): void;
}

export interface PermissionQuestionDraft {
	selectedQuestionOptions: Record<string, string[]>;
	rawInputOpen: boolean;
}

const EMPTY_PERMISSION_DRAFT: PermissionQuestionDraft = {
	selectedQuestionOptions: {},
	rawInputOpen: false,
};

export function disclosureStateKey(
	rowId: string,
	kind: ConversationDisclosureKind,
	localId: string,
): string {
	return JSON.stringify([rowId, kind, localId]);
}

function rowIdFromStateKey(key: string): string | null {
	try {
		const parsed: unknown = JSON.parse(key);
		return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
	} catch {
		return null;
	}
}

export class ConversationFeedItemState {
	#surfaceIdentity: string | null = null;
	#disclosureOverrides = $state.raw(new Map<string, boolean>());
	#permissionDrafts = $state.raw(new Map<string, PermissionQuestionDraft>());

	disclosurePort(rowId: string): ConversationDisclosureStatePort {
		return {
			open: (kind, localId, defaultOpen) =>
				this.disclosureOpen(disclosureStateKey(rowId, kind, localId), defaultOpen),
			setOpen: (kind, localId, open, defaultOpen) =>
				this.setDisclosureOpen(disclosureStateKey(rowId, kind, localId), open, defaultOpen),
		};
	}

	disclosureOpen(key: string, defaultOpen: boolean): boolean {
		return this.#disclosureOverrides.get(key) ?? defaultOpen;
	}

	setDisclosureOpen(key: string, open: boolean, defaultOpen: boolean): void {
		const next = new Map(this.#disclosureOverrides);
		if (open === defaultOpen) next.delete(key);
		else next.set(key, open);
		this.#disclosureOverrides = next;
	}

	permissionDraft(permissionOccurrenceId: string): PermissionQuestionDraft {
		return this.#permissionDrafts.get(permissionOccurrenceId) ?? EMPTY_PERMISSION_DRAFT;
	}

	setPermissionDraft(
		permissionOccurrenceId: string,
		draft: PermissionQuestionDraft,
	): void {
		const next = new Map(this.#permissionDrafts);
		next.set(permissionOccurrenceId, draft);
		this.#permissionDrafts = next;
	}

	reconcile(
		surfaceIdentity: string,
		validRowIds: ReadonlySet<string>,
		pendingPermissionOccurrences: ReadonlySet<string>,
	): void {
		if (surfaceIdentity !== this.#surfaceIdentity) {
			this.clear();
			this.#surfaceIdentity = surfaceIdentity;
		}
		const disclosures = new Map(
			[...this.#disclosureOverrides].filter(([key]) => {
				const rowId = rowIdFromStateKey(key);
				return rowId !== null && validRowIds.has(rowId);
			}),
		);
		if (disclosures.size !== this.#disclosureOverrides.size) {
			this.#disclosureOverrides = disclosures;
		}
		const drafts = new Map(
			[...this.#permissionDrafts].filter(([key]) => pendingPermissionOccurrences.has(key)),
		);
		if (drafts.size !== this.#permissionDrafts.size) this.#permissionDrafts = drafts;
	}

	clear(): void {
		this.#surfaceIdentity = null;
		this.#disclosureOverrides = new Map();
		this.#permissionDrafts = new Map();
	}
}

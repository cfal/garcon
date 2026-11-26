import type { ConversationRowMembership } from './conversation-retained-row-lookup.js';

export type ConversationDisclosureKind =
	| 'thinking'
	| 'tool-input'
	| 'tool-result'
	| 'compaction'
	| 'user-body'
	| 'cli-body'
	| 'notice-body';

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
	questionTextAnswers?: Record<string, string>;
	rawInputOpen: boolean;
}

const EMPTY_PERMISSION_DRAFT: PermissionQuestionDraft = {
	selectedQuestionOptions: {},
	rawInputOpen: false,
};
const MAX_DISCLOSURE_PORTS = 128;

export function disclosureStateKey(
	rowId: string,
	kind: ConversationDisclosureKind,
	localId: string,
): string {
	return `${rowId.length}:${rowId}:${kind}:${localId}`;
}

function rowIdFromStateKey(key: string): string {
	const delimiter = key.indexOf(':');
	return key.slice(delimiter + 1, delimiter + 1 + Number(key.slice(0, delimiter)));
}

function pruneMap<T>(entries: Map<string, T>, retain: (key: string) => boolean): Map<string, T> {
	let retained = entries;
	for (const key of entries.keys()) {
		if (retain(key)) continue;
		if (retained === entries) retained = new Map(entries);
		retained.delete(key);
	}
	return retained;
}

export class ConversationFeedItemState {
	#surfaceIdentity: string | null = null;
	#disclosureOverrides = $state.raw(new Map<string, boolean>());
	#permissionDrafts = $state.raw(new Map<string, PermissionQuestionDraft>());
	#ports = new Map<string, ConversationDisclosureStatePort>();

	get hasDisclosureOverrides(): boolean {
		return this.#disclosureOverrides.size > 0;
	}

	disclosurePort(rowId: string): ConversationDisclosureStatePort {
		const existing = this.#ports.get(rowId);
		if (existing) return existing;
		const port: ConversationDisclosureStatePort = {
			open: (kind, localId, defaultOpen) =>
				this.disclosureOpen(disclosureStateKey(rowId, kind, localId), defaultOpen),
			setOpen: (kind, localId, open, defaultOpen) =>
				this.setDisclosureOpen(disclosureStateKey(rowId, kind, localId), open, defaultOpen),
		};
		this.#ports.set(rowId, port);
		if (this.#ports.size > MAX_DISCLOSURE_PORTS) {
			const oldest = this.#ports.keys().next().value;
			if (oldest !== undefined) this.#ports.delete(oldest);
		}
		return port;
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
		validRowIds: ConversationRowMembership,
		pendingPermissionOccurrences: ReadonlySet<string>,
	): void {
		if (surfaceIdentity !== this.#surfaceIdentity) {
			this.clear();
			this.#surfaceIdentity = surfaceIdentity;
		}
		if (this.#disclosureOverrides.size > 0) {
			this.#disclosureOverrides = pruneMap(this.#disclosureOverrides, key => validRowIds.has(rowIdFromStateKey(key)));
		}
		if (this.#permissionDrafts.size > 0) {
			this.#permissionDrafts = pruneMap(this.#permissionDrafts, key => pendingPermissionOccurrences.has(key));
		}
	}

	clear(): void {
		this.#surfaceIdentity = null;
		this.#disclosureOverrides = new Map();
		this.#permissionDrafts = new Map();
		this.#ports.clear();
	}
}

import type { Issue, IssueCommentView, IssueDetail } from '$shared/issues';
import type { IssuesApi } from '$lib/api/issues.js';
import { IssueDraftState, type IssueDraftConfirmation } from './issue-draft-state.svelte.js';
import {
	ISSUE_RECOVERY_CAPACITY,
	type IssueDraftFields,
	type IssueDraftKind,
	type IssueDraftPartition,
	type IssueDraftSnapshot,
	type IssueRecoveryEntry,
	type IssueRecoveryPort,
} from './issue-draft-recovery.js';

export interface IssueDraftStoreDeps {
	readonly api: Pick<IssuesApi, 'mutate'>;
	readonly recovery: IssueRecoveryPort;
	readonly onConfirmed: (confirmation: IssueDraftConfirmation) => void;
	readonly onStoreChanged?: () => void;
	readonly onConflict?: (draft: IssueDraftState) => Promise<void>;
}
const samePartition = (left: IssueDraftPartition | null, right: IssueDraftPartition) =>
	left?.storeId === right.storeId && left.viewerKey === right.viewerKey;

export class IssueDraftStore {
	partition = $state.raw<IssueDraftPartition | null>(null);
	entries = $state.raw<readonly IssueRecoveryEntry[]>([]);
	oldEntries = $state.raw<readonly { partition: IssueDraftPartition; entry: IssueRecoveryEntry }[]>(
		[],
	);
	active = $state.raw<readonly IssueDraftState[]>([]);
	warning = $state<string | null>(null);
	#admitted = $state(false);
	#hiddenRecoveryViewers = $state.raw<readonly string[]>([]);
	#retained: IssueDraftState[] = [];

	constructor(private readonly deps: IssueDraftStoreDeps) {}

	setPartition(partition: IssueDraftPartition): void {
		const unchanged = this.#admitted && samePartition(this.partition, partition);
		this.#admitted = true;
		if (unchanged) return;
		this.#retainRecoveryGuard();
		this.flush();
		this.#retained = this.#retained.filter((draft) => {
			if (draft.needsExitGuard) return true;
			draft.dispose();
			return false;
		});
		this.partition = { storeId: partition.storeId, viewerKey: partition.viewerKey };
		this.#hiddenRecoveryViewers = this.#hiddenRecoveryViewers.filter(
			(viewer) => viewer !== partition.viewerKey,
		);
		this.active = this.#retained.filter((draft) => samePartition(partition, draft.current));
		this.reloadRecovery();
		for (const entry of this.entries) {
			if (entry.draft && !this.active.some((draft) => draft.current.id === entry.draft!.id))
				this.#add(entry.draft, true);
		}
	}

	reloadRecovery(): void {
		if (!this.partition || !this.#admitted) return;
		try {
			this.entries = this.deps.recovery.list(this.partition);
			this.oldEntries = this.deps.recovery
				.partitions(this.partition.viewerKey)
				.filter((prior) => prior.storeId !== this.partition!.storeId)
				.flatMap((prior) =>
					this.deps.recovery.list(prior).map((entry) => ({ partition: prior, entry })),
				);
			this.warning = null;
		} catch {
			this.warning =
				'Draft recovery is unavailable. Keep this tab open and copy unsaved text before leaving.';
		}
	}

	#add(snapshot: IssueDraftSnapshot, recovered: boolean): IssueDraftState {
		const draft = new IssueDraftState(
			snapshot,
			{
				...this.deps,
				onSettled: () => this.reloadRecovery(),
				isCurrentPartition: () => this.#admitted && samePartition(this.partition, snapshot),
			},
			recovered,
		);
		this.#retained.push(draft);
		this.active = [...this.active, draft];
		return draft;
	}

	open(
		kind: IssueDraftKind,
		detail: IssueDetail | { issue: Pick<Issue, 'id' | 'revision'> } | null,
		fields: IssueDraftFields = {},
		comment?: IssueCommentView,
	): IssueDraftState | null {
		if (!this.partition || !this.#admitted) return null;
		this.pruneClean(
			this.active
				.filter((draft) => draft.current.kind !== 'mutation')
				.map((draft) => draft.current.id),
		);
		const issueId = detail?.issue.id ?? null;
		const id = kind === 'create' ? 'new' : `${kind}:${issueId}:${comment?.id ?? ''}`;
		const existing = this.active.find((draft) => draft.current.id === id);
		const revision = comment?.revision ?? detail?.issue.revision ?? null;
		if (existing) {
			existing.beginEditing(fields, revision);
			return existing;
		}
		if (
			this.active.filter((draft) => draft.needsExitGuard).length +
				this.entries.filter((entry) => !entry.draft).length >=
			ISSUE_RECOVERY_CAPACITY
		) {
			this.warning =
				'Issue draft recovery is full. Copy or discard a retained draft before opening another editor.';
			return null;
		}
		return this.#add(
			{
				schemaVersion: 1,
				...this.partition,
				id,
				kind,
				issueId,
				commentId: comment?.id ?? null,
				baseRevision: revision,
				version: 0,
				fields,
				baseFields: fields,
				frozen: null,
			},
			false,
		);
	}

	pruneClean(keep: readonly string[] = []): void {
		const retained = this.#retained.filter(
			(draft) => draft.needsExitGuard || keep.includes(draft.current.id),
		);
		for (const draft of this.#retained) if (!retained.includes(draft)) draft.dispose();
		this.#retained = retained;
		this.active = retained.filter((draft) => samePartition(this.partition, draft.current));
	}

	releaseClean(draft: IssueDraftState): void {
		if (draft.needsExitGuard) return;
		this.#retained = this.#retained.filter((entry) => entry !== draft);
		this.active = this.active.filter((entry) => entry !== draft);
		draft.dispose();
	}

	discardEntry(entry: IssueRecoveryEntry): void {
		if (!this.partition) return;
		const draft = this.active.find((item) => item.current.id === entry.draft?.id);
		if (draft?.pending) return;
		try {
			draft?.discard();
			this.deps.recovery.discard(this.partition, entry.key);
			this.reloadRecovery();
		} catch {
			this.warning = 'Could not remove this recovery entry. Its text has been retained.';
		}
	}

	discardOldEntry(partition: IssueDraftPartition, entry: IssueRecoveryEntry): void {
		if (
			!this.#admitted ||
			partition.viewerKey !== this.partition?.viewerKey ||
			partition.storeId === this.partition.storeId
		)
			return;
		const retained = this.#retained.find(
			(draft) => samePartition(partition, draft.current) && draft.current.id === entry.draft?.id,
		);
		if (retained?.pending) return;
		try {
			retained?.discard();
			this.deps.recovery.discard(partition, entry.key);
			this.oldEntries = this.oldEntries.filter((item) => item.entry.key !== entry.key);
		} catch {
			this.warning = 'Could not remove this recovery entry. Its text has been retained.';
		}
	}

	get oldStoreDrafts(): readonly IssueDraftState[] {
		if (!this.#admitted) return [];
		return this.#retained.filter(
			(draft) =>
				draft.current.viewerKey === this.partition?.viewerKey &&
				draft.current.storeId !== this.partition.storeId &&
				draft.needsExitGuard,
		);
	}
	get needsExitGuard(): boolean {
		return (
			this.#retained.some((draft) => draft.needsExitGuard) ||
			this.entries.some((entry) => !entry.draft) ||
			this.oldEntries.length > 0 ||
			this.#hiddenRecoveryViewers.length > 0
		);
	}
	get pending(): boolean {
		return this.#retained.some((draft) => draft.pending);
	}
	suspend(): void {
		this.#retainRecoveryGuard();
		this.#admitted = false;
		this.flush();
		this.active = [];
		this.entries = [];
		this.oldEntries = [];
	}
	#retainRecoveryGuard(): void {
		const viewer = this.partition?.viewerKey;
		if (
			viewer &&
			(this.oldEntries.length > 0 || this.entries.some((entry) => !entry.draft)) &&
			!this.#hiddenRecoveryViewers.includes(viewer)
		) {
			this.#hiddenRecoveryViewers = [...this.#hiddenRecoveryViewers, viewer];
		}
	}
	flush(): void {
		for (const draft of this.#retained) draft.flush();
	}
	dispose(): void {
		for (const draft of this.#retained) draft.dispose();
	}
}

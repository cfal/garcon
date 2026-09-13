import type { Ticket, TicketCommentView, TicketDetail } from '$shared/tickets';
import type { TicketsApi } from '$lib/api/tickets.js';
import { TicketDraftState, type TicketDraftConfirmation } from './ticket-draft-state.svelte.js';
import {
	TICKET_RECOVERY_CAPACITY,
	type TicketDraftFields,
	type TicketDraftKind,
	type TicketDraftPartition,
	type TicketDraftSnapshot,
	type TicketRecoveryEntry,
	type TicketRecoveryPort,
} from './ticket-draft-recovery.js';

export interface TicketDraftStoreDeps {
	readonly api: Pick<TicketsApi, 'mutate'>;
	readonly recovery: TicketRecoveryPort;
	readonly onConfirmed: (confirmation: TicketDraftConfirmation) => void;
	readonly onStoreChanged?: () => void;
	readonly onConflict?: (draft: TicketDraftState) => Promise<void>;
}
const samePartition = (left: TicketDraftPartition | null, right: TicketDraftPartition) =>
	left?.storeId === right.storeId && left.viewerKey === right.viewerKey;

export class TicketDraftStore {
	partition = $state.raw<TicketDraftPartition | null>(null);
	entries = $state.raw<readonly TicketRecoveryEntry[]>([]);
	oldEntries = $state.raw<readonly { partition: TicketDraftPartition; entry: TicketRecoveryEntry }[]>(
		[],
	);
	active = $state.raw<readonly TicketDraftState[]>([]);
	warning = $state<string | null>(null);
	#admitted = $state(false);
	#hiddenRecoveryViewers = $state.raw<readonly string[]>([]);
	#retained: TicketDraftState[] = [];

	constructor(private readonly deps: TicketDraftStoreDeps) {}

	setPartition(partition: TicketDraftPartition): void {
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

	#add(snapshot: TicketDraftSnapshot, recovered: boolean): TicketDraftState {
		const draft = new TicketDraftState(
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
		kind: TicketDraftKind,
		detail: TicketDetail | { ticket: Pick<Ticket, 'id' | 'revision'> } | null,
		fields: TicketDraftFields = {},
		comment?: TicketCommentView,
	): TicketDraftState | null {
		if (!this.partition || !this.#admitted) return null;
		this.pruneClean(
			this.active
				.filter((draft) => draft.current.kind !== 'mutation')
				.map((draft) => draft.current.id),
		);
		const ticketId = detail?.ticket.id ?? null;
		const id = kind === 'create' ? 'new' : `${kind}:${ticketId}:${comment?.id ?? ''}`;
		const existing = this.active.find((draft) => draft.current.id === id);
		const revision = comment?.revision ?? detail?.ticket.revision ?? null;
		if (existing) {
			existing.beginEditing(fields, revision);
			return existing;
		}
		if (
			this.active.filter((draft) => draft.needsExitGuard).length +
				this.entries.filter((entry) => !entry.draft).length >=
			TICKET_RECOVERY_CAPACITY
		) {
			this.warning =
				'Ticket draft recovery is full. Copy or discard a retained draft before opening another editor.';
			return null;
		}
		return this.#add(
			{
				schemaVersion: 1,
				...this.partition,
				id,
				kind,
				ticketId,
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

	releaseClean(draft: TicketDraftState): void {
		if (draft.needsExitGuard) return;
		this.#retained = this.#retained.filter((entry) => entry !== draft);
		this.active = this.active.filter((entry) => entry !== draft);
		draft.dispose();
	}

	discardEntry(entry: TicketRecoveryEntry): void {
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

	discardOldEntry(partition: TicketDraftPartition, entry: TicketRecoveryEntry): void {
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

	get oldStoreDrafts(): readonly TicketDraftState[] {
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

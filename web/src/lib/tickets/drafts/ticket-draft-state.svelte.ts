import { parseHttpTicketMutationRequest, type TicketMutationPayload } from '$shared/ticket-commands';
import type { TicketWriteResult } from '$shared/tickets';
import { ApiError } from '$lib/api/client.js';
import { ticketConflict, type TicketConflict, type TicketsApi } from '$lib/api/tickets.js';
import { createRandomId } from '$lib/utils/random-id.js';
import type {
	FrozenTicketSubmission,
	TicketDraftField,
	TicketDraftFields,
	TicketDraftSnapshot,
	TicketRecoveryPort,
} from './ticket-draft-recovery.js';
import { requireDraftMutation } from './ticket-draft-recovery.js';

export interface TicketDraftConfirmation {
	readonly draft: TicketDraftState;
	readonly result: TicketWriteResult;
	readonly reused: boolean;
	readonly cleared: boolean;
}

export interface TicketDraftDeps {
	readonly api: Pick<TicketsApi, 'mutate'>;
	readonly recovery: TicketRecoveryPort;
	readonly onConfirmed: (confirmation: TicketDraftConfirmation) => void;
	readonly onStoreChanged?: () => void;
	readonly onConflict?: (draft: TicketDraftState) => Promise<void>;
	readonly onSettled?: () => void;
	readonly isCurrentPartition?: () => boolean;
}

export class TicketDraftState {
	#snapshot = $state.raw<TicketDraftSnapshot>();
	pending = $state(false);
	dirty = $state(false);
	error = $state<string | null>(null);
	conflict = $state.raw<TicketConflict | null>(null);
	recoveryWarning = $state<string | null>(null);
	storeChanged = $state(false);
	#timer: ReturnType<typeof setTimeout> | null = null;
	#disposed = false;
	#projectVersion = 0;

	constructor(
		snapshot: TicketDraftSnapshot,
		private readonly deps: TicketDraftDeps,
		recovered = false,
	) {
		this.#snapshot = snapshot;
		this.dirty = recovered;
		if (snapshot.frozen)
			this.error = 'Save not confirmed. Retry the same request or copy the draft.';
	}

	get current(): TicketDraftSnapshot {
		return this.#snapshot!;
	}
	get canEdit(): boolean {
		return (
			!this.#disposed &&
			!this.pending &&
			!this.current.frozen &&
			!this.storeChanged &&
			this.isCurrentPartition
		);
	}
	get canRetry(): boolean {
		return (
			!this.#disposed &&
			!this.pending &&
			this.current.frozen !== null &&
			!this.storeChanged &&
			this.isCurrentPartition
		);
	}
	get isCurrentPartition(): boolean {
		return !this.#disposed && (this.deps.isCurrentPartition?.() ?? true);
	}
	get needsExitGuard(): boolean {
		return (
			this.dirty || this.pending || this.current.frozen !== null || this.recoveryWarning !== null
		);
	}

	field(field: TicketDraftField): string {
		return this.current.fields[field] ?? '';
	}
	get projectDefaultVersion(): number {
		return this.#projectVersion;
	}

	beginEditing(fields: TicketDraftFields, baseRevision: number | null): void {
		if (this.needsExitGuard || !this.canEdit) return;
		this.#snapshot = {
			...this.current,
			fields,
			baseFields: fields,
			baseRevision,
			version: this.current.version + 1,
		};
	}

	setField(field: TicketDraftField, text: string): void {
		if (!this.canEdit || this.field(field) === text) return;
		if (field === 'project') this.#projectVersion++;
		this.#snapshot = {
			...this.current,
			version: this.current.version + 1,
			fields: { ...this.current.fields, [field]: text },
		};
		this.dirty = true;
		this.error = null;
		this.#scheduleRecovery();
	}

	applyDefaultProject(project: string, capturedVersion: number): void {
		if (this.#projectVersion !== capturedVersion || this.field('project') || !this.canEdit) return;
		this.#snapshot = { ...this.current, fields: { ...this.current.fields, project } };
		if (this.dirty) this.#scheduleRecovery();
	}

	reviewRevision(revision: number): void {
		if (!this.canEdit || this.current.kind === 'mutation') return;
		this.#snapshot = { ...this.current, baseRevision: revision, version: this.current.version + 1 };
		this.conflict = null;
		this.error = null;
		this.dirty = true;
		this.flush();
	}

	async submit(payload: TicketMutationPayload): Promise<void> {
		if (!this.canEdit || this.#disposed) return;
		try {
			const request = parseHttpTicketMutationRequest({
				requestId: createRandomId(),
				expectedStoreId: this.current.storeId,
				payload,
			});
			requireDraftMutation(this.current, request.payload);
			const submission: FrozenTicketSubmission = { version: this.current.version, request };
			this.#snapshot = { ...this.current, frozen: submission };
			await this.#send(submission, false);
		} catch (error) {
			this.error = error instanceof Error ? error.message : 'Invalid ticket input';
		}
	}

	async retry(): Promise<void> {
		if (!this.canRetry || this.#disposed) return;
		await this.#send(this.current.frozen!, true);
	}

	async #send(submission: FrozenTicketSubmission, reused: boolean): Promise<void> {
		this.pending = true;
		this.dirty = true;
		this.error = null;
		this.flush();
		let confirmation: TicketDraftConfirmation | null = null;
		try {
			const result = await this.deps.api.mutate(submission.request);
			const cleared = this.current.version === submission.version;
			this.#snapshot = { ...this.current, frozen: null, ...(cleared ? { fields: {} } : {}) };
			if (cleared) this.dirty = false;
			this.conflict = null;
			confirmation = { draft: this, result, reused, cleared };
		} catch (error) {
			this.conflict = ticketConflict(error);
			this.storeChanged = error instanceof ApiError && error.errorCode === 'TICKET_STORE_CHANGED';
			if (error instanceof ApiError && error.status < 500 && !this.storeChanged) {
				this.#snapshot = { ...this.current, frozen: null };
				if (this.current.kind === 'mutation') this.dirty = false;
				this.error = error.message;
			} else
				this.error = this.storeChanged
					? 'The ticket store changed. Copy or discard this draft; it cannot be submitted into the replacement store.'
					: 'Save not confirmed. Retry the same request or copy the draft.';
			if (this.conflict && this.isCurrentPartition) await this.deps.onConflict?.(this);
		} finally {
			this.pending = false;
			this.flush();
			this.deps.onSettled?.();
		}
		if (confirmation) {
			try {
				this.deps.onConfirmed(confirmation);
			} catch {
				this.error = 'Saved. Refresh Tickets to load the current server values.';
			}
		} else if (this.storeChanged && this.isCurrentPartition) this.deps.onStoreChanged?.();
	}

	discard(): void {
		if (this.pending) return;
		this.#snapshot = {
			...this.current,
			fields: {},
			frozen: null,
			version: this.current.version + 1,
		};
		this.dirty = false;
		this.error = null;
		this.conflict = null;
		this.flush();
	}

	flush(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		try {
			if (this.dirty || this.current.frozen) this.deps.recovery.write(this.current);
			else this.deps.recovery.remove(this.current, this.current.id);
			this.recoveryWarning = null;
		} catch (error) {
			this.recoveryWarning =
				error instanceof Error
					? error.message
					: 'Draft recovery is unavailable. Copy the text before leaving.';
		}
	}

	#scheduleRecovery(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.flush(), 200);
	}

	dispose(): void {
		this.#disposed = true;
		this.flush();
	}
}

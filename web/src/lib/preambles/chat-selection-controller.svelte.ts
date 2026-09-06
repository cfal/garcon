import { ApiError } from '$lib/api/client.js';
import {
	getChatPreambleSelection,
	updateChatPreambleSelection,
	type UpdateChatPreambleSelectionOutcome,
} from '$lib/api/chat-preambles.js';
import type {
	ChatPreambleSelectionInvalidationHub,
	ChatPreambleSelectionHubEvent,
} from '$lib/preambles/chat-selection-invalidation-hub.js';
import type {
	ChatPreambleSelection,
	PreambleId,
	PreambleSelectionProjection,
} from '$shared/preambles';

export interface ChatPreambleSelectionTarget {
	readonly chatId: string;
	readonly transcriptViewId: string;
}

export type ChatPreambleSelectionEditorStatus =
	| 'idle'
	| 'loading'
	| 'ready'
	| 'saving'
	| 'refresh-required'
	| 'error';

export interface ChatPreambleSelectionSavePartialWarning {
	readonly committed: true | 'unknown';
	readonly message: string;
}

/** Signals that the saved base moved under a dirty draft. */
export interface ChatPreambleSelectionConflict {
	readonly revision: number;
}

/** One logical save operation, retained verbatim across ambiguous retries. */
interface PendingSave {
	readonly clientRequestId: string;
	readonly clientMessageId: string;
	readonly expectedRevision: number;
	readonly orderedPreambleIds: readonly PreambleId[];
}

export interface ChatPreambleSelectionControllerDeps {
	readonly hub: ChatPreambleSelectionInvalidationHub;
	readonly newRequestId?: () => string;
	readonly load?: typeof getChatPreambleSelection;
	readonly save?: typeof updateChatPreambleSelection;
}

export class ChatPreambleSelectionController {
	status = $state<ChatPreambleSelectionEditorStatus>('idle');
	error = $state<string | null>(null);
	projection = $state<PreambleSelectionProjection | null>(null);
	baseRevision = $state(0);
	baseTranscriptViewId = $state('');
	canonicalProjectPath = $state('');
	draftIds = $state<PreambleId[]>([]);
	partialWarning = $state<ChatPreambleSelectionSavePartialWarning | null>(null);
	conflict = $state<ChatPreambleSelectionConflict | null>(null);
	#target: ChatPreambleSelectionTarget | null = null;
	#unsubscribe: (() => void) | null = null;
	#loadVersion = 0;
	#saveVersion = 0;
	#baseIds: PreambleId[] = [];
	#pendingSave: PendingSave | null = null;
	// Highest invalidation revision observed while a Save was in flight; a
	// second client can commit during the HTTP round trip.
	#deferredInvalidation: number | null = null;
	#deferredReconnect = false;

	readonly #deps: ChatPreambleSelectionControllerDeps;

	constructor(deps: ChatPreambleSelectionControllerDeps) {
		this.#deps = deps;
	}

	get target(): ChatPreambleSelectionTarget | null {
		return this.#target;
	}

	get chatId(): string | null {
		return this.#target?.chatId ?? null;
	}

	get dirty(): boolean {
		if (!this.#target) return false;
		return !idsEqual(this.#baseIds, this.draftIds);
	}

	get saving(): boolean {
		return this.status === 'saving';
	}

	get canSave(): boolean {
		// A refresh-required editor stays read-gated until reconciliation
		// confirms the committed server state.
		return this.status === 'ready' && this.dirty;
	}

	/** Opens the editor for a captured target; captures before any await. */
	async open(target: ChatPreambleSelectionTarget): Promise<void> {
		this.#teardown();
		this.#target = target;
		this.status = 'loading';
		this.error = null;
		this.partialWarning = null;
		this.conflict = null;
		this.draftIds = [];
		this.#baseIds = [];
		this.baseRevision = 0;
		this.baseTranscriptViewId = target.transcriptViewId;
		this.projection = null;
		this.#pendingSave = null;
		this.#subscribe(target.chatId);
		await this.#load(target);
	}

	/**
	 * Reloads the base from the server. A dirty draft is preserved; the base is
	 * rebased so a subsequent Save carries a fresh revision. This is the only
	 * path out of `refresh-required` after a durability-unknown commit.
	 */
	async refreshBase(): Promise<boolean> {
		return this.#refreshBase(false);
	}

	async #refreshBase(markDirtyConflict: boolean): Promise<boolean> {
		const target = this.#target;
		if (!target) return false;
		// A captured view identity is never retargeted: if the server moved to
		// another view, the editor surfaces the conflict instead of adopting it.
		const version = ++this.#loadVersion;
		const previousStatus = this.status;
		this.status = 'loading';
		// This read satisfies any reconnect already observed. A reconnect that
		// arrives while the read is in flight sets the flag again.
		this.#deferredReconnect = false;
		try {
			const wasDirty = this.dirty;
			const snapshot = await this.#loadNow(target);
			if (this.#loadVersion !== version) return false;
			// Rebase the base while preserving an in-progress dirty draft.
			this.#adopt(snapshot.transcriptViewId, snapshot.selection, snapshot.projection, true);
			this.canonicalProjectPath = snapshot.canonicalProjectPath;
			this.partialWarning = null;
			this.conflict = markDirtyConflict && wasDirty && this.dirty
				? { revision: snapshot.selection.revision }
				: null;
			// The server has definitively resolved any prior ambiguous save.
			this.#pendingSave = null;
			this.status = 'ready';
			this.#reconcileDeferredInvalidation();
			return true;
		} catch (error) {
			if (this.#loadVersion !== version) return false;
			this.status = previousStatus;
			this.error = errorMessage(error);
			return false;
		}
	}

	close(): void {
		this.#teardown();
		this.#target = null;
		this.status = 'idle';
		this.error = null;
		this.partialWarning = null;
		this.conflict = null;
		this.projection = null;
		this.draftIds = [];
		this.#baseIds = [];
		this.#pendingSave = null;
		this.#deferredInvalidation = null;
		this.#deferredReconnect = false;
	}

	#teardown(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#loadVersion += 1;
		this.#saveVersion += 1;
	}

	#subscribe(chatId: string): void {
		this.#unsubscribe = this.#deps.hub.subscribe((event) => this.#onInvalidated(event, chatId));
	}

	// Clients accept only nondecreasing selection revisions. A clean editor
	// refreshes; a dirty editor keeps its draft and shows a conflict. An
	// invalidation that lands mid-Save is retained and reconciled after the
	// save settles so the editor can never stay on a superseded revision.
	#onInvalidated(event: ChatPreambleSelectionHubEvent, chatId: string): void {
		if (event.kind === 'reconnect') {
			this.#refreshAfterReconnect();
			return;
		}
		if (event.chatId !== chatId || !this.#target) return;
		if (event.revision <= this.baseRevision) return;
		if (this.saving) {
			this.#deferredInvalidation = Math.max(
				this.#deferredInvalidation ?? 0,
				event.revision,
			);
			return;
		}
		if (this.status === 'loading' || this.status === 'refresh-required') return;
		if (this.dirty) {
			this.conflict = { revision: event.revision };
			return;
		}
		void this.open(this.#target);
	}

	// Reconnect refresh: reload the base for an already-open editor without
	// overwriting a dirty draft.
	#refreshAfterReconnect(): void {
		if (!this.#target) return;
		if (this.saving || this.status === 'loading') {
			this.#deferredReconnect = true;
			return;
		}
		if (this.status !== 'ready' && this.status !== 'refresh-required' && this.status !== 'error') {
			return;
		}
		void this.#refreshBase(true);
	}

	#reconcileDeferredInvalidation(): void {
		const reconnect = this.#deferredReconnect;
		this.#deferredReconnect = false;
		const deferred = this.#deferredInvalidation;
		this.#deferredInvalidation = null;
		if (!this.#target) return;
		if (reconnect) {
			void this.#refreshBase(true);
			return;
		}
		if (deferred === null) return;
		if (deferred <= this.baseRevision) return;
		if (this.dirty) {
			this.conflict = { revision: deferred };
			return;
		}
		void this.refreshBase();
	}

	async #load(target: ChatPreambleSelectionTarget): Promise<void> {
		const version = this.#loadVersion;
		try {
			const snapshot = await this.#loadNow(target);
			if (this.#loadVersion !== version) return;
			this.#adopt(snapshot.transcriptViewId, snapshot.selection, snapshot.projection);
			this.canonicalProjectPath = snapshot.canonicalProjectPath;
			this.status = 'ready';
			this.#reconcileDeferredInvalidation();
		} catch (error) {
			if (this.#loadVersion !== version) return;
			this.status = 'error';
			this.error = errorMessage(error);
		}
	}

	async #loadNow(target: ChatPreambleSelectionTarget) {
		const load = this.#deps.load ?? getChatPreambleSelection;
		const response = await load(target.chatId, target.transcriptViewId);
		if (
			response.chatId !== target.chatId
			|| response.transcriptViewId !== target.transcriptViewId
		) throw new Error('Chat transcript changed while loading preambles');
		return response;
	}

	#adopt(
		transcriptViewId: string,
		selection: ChatPreambleSelection,
		projection: PreambleSelectionProjection,
		preserveDraft = false,
	): void {
		const preserveCurrentDraft = preserveDraft && this.dirty;
		this.baseTranscriptViewId = transcriptViewId;
		this.baseRevision = selection.revision;
		this.#baseIds = [...selection.orderedPreambleIds];
		if (!preserveCurrentDraft) {
			this.draftIds = [...selection.orderedPreambleIds];
		}
		this.projection = projection;
		this.error = null;
		this.conflict = null;
	}

	move(id: PreambleId, direction: 'up' | 'down'): void {
		const index = this.draftIds.indexOf(id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= this.draftIds.length) return;
		const next = [...this.draftIds];
		[next[index], next[target]] = [next[target], next[index]];
		this.draftIds = next;
	}

	remove(id: PreambleId): void {
		this.draftIds = this.draftIds.filter((entry) => entry !== id);
	}

	add(id: PreambleId): void {
		if (this.draftIds.includes(id)) return;
		this.draftIds = [...this.draftIds, id];
	}

	setDraft(ids: readonly PreambleId[]): void {
		this.draftIds = [...ids];
	}

	resetDraft(): void {
		this.draftIds = [...this.#baseIds];
		this.conflict = null;
	}

	// A pending save's identity and payload survive transport-ambiguous
	// retries; any draft edit after a non-terminal attempt starts a new intent.
	#pendingSaveForCurrentDraft(): PendingSave {
		if (
			this.#pendingSave
			&& this.#pendingSave.expectedRevision === this.baseRevision
			&& idsEqual(this.#pendingSave.orderedPreambleIds, this.draftIds)
		) {
			return this.#pendingSave;
		}
		this.#pendingSave = {
			clientRequestId: this.#newRequestId(),
			clientMessageId: this.#newRequestId(),
			expectedRevision: this.baseRevision,
			orderedPreambleIds: [...this.draftIds],
		};
		return this.#pendingSave;
	}

	#newRequestId(): string {
		return this.#deps.newRequestId?.() ?? crypto.randomUUID();
	}

	/** Saves the changed selection through one gate; retains the draft on failure. */
	async save(): Promise<boolean> {
		const target = this.#target;
		if (!target || !this.canSave) return false;
		const version = ++this.#saveVersion;
		this.status = 'saving';
		this.error = null;
		this.conflict = null;
		const pending = this.#pendingSaveForCurrentDraft();
		this.#deferredInvalidation = null;
		this.#deferredReconnect = false;
		let outcome: UpdateChatPreambleSelectionOutcome;
		try {
			const save = this.#deps.save ?? updateChatPreambleSelection;
			outcome = await save({
				chatId: target.chatId,
				transcriptViewId: this.baseTranscriptViewId,
				clientRequestId: pending.clientRequestId,
				clientMessageId: pending.clientMessageId,
				expectedRevision: pending.expectedRevision,
				orderedPreambleIds: [...pending.orderedPreambleIds],
			});
		} catch (error) {
			if (this.#saveVersion !== version) return false;
			this.status = 'ready';
			this.#reconcileDeferredInvalidation();
			if (error instanceof ApiError
				&& (error.errorCode === 'PREAMBLE_SELECTION_REVISION_CONFLICT'
					|| error.errorCode === 'IDEMPOTENCY_CONFLICT')) {
				this.conflict = { revision: this.baseRevision };
			} else {
				this.error = errorMessage(error);
			}
			return false;
		}
		if (this.#saveVersion !== version) return false;
		if (outcome.kind === 'partial') {
			// The registry decision may already be committed; adopt the returned
			// selection as the new base without claiming rollback. A committed
			// notice stays editable; an unknown durability stays refresh-gated.
			if (outcome.partial.selectionCommitted === true) {
				this.status = 'ready';
				if (outcome.partial.selection) {
					this.#adoptBaseOnly(outcome.partial.selection);
				}
			} else {
				this.status = 'refresh-required';
			}
			this.partialWarning = {
				committed: outcome.partial.selectionCommitted,
				message: outcome.partial.message,
			};
			if (outcome.partial.selectionCommitted === true) {
				this.#reconcileDeferredInvalidation();
			}
			return false;
		}
		const response = outcome.response;
		this.status = 'ready';
		this.partialWarning = null;
		this.#pendingSave = null;
		this.#adoptBaseOnly(response.selection);
		this.projection = response.projection;
		this.#reconcileDeferredInvalidation();
		return true;
	}

	#adoptBaseOnly(selection: ChatPreambleSelection): void {
		this.baseRevision = selection.revision;
		this.#baseIds = [...selection.orderedPreambleIds];
		this.draftIds = [...selection.orderedPreambleIds];
		this.error = null;
		this.conflict = null;
	}
}

function idsEqual(left: readonly PreambleId[], right: readonly PreambleId[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

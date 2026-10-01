import type { ChatQueueState, QueueEntry, QueueEntryAttachment } from '$lib/types/chat';

export type QueuedInputEditPhase =
	| 'closed'
	| 'editable'
	| 'conflict'
	| 'steering'
	| 'sent'
	| 'removed';

export type QueuedInputMutation = 'idle' | 'saving' | 'queueing-draft';

interface QueuedInputEditorOptions {
	get queue(): ChatQueueState | null;
}

export class QueuedInputEditorState {
	entryId = $state<string | null>(null);
	draft = $state('');
	// Kept after the entry departs so a recovered draft can say what it no longer carries.
	attachments = $state<readonly QueueEntryAttachment[]>([]);
	baseRevision = $state<number | null>(null);
	mutation = $state<QueuedInputMutation>('idle');
	error = $state<string | null>(null);
	queueDraftOutcomeUnknown = $state(false);
	sessionRevision = $state(0);

	liveEntry = $derived.by(() => {
		if (!this.entryId) return null;
		return this.options.queue?.entries.find((entry) => entry.id === this.entryId) ?? null;
	});

	phase = $derived.by<QueuedInputEditPhase>(() => {
		if (!this.entryId) return 'closed';
		if (this.options.queue?.steeringEntryId === this.entryId) return 'steering';
		if (this.liveEntry) {
			return this.liveEntry.revision === this.baseRevision ? 'editable' : 'conflict';
		}
		if (this.options.queue?.recentlyDispatched.some((entry) => entry.entryId === this.entryId)) {
			return 'sent';
		}
		return 'removed';
	});
	mutationBlocked = $derived.by(() => this.options.queue?.steeringEntryId != null);
	// A replacement edits text only; a live entry keeps its attachments.
	hasReplacementContent = $derived(
		this.draft.trim().length > 0 || (this.liveEntry?.attachments.length ?? 0) > 0,
	);

	canSave = $derived(
		this.phase === 'editable' &&
			!this.mutationBlocked &&
			this.mutation === 'idle' &&
			this.hasReplacementContent,
	);

	constructor(private readonly options: QueuedInputEditorOptions) {}

	begin(entry: QueueEntry): void {
		this.sessionRevision += 1;
		this.entryId = entry.id;
		this.draft = entry.content;
		this.attachments = entry.attachments;
		this.baseRevision = entry.revision;
		this.mutation = 'idle';
		this.error = null;
		this.queueDraftOutcomeUnknown = false;
	}

	matchesSession(entryId: string, sessionRevision: number): boolean {
		return this.entryId === entryId && this.sessionRevision === sessionRevision;
	}

	reloadLatest(): void {
		if (!this.liveEntry) return;
		this.draft = this.liveEntry.content;
		this.baseRevision = this.liveEntry.revision;
		this.error = null;
	}

	rebaseOnLatest(): void {
		if (!this.liveEntry) return;
		this.baseRevision = this.liveEntry.revision;
		this.error = null;
	}

	markQueueDraftOutcomeUnknown(message: string): void {
		this.queueDraftOutcomeUnknown = true;
		this.error = message;
	}

	close(): void {
		this.sessionRevision += 1;
		this.entryId = null;
		this.draft = '';
		this.attachments = [];
		this.baseRevision = null;
		this.mutation = 'idle';
		this.error = null;
		this.queueDraftOutcomeUnknown = false;
	}
}

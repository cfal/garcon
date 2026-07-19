import type { ChatQueueState, QueueEntry } from '$lib/types/chat';

export type QueuedInputEditPhase =
	| 'closed'
	| 'editable'
	| 'conflict'
	| 'dispatching'
	| 'sent'
	| 'removed';

export type QueuedInputMutation = 'idle' | 'saving' | 'queueing-draft';

interface QueuedInputEditorOptions {
	get queue(): ChatQueueState | null;
}

export class QueuedInputEditorState {
	entryId = $state<string | null>(null);
	draft = $state('');
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
		if (this.liveEntry) {
			return this.liveEntry.revision === this.baseRevision ? 'editable' : 'conflict';
		}
		if (this.options.queue?.dispatchingEntryId === this.entryId) return 'dispatching';
		if (this.options.queue?.recentlyDispatched.some((entry) => entry.entryId === this.entryId)) {
			return 'sent';
		}
		return 'removed';
	});

	canSave = $derived(
		this.phase === 'editable' && this.mutation === 'idle' && this.draft.trim().length > 0,
	);

	constructor(private readonly options: QueuedInputEditorOptions) {}

	begin(entry: QueueEntry): void {
		this.sessionRevision += 1;
		this.entryId = entry.id;
		this.draft = entry.content;
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
		this.baseRevision = null;
		this.mutation = 'idle';
		this.error = null;
		this.queueDraftOutcomeUnknown = false;
	}
}

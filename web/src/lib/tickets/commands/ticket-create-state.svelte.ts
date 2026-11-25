import type { Ticket } from '$shared/tickets';
import type { TicketsApi } from '$lib/api/tickets.js';
import type { TicketDraftState } from '../drafts/ticket-draft-state.svelte.js';
import { canSubmitTicketForm, submitTicketForm } from './ticket-form.js';

type OpenChat = (ticket: Ticket) => void;

export class TicketCreateState {
	draft = $state.raw<TicketDraftState | null>(null);
	projectDefaultError = $state<string | null>(null);
	#projectRequest: AbortController | null = null;
	#chatIntent: { draft: TicketDraftState; version: number; open: OpenChat } | null = null;

	constructor(private readonly api: Pick<TicketsApi, 'projectDefault'>) {}

	async begin(draft: TicketDraftState, directory: string | null, executorId: string): Promise<void> {
		this.draft = draft;
		this.projectDefaultError = null;
		this.#projectRequest?.abort();
		if (draft.field('project') || draft.dirty || !directory) return;
		const request = new AbortController();
		this.#projectRequest = request;
		const version = draft.projectDefaultVersion;
		const current = () => this.draft === draft && !request.signal.aborted;
		try {
			const resolved = await this.api.projectDefault(directory, request.signal, executorId);
			if (current()) draft.applyDefaultProject(resolved.project, version);
		} catch (error) {
			if (current())
				this.projectDefaultError = error instanceof Error ? error.message : 'Enter a project to continue';
		} finally {
			if (this.#projectRequest === request) this.#projectRequest = null;
		}
	}

	async submitAndOpen(open: OpenChat): Promise<void> {
		const draft = this.draft;
		if (!draft || !canSubmitTicketForm(draft)) return;
		const intent = { draft, version: draft.current.version, open };
		this.#chatIntent = intent;
		await submitTicketForm(draft);
		// An uncertain create retains the continuation only for an explicit retry of this request.
		if (this.#chatIntent === intent && !draft.current.frozen) this.#chatIntent = null;
	}

	openChatAfterConfirmation(draft: TicketDraftState): OpenChat | null {
		const intent = this.#chatIntent;
		return intent?.draft === draft && intent.version === draft.current.version ? intent.open : null;
	}

	close(): void {
		this.cancel();
		this.draft?.flush();
		this.draft = null;
	}

	cancel(): void {
		this.#chatIntent = null;
		this.#projectRequest?.abort();
		this.#projectRequest = null;
	}
}

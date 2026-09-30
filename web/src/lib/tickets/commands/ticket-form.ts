import type { TicketDetail } from '$shared/tickets';
import { ticketOwnerKey } from '$shared/tickets';
import { parseTicketAssigneeQuery } from '$shared/ticket-validation';
import { parseTicketMutationPayload, type TicketMutationPayload } from '$shared/ticket-commands';
import type { TicketDraftFields } from '../drafts/ticket-draft-recovery.js';
import type { TicketDraftState } from '../drafts/ticket-draft-state.svelte.js';

export function ticketEditorFields(ticket: TicketDetail['ticket']): TicketDraftFields {
	return {
		title: ticket.title,
		description: ticket.description ?? '',
		project: ticket.project,
		priority: String(ticket.priority),
		labels: ticket.labels.join('\n'),
		assignee: ticket.assignee ? ticketOwnerKey(ticket.assignee) : '',
		parentId: ticket.parentId ?? '',
	};
}

export function ticketFormPayload(draft: TicketDraftState): TicketMutationPayload {
	const kind = draft.current.kind;
	if (kind === 'close')
		return parseTicketMutationPayload({
			action: 'close',
			ticketId: draft.current.ticketId,
			expectedRevision: draft.current.baseRevision,
			resolution: draft.field('resolution') || 'done',
			...(draft.field('body').trim() ? { comment: draft.field('body') } : {}),
		});
	if (kind === 'comment' || kind === 'comment-edit') {
		return parseTicketMutationPayload({
			action: kind,
			ticketId: draft.current.ticketId,
			body: draft.field('body'),
			...(kind === 'comment-edit'
				? { commentId: draft.current.commentId, expectedRevision: draft.current.baseRevision }
				: {}),
		});
	}
	const owner = draft.field('assignee');
	const parsedOwner = owner ? parseTicketAssigneeQuery(owner) : 'unassigned';
	const fields = {
		title: draft.field('title'),
		description: draft.field('description'),
		project: draft.field('project'),
		priority: Number(draft.field('priority') || '2'),
		labels: draft
			.field('labels')
			.split('\n')
			.filter((label) => label.trim()),
		assignee: parsedOwner === 'unassigned' ? null : parsedOwner,
		parentId: draft.field('parentId') || null,
	};
	return parseTicketMutationPayload(
		kind === 'create'
			? { action: 'create', input: fields }
			: {
					action: 'update',
					ticketId: draft.current.ticketId,
					expectedRevision: draft.current.baseRevision,
					patch: Object.fromEntries(
						Object.entries(fields).filter(([field]) => {
							const key = field as keyof typeof fields;
							return draft.field(key) !== (draft.current.baseFields[key] ?? '');
						}),
					),
				},
	);
}

export function canSubmitTicketForm(draft: TicketDraftState): boolean {
	if (!draft.canEdit || (!draft.dirty && draft.current.kind !== 'close')) return false;
	try {
		ticketFormPayload(draft);
		return true;
	} catch {
		return false;
	}
}

export function submitTicketForm(draft: TicketDraftState): Promise<void> {
	return canSubmitTicketForm(draft) ? draft.submit(ticketFormPayload(draft)) : Promise.resolve();
}

export function isTicketSubmitKey(event: KeyboardEvent, title = false): boolean {
	return !event.isComposing && event.key === 'Enter' && (title || event.metaKey || event.ctrlKey);
}

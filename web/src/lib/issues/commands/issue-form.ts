import type { IssueDetail } from '$shared/issues';
import { issueOwnerKey } from '$shared/issues';
import { parseIssueAssigneeQuery } from '$shared/issue-validation';
import { parseIssueMutationPayload, type IssueMutationPayload } from '$shared/issue-commands';
import type { IssueDraftFields } from '../drafts/issue-draft-recovery.js';
import type { IssueDraftState } from '../drafts/issue-draft-state.svelte.js';

export function issueEditorFields(issue: IssueDetail['issue']): IssueDraftFields {
	return {
		title: issue.title,
		description: issue.description ?? '',
		project: issue.project,
		priority: String(issue.priority),
		labels: issue.labels.join('\n'),
		assignee: issue.assignee ? issueOwnerKey(issue.assignee) : '',
		parentId: issue.parentId ?? '',
	};
}

export function issueFormPayload(draft: IssueDraftState): IssueMutationPayload {
	const kind = draft.current.kind;
	if (kind === 'close')
		return parseIssueMutationPayload({
			action: 'close',
			issueId: draft.current.issueId,
			expectedRevision: draft.current.baseRevision,
			resolution: draft.field('resolution') || 'done',
			...(draft.field('body').trim() ? { comment: draft.field('body') } : {}),
		});
	if (kind === 'comment' || kind === 'comment-edit') {
		return parseIssueMutationPayload({
			action: kind,
			issueId: draft.current.issueId,
			body: draft.field('body'),
			...(kind === 'comment-edit'
				? { commentId: draft.current.commentId, expectedRevision: draft.current.baseRevision }
				: {}),
		});
	}
	const owner = draft.field('assignee');
	const parsedOwner = owner ? parseIssueAssigneeQuery(owner) : 'unassigned';
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
	return parseIssueMutationPayload(
		kind === 'create'
			? { action: 'create', input: fields }
			: {
					action: 'update',
					issueId: draft.current.issueId,
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

export function canSubmitIssueForm(draft: IssueDraftState): boolean {
	if (!draft.canEdit || (!draft.dirty && draft.current.kind !== 'close')) return false;
	try {
		issueFormPayload(draft);
		return true;
	} catch {
		return false;
	}
}

export function submitIssueForm(draft: IssueDraftState): Promise<void> {
	return canSubmitIssueForm(draft) ? draft.submit(issueFormPayload(draft)) : Promise.resolve();
}

export function isIssueSubmitKey(event: KeyboardEvent, title = false): boolean {
	return !event.isComposing && event.key === 'Enter' && (title || event.metaKey || event.ctrlKey);
}

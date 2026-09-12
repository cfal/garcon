import type { HttpIssueMutationRequest } from '@garcon/common/issue-commands';
import type { Issue, IssueActor, IssueActivity, IssueDetail, IssueOwner, IssuePage,
  IssueSequencePage, IssueStatus, IssueWriteResult } from '@garcon/common/issues';

const unsafeControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const escapedControl = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

export function issueLineOutput(text: string): string {
  return text.replace(unsafeControls, escapedControl);
}

export function issueBodyOutput(text: string): string {
  return text.replace(unsafeControls, (character) => character === '\n' || character === '\t' ? character : escapedControl(character));
}

export function issueJsonOutput(value: unknown): string {
  return issueLineOutput(JSON.stringify(value));
}

export function issueShellArgument(value: string): string {
  const quoted = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(unsafeControls, escapedControl);
  return `$'${quoted}'`;
}

export function issueRetryDiagnostic(request: HttpIssueMutationRequest, kind?: 'repository' | 'folder' | 'explicit'): string {
  const flags = [`--request-id ${issueShellArgument(request.requestId)}`,
    `--expected-store-id ${issueShellArgument(request.expectedStoreId)}`];
  const lines = [`Request: ${request.requestId}`, `Store: ${request.expectedStoreId}`];
  if (request.payload.action === 'create') {
    lines.push(`Project (${kind ?? 'explicit'}): ${issueLineOutput(request.payload.input.project)}`);
    flags.push(`--project ${issueShellArgument(request.payload.input.project)}`);
  }
  lines.push(`To retry, reuse the same arguments and body with: ${flags.join(' ')}`);
  return lines.join('\n');
}

const statuses: Record<IssueStatus, string> = { open: 'Open', 'in-progress': 'In progress', 'in-review': 'In review', closed: 'Closed' };
const priorities = ['Urgent', 'High', 'Normal', 'Low'];

function ownerText(owner: IssueOwner | null): string {
  return owner === null ? 'Unassigned' : owner.kind === 'chat' ? `Chat ${owner.chatId}` : owner.username;
}

function actorText(actor: IssueActor): string {
  return actor.kind === 'chat' ? `Chat ${actor.chatId}` : actor.username
    + (actor.declaredChatId ? ` (declared for chat ${actor.declaredChatId})` : '');
}

function issueHeader(issue: Omit<Issue, 'description'>): string {
  return [issue.id, `${statuses[issue.status]}${issue.resolution ? ` (${issue.resolution})` : ''}`,
    priorities[issue.priority]!, ownerText(issue.assignee), issue.title].map(issueLineOutput).join('  ');
}

export function formatIssueList(page: IssuePage): string {
  const lines = page.items.map(issueHeader);
  if (!lines.length) lines.push('No issues match.');
  lines.push(`Store: ${page.storeId} · collection revision: ${page.collectionRevision}`);
  if (page.nextBeforeNumber !== null) lines.push(`More: --before-number ${page.nextBeforeNumber} --expected-collection-revision ${page.collectionRevision}`);
  return lines.join('\n');
}

export function formatIssueDetail(detail: IssueDetail): string {
  const issue = detail.issue;
  const lines = [issueHeader(issue), `Revision: ${issue.revision}`, `Project: ${issueLineOutput(issue.project)}`,
    `Labels: ${issue.labels.map(issueLineOutput).join(', ') || 'None'}`, `Parent: ${issue.parentId ?? 'None'}`,
    `Created by: ${issueLineOutput(actorText(issue.createdBy))}`, '',
    issue.description === null ? '(Description not requested)' : issueBodyOutput(issue.description)];
  for (const link of detail.links) lines.push(`${link.sourceId} ${link.kind} ${link.targetId}`);
  for (const comment of detail.comments.items) {
    lines.push('', `${comment.id} · revision ${comment.revision} · ${issueLineOutput(actorText(comment.author))} · ${comment.createdAt}`,
      comment.body === null ? '(Removed; previous versions remain in activity)' : issueBodyOutput(comment.body));
  }
  lines.push(`Store: ${detail.storeId} · collection revision: ${detail.collectionRevision}`);
  if (detail.comments.nextBeforeSequence !== null) lines.push(`More comments: --before-comment-sequence ${detail.comments.nextBeforeSequence} --expected-collection-revision ${detail.collectionRevision}`);
  return lines.join('\n');
}

export function formatIssueHistory(page: IssueSequencePage<IssueActivity>): string {
  const lines: string[] = [];
  for (const activity of page.items) {
    lines.push(`${activity.sequence} · ${activity.at} · ${issueLineOutput(actorText(activity.actor))} · ${activity.action}`);
    if ('changes' in activity) {
      for (const change of activity.changes) lines.push(`  ${change.field}: ${issueJsonOutput(change.before)} → ${issueJsonOutput(change.after)}`);
    } else if ('commentId' in activity) {
      lines.push(`  ${activity.commentId}`, `Before: ${issueBodyOutput(activity.before ?? '(none)')}`, `After: ${issueBodyOutput(activity.after ?? '(removed)')}`);
    } else if ('sourceId' in activity) lines.push(`  ${activity.sourceId} ${activity.kind} ${activity.targetId}`);
    else lines.push(`  ${issueLineOutput(activity.issue.title)}`);
  }
  if (!lines.length) lines.push('No activity.');
  if (page.nextBeforeSequence !== null) lines.push(`More: --before-sequence ${page.nextBeforeSequence}`);
  return lines.join('\n');
}

export function formatIssueMutation(result: IssueWriteResult): string {
  const lines = [issueHeader(result.issue), `Revision: ${result.issue.revision}`];
  if (result.comment) lines.push(`Comment: ${result.comment.id} · revision ${result.comment.revision}`);
  if (result.relatedIssue) lines.push(`Related issue: ${result.relatedIssue.id} · revision ${result.relatedIssue.revision}`);
  return lines.join('\n');
}

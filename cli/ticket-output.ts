import type { HttpTicketMutationRequest } from '@garcon/common/ticket-commands';
import type { Ticket, TicketActor, TicketActivity, TicketDetail, TicketOwner, TicketPage,
  TicketSequencePage, TicketStatus, TicketWriteResult } from '@garcon/common/tickets';

const unsafeControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const escapedControl = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

export function ticketLineOutput(text: string): string {
  return text.replace(unsafeControls, escapedControl);
}

export function ticketBodyOutput(text: string): string {
  return text.replace(unsafeControls, (character) => character === '\n' || character === '\t' ? character : escapedControl(character));
}

export function ticketJsonOutput(value: unknown): string {
  return ticketLineOutput(JSON.stringify(value));
}

export function ticketShellArgument(value: string): string {
  const quoted = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(unsafeControls, escapedControl);
  return `$'${quoted}'`;
}

export function ticketRetryDiagnostic(request: HttpTicketMutationRequest, kind?: 'repository' | 'folder' | 'explicit'): string {
  const flags = [`--request-id ${ticketShellArgument(request.requestId)}`,
    `--expected-store-id ${ticketShellArgument(request.expectedStoreId)}`];
  const lines = [`Request: ${request.requestId}`, `Store: ${request.expectedStoreId}`];
  if (request.payload.action === 'create') {
    lines.push(`Project (${kind ?? 'explicit'}): ${ticketLineOutput(request.payload.input.project)}`);
    flags.push(`--project ${ticketShellArgument(request.payload.input.project)}`);
  }
  lines.push(`To retry, reuse the same arguments and body with: ${flags.join(' ')}`);
  return lines.join('\n');
}

const statuses: Record<TicketStatus, string> = { open: 'Open', 'in-progress': 'In progress', 'in-review': 'In review', closed: 'Closed' };
const priorities = ['Urgent', 'High', 'Normal', 'Low'];

function ownerText(owner: TicketOwner | null): string {
  return owner === null ? 'Unassigned' : owner.kind === 'chat' ? `Chat ${owner.chatId}` : owner.username;
}

function actorText(actor: TicketActor): string {
  return actor.kind === 'chat' ? `Chat ${actor.chatId}` : actor.username
    + (actor.declaredChatId ? ` (declared for chat ${actor.declaredChatId})` : '');
}

function ticketHeader(ticket: Omit<Ticket, 'description'>): string {
  return [ticket.id, `${statuses[ticket.status]}${ticket.resolution ? ` (${ticket.resolution})` : ''}`,
    priorities[ticket.priority]!, ownerText(ticket.assignee), ticket.title].map(ticketLineOutput).join('  ');
}

export function formatTicketList(page: TicketPage): string {
  const lines = page.items.map(ticketHeader);
  if (!lines.length) lines.push('No tickets match.');
  lines.push(`Store: ${page.storeId} · collection revision: ${page.collectionRevision}`);
  if (page.nextBeforeNumber !== null) lines.push(`More: --before-number ${page.nextBeforeNumber} --expected-collection-revision ${page.collectionRevision}`);
  return lines.join('\n');
}

export function formatTicketDetail(detail: TicketDetail): string {
  const ticket = detail.ticket;
  const lines = [ticketHeader(ticket), `Revision: ${ticket.revision}`, `Project: ${ticketLineOutput(ticket.project)}`,
    `Labels: ${ticket.labels.map(ticketLineOutput).join(', ') || 'None'}`, `Parent: ${ticket.parentId ?? 'None'}`,
    `Created by: ${ticketLineOutput(actorText(ticket.createdBy))}`, '',
    ticket.description === null ? '(Description not requested)' : ticketBodyOutput(ticket.description)];
  for (const link of detail.links) lines.push(`${link.sourceId} ${link.kind} ${link.targetId}`);
  for (const comment of detail.comments.items) {
    lines.push('', `${comment.id} · revision ${comment.revision} · ${ticketLineOutput(actorText(comment.author))} · ${comment.createdAt}`,
      comment.body === null ? '(Removed; previous versions remain in activity)' : ticketBodyOutput(comment.body));
  }
  lines.push(`Store: ${detail.storeId} · collection revision: ${detail.collectionRevision}`);
  if (detail.comments.nextBeforeSequence !== null) lines.push(`More comments: --before-comment-sequence ${detail.comments.nextBeforeSequence} --expected-collection-revision ${detail.collectionRevision}`);
  return lines.join('\n');
}

export function formatTicketHistory(page: TicketSequencePage<TicketActivity>): string {
  const lines: string[] = [];
  for (const activity of page.items) {
    lines.push(`${activity.sequence} · ${activity.at} · ${ticketLineOutput(actorText(activity.actor))} · ${activity.action}`);
    if ('changes' in activity) {
      for (const change of activity.changes) lines.push(`  ${change.field}: ${ticketJsonOutput(change.before)} → ${ticketJsonOutput(change.after)}`);
    } else if ('commentId' in activity) {
      lines.push(`  ${activity.commentId}`, `Before: ${ticketBodyOutput(activity.before ?? '(none)')}`, `After: ${ticketBodyOutput(activity.after ?? '(removed)')}`);
    } else if ('sourceId' in activity) lines.push(`  ${activity.sourceId} ${activity.kind} ${activity.targetId}`);
    else lines.push(`  ${ticketLineOutput(activity.ticket.title)}`);
  }
  if (!lines.length) lines.push('No activity.');
  if (page.nextBeforeSequence !== null) lines.push(`More: --before-sequence ${page.nextBeforeSequence}`);
  return lines.join('\n');
}

export function formatTicketMutation(result: TicketWriteResult): string {
  const lines = [ticketHeader(result.ticket), `Revision: ${result.ticket.revision}`];
  if (result.comment) lines.push(`Comment: ${result.comment.id} · revision ${result.comment.revision}`);
  if (result.relatedTicket) lines.push(`Related ticket: ${result.relatedTicket.id} · revision ${result.relatedTicket.revision}`);
  return lines.join('\n');
}

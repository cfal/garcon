import type { TicketCommandOutcome, TicketNoticeContext } from './garcon-ticket-result.js';

export type TicketNoticePart =
  | { readonly kind: 'text' | 'code'; readonly text: string }
  | { readonly kind: 'ticket'; readonly ticketId: string };

const NOTICE_LABELS = {
  create: { success: 'Created ticket', failure: 'create ticket' },
  update: { success: 'Updated ticket', failure: 'update ticket' },
  claim: { success: 'Assigned ticket', failure: 'assign ticket' },
  release: { success: 'Released ticket', failure: 'release ticket' },
  reopen: { success: 'Reopened ticket', failure: 'reopen ticket' },
  close: { success: 'Closed ticket', failure: 'close ticket' },
  comment: { success: 'Added comment to ticket', failure: 'add comment to ticket' },
  'comment-edit': { success: 'Edited comment on ticket', failure: 'edit comment on ticket' },
  'comment-delete': { success: 'Deleted comment from ticket', failure: 'delete comment from ticket' },
  list: { success: 'Listed tickets', failure: 'list tickets' },
  read: { success: 'Read ticket', failure: 'read ticket' },
  history: { success: 'Read history for ticket', failure: 'read history for ticket' },
};

function listFilterValues(filters: NonNullable<TicketNoticeContext['filters']>): [label: string, value: string][] {
  const values: [string, string][] = [];
  if (filters.project !== undefined) values.push(['project', filters.project]);
  if (filters.status !== undefined) values.push(['status', filters.status.replaceAll('-', ' ')]);
  if (filters.includeClosed !== undefined) values.push(['include closed', String(filters.includeClosed)]);
  if (filters.priority !== undefined) values.push(['priority', ['urgent', 'high', 'normal', 'low'][filters.priority]!]);
  if (filters.label !== undefined) values.push(['label', filters.label]);
  const assignee = filters.assignee;
  if (assignee === 'unassigned') {
    values.push(['assignee', assignee]);
  } else if (assignee?.kind === 'user') {
    values.push(['assignee', assignee.username]);
  } else if (assignee) {
    values.push(['assignee', `chat ${assignee.chatId}`]);
  }
  if (filters.ready !== undefined) values.push(['ready', String(filters.ready)]);
  if (filters.query !== undefined) values.push(['search', filters.query]);
  return values;
}

export function ticketCommandNoticeParts(outcome: TicketCommandOutcome): TicketNoticePart[] {
  const parts: TicketNoticePart[] = [];
  const addText = (text: string) => parts.push({ kind: 'text', text });
  const addCode = (text: string) => parts.push({ kind: 'code', text });
  const addTicket = (ticketId: string) => parts.push({ kind: 'ticket', ticketId });
  const failed = outcome.status === 'error';
  if (outcome.command === 'link' || outcome.command === 'unlink') {
    const adding = outcome.command === 'link';
    const link = outcome.context?.link;
    let linkLabel = 'link';
    if (link?.kind === 'blocks') linkLabel = 'blocking link';
    else if (link?.kind === 'related') linkLabel = 'related link';
    if (failed) {
      addText(`Couldn't ${adding ? 'add' : 'remove'} ${linkLabel} from `);
      addTicket(outcome.ticketId);
    } else {
      addTicket(outcome.ticketId);
      addText(` updated, ${adding ? 'added' : 'removed'} ${linkLabel}`);
    }
    if (link) {
      addText(' to ');
      addTicket(link.targetId);
    }
  } else {
    const labels = NOTICE_LABELS[outcome.command];
    addText(failed ? `Couldn't ${labels.failure}` : labels.success);
    if ('ticketId' in outcome && outcome.ticketId) {
      addText(' ');
      addTicket(outcome.ticketId);
    }
    if (outcome.command === 'claim' && !failed) addText(' to this chat');
  }
  if (outcome.command === 'list' && outcome.context?.filters) {
    const values = listFilterValues(outcome.context.filters);
    for (const [index, [name, value]] of values.entries()) {
      addText(`${index === 0 ? ' with filters ' : ', '}${name} `);
      addCode(value);
    }
  }
  if (outcome.status === 'error') {
    addText(': ');
    addCode(outcome.errorCode);
  }
  return parts;
}

export function ticketCommandNoticeText(outcome: TicketCommandOutcome): string {
  return ticketCommandNoticeParts(outcome).map((part) => {
    switch (part.kind) {
      case 'ticket': return part.ticketId;
      case 'code': return JSON.stringify(part.text);
      case 'text': return part.text;
    }
  }).join('');
}

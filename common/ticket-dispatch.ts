// Shared ticket dispatch prompt contract. A dispatch starts a new chat whose
// first message is this template rendered with one ticket.

import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from './generation-prompts.js';
import type { Ticket } from './tickets.js';

export const TICKET_DISPATCH_TICKET_TOKEN = '{{ticket}}';

export const DEFAULT_TICKET_DISPATCH_PROMPT = `Work on the ticket below. Read the relevant code before you change it, keep the change focused on the ticket, and verify the result. When you finish, summarize what changed, how you verified it, and anything that is still open.

${TICKET_DISPATCH_TICKET_TOKEN}`;

export type TicketDispatchSubject = Pick<Ticket, 'id' | 'title' | 'project'> & {
  readonly description: string | null;
};

export type TicketDispatchPromptError = 'too-long' | 'missing-ticket-token';

/** Returns why a custom template cannot be saved, or null when an empty or valid template is given. */
export function ticketDispatchPromptError(template: string): TicketDispatchPromptError | null {
  if (template.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH) return 'too-long';
  if (template.trim() && !template.includes(TICKET_DISPATCH_TICKET_TOKEN)) return 'missing-ticket-token';
  return null;
}

export function formatTicketForDispatch(ticket: TicketDispatchSubject): string {
  const description = ticket.description?.trim();
  return [
    `Ticket ${ticket.id}: ${ticket.title}`,
    `Project: ${ticket.project}`,
    ...(description ? ['', description] : []),
  ].join('\n');
}

/** Renders the first chat message for a dispatch; an empty template selects the default. */
export function renderTicketDispatchPrompt(template: string | undefined, ticket: TicketDispatchSubject): string {
  const source = template?.trim() && !ticketDispatchPromptError(template)
    ? template
    : DEFAULT_TICKET_DISPATCH_PROMPT;
  return source.split(TICKET_DISPATCH_TICKET_TOKEN).join(formatTicketForDispatch(ticket)).trim();
}

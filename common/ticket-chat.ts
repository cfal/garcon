import { GENERATION_PROMPT_TEMPLATE_MAX_LENGTH } from './generation-prompts.js';
import type { Ticket } from './tickets.js';

export const TICKET_CHAT_TOKENS = {
  id: '{{ticket_id}}',
  title: '{{ticket_title}}',
  project: '{{ticket_project}}',
  description: '{{ticket_description}}',
} as const;

export const TICKET_CHAT_PROMPT_MAX_LENGTH = 256_000;

export const DEFAULT_TICKET_CHAT_PROMPT = `Work on the ticket below. Read the relevant code before making changes, keep the work focused, and verify the result. Use the available ticket tools to check its current status and ownership, claim it when appropriate, and keep its progress up to date. When finished, summarize the changes, verification, and anything still open.

Ticket {{ticket_id}}: {{ticket_title}}
Project label: {{ticket_project}}

{{ticket_description}}`;

export type TicketChatSubject = Pick<Ticket, 'id' | 'title' | 'project' | 'description'>;
export type TicketChatPromptError = 'too-long' | 'missing-ticket-id' | 'unknown-variable';

export function ticketChatPromptError(template: string): TicketChatPromptError | null {
  if (template.length > GENERATION_PROMPT_TEMPLATE_MAX_LENGTH) return 'too-long';
  if (!template.trim()) return null;
  if (!template.includes(TICKET_CHAT_TOKENS.id)) return 'missing-ticket-id';
  const tokens: readonly string[] = Object.values(TICKET_CHAT_TOKENS);
  for (const match of template.matchAll(/{{[^{}]*}}/g)) {
    if (!tokens.includes(match[0])) return 'unknown-variable';
  }
  return null;
}

/** Expands template variables once, without interpreting variables inside ticket content. */
export function renderTicketChatPrompt(template: string | undefined, ticket: TicketChatSubject): string {
  const source = template?.trim() ? template : DEFAULT_TICKET_CHAT_PROMPT;
  if (ticketChatPromptError(source)) throw new Error('The ticket chat prompt template is invalid. Update it in Settings.');
  const values: Record<string, string> = {
    [TICKET_CHAT_TOKENS.id]: ticket.id,
    [TICKET_CHAT_TOKENS.title]: ticket.title,
    [TICKET_CHAT_TOKENS.project]: ticket.project,
    [TICKET_CHAT_TOKENS.description]: ticket.description,
  };
  const pattern = /{{ticket_(?:id|title|project|description)}}/g;
  // Checks the expanded size before allocating repeated copies of a large description.
  let length = source.length;
  for (const match of source.matchAll(pattern)) length += values[match[0]]!.length - match[0].length;
  if (length > TICKET_CHAT_PROMPT_MAX_LENGTH) {
    throw new Error(`The expanded ticket chat prompt exceeds ${TICKET_CHAT_PROMPT_MAX_LENGTH} characters. Shorten the template in Settings.`);
  }
  return source.replace(pattern, (token) => values[token]!).trim();
}

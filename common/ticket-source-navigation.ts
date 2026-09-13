import type { TicketSource } from './tickets.js';
import { ticketChatId, ticketInvalid, ticketRecord, ticketSource } from './ticket-validation.js';

export type TicketSourceResolution =
  | { readonly kind: 'found'; readonly target: TicketSource }
  | { readonly kind: 'transcript-reloaded' | 'outcome-unavailable'; readonly chatId: string };

export function parseTicketSourceResolution(value: unknown): TicketSourceResolution {
  const raw = ticketRecord(value, ['kind', 'target', 'chatId']);
  if (raw.kind === 'found') {
    ticketRecord(raw, ['kind', 'target']);
    return { kind: raw.kind, target: ticketSource(raw.target) };
  }
  if (raw.kind === 'transcript-reloaded' || raw.kind === 'outcome-unavailable') {
    ticketRecord(raw, ['kind', 'chatId']);
    return { kind: raw.kind, chatId: ticketChatId(raw.chatId) };
  }
  return ticketInvalid('Invalid ticket source resolution.');
}

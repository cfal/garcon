import { createContext } from 'svelte';
import type { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
import type { TicketChatController } from '$lib/tickets/chat/ticket-chat-controller.svelte.js';

export const [getTicketsInvalidations, setTicketsInvalidations] = createContext<TicketsInvalidationHub>();
export const [getTicketChat, setTicketChat] = createContext<TicketChatController>();

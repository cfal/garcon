import { createContext } from 'svelte';
import type { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';
import type { TicketDispatchController } from '$lib/tickets/dispatch/ticket-dispatch-controller.svelte.js';

export const [getTicketsInvalidations, setTicketsInvalidations] = createContext<TicketsInvalidationHub>();
export const [getTicketDispatch, setTicketDispatch] = createContext<TicketDispatchController>();

import { createContext } from 'svelte';
import type { TicketsInvalidationHub } from '$lib/tickets/catalog/tickets-invalidation-hub.js';

export const [getTicketsInvalidations, setTicketsInvalidations] = createContext<TicketsInvalidationHub>();

import { createLogger } from '../lib/log.js';
import { ticketStorageUnavailable } from './errors.js';
import { TicketService, type TicketServiceOptions } from './service.js';
import { TicketStore } from './store.js';

export interface TicketRuntime {
  readonly service: TicketService;
  close(): void;
}

export function initializeTickets(workspaceDir: string, options: TicketServiceOptions): TicketRuntime {
  let service: TicketService | null = null;
  try {
    service = new TicketService(new TicketStore(workspaceDir), options);
  } catch {
    createLogger('tickets').warn('Ticket storage could not open; Tickets remain unavailable until restart.');
  }
  return {
    get service() {
      if (!service) throw ticketStorageUnavailable();
      return service;
    },
    close() { service?.close(); },
  };
}

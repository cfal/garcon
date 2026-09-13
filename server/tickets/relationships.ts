import type { Database } from 'bun:sqlite';
import { TICKET_LIMITS, type Ticket } from '../../common/tickets.js';
import { ticketNumber } from '../../common/ticket-validation.js';
import { TicketDomainError } from './errors.js';
import { requireTicket } from './records.js';

export function validateTicketParent(database: Database, ticket: Ticket): void {
  const visited = new Set([ticket.id]);
  let parentId = ticket.parentId;
  let ancestorDepth = 0;
  while (parentId) {
    if (visited.has(parentId)) throw new TicketDomainError('TICKET_RELATIONSHIP_CYCLE', 'Ticket parents must not form a cycle.');
    visited.add(parentId);
    ancestorDepth += 1;
    if (ancestorDepth > TICKET_LIMITS.ancestry) throw new TicketDomainError('TICKET_LIMIT_REACHED', 'Ticket ancestry is too deep.');
    parentId = requireTicket(database, parentId).parentId;
  }
  const descendantDepth = database.query<{ depth: number }, [number, number]>(`
    WITH RECURSIVE descendants(number,depth) AS (
      SELECT ?,0 UNION ALL
      SELECT i.number,d.depth+1 FROM tickets i JOIN descendants d ON i.parent_number=d.number WHERE d.depth<=?
    ) SELECT max(depth) AS depth FROM descendants
  `).get(ticket.number, TICKET_LIMITS.ancestry)?.depth ?? 0;
  if (ancestorDepth + descendantDepth > TICKET_LIMITS.ancestry) {
    throw new TicketDomainError('TICKET_LIMIT_REACHED', 'Ticket ancestry is too deep.');
  }
}

export function requireLinkCapacity(database: Database, source: number, target: number): void {
  for (const number of [source, target]) {
    const count = database.query<{ count: number }, [number, number]>(
      'SELECT count(*) AS count FROM ticket_links WHERE source_number=? OR target_number=?',
    ).get(number, number)?.count ?? 0;
    if (count >= TICKET_LIMITS.links) throw new TicketDomainError('TICKET_LIMIT_REACHED', 'A ticket can have at most 100 links.');
  }
}

export function requireNoBlockingCycle(database: Database, sourceId: string, targetId: string): void {
  const reached = database.query<{ number: number }, [number, number]>(`
    WITH RECURSIVE reachable(number) AS (
      SELECT ? UNION
      SELECT l.target_number FROM ticket_links l JOIN reachable r ON l.source_number=r.number WHERE l.kind='blocks'
    ) SELECT number FROM reachable WHERE number=? LIMIT 1
  `).get(ticketNumber(targetId), ticketNumber(sourceId));
  if (reached) throw new TicketDomainError('TICKET_RELATIONSHIP_CYCLE', 'Blocking links must not form a cycle.');
}

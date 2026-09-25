import type { ExecutionProjectService } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { TicketProjectDefault } from '../../../common/tickets.js';
import { parseTicketProjectDefault } from '../../../common/ticket-responses.js';
import { ticketString } from '../../../common/ticket-validation.js';
import { TicketDomainError, validateTicketInput } from '../../common/ticket-error.js';

export type TicketProjectResolver = (
  directory: string, signal?: AbortSignal, executorId?: string | null,
) => Promise<TicketProjectDefault>;

export function createTicketProjectResolver(
  projectService: (executorId: string) => Promise<ExecutionProjectService>,
): TicketProjectResolver {
  return async (directory, signal, executorId) => {
    validateTicketInput(() => ticketString(directory, 'directory'));
    try {
      signal?.throwIfAborted();
      const service = await projectService(effectiveExecutorId(executorId));
      return parseTicketProjectDefault(await service.ticketProjectDefault({ projectPath: directory }, { signal }));
    } catch {
      signal?.throwIfAborted();
      throw new TicketDomainError('TICKET_PROJECT_UNAVAILABLE',
        'Cannot resolve the project default. Check the context directory, or enter an explicit project.');
    }
  };
}

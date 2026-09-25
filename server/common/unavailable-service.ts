import { AgentCallError } from '@garcon/server-agent-interface';

export function unavailableService(service: string): AgentCallError {
  return new AgentCallError('not-dispatched', `Executor ${service} service is unavailable`, 'OPERATION_UNSUPPORTED');
}

import { AgentCallError } from '@garcon/server-agent-interface';

export function executorGenerationChanged(): AgentCallError {
  return new AgentCallError('not-dispatched', 'Executor generation changed during preparation. Refresh and try again.', 'STALE_RESOURCE');
}

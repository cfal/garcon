import { AgentCallError } from '@garcon/server-agent-interface';
import type { ExecutionFailureCertainty } from '../../../common/automation.js';

export function dispatchFailureCertainty(error: unknown): ExecutionFailureCertainty {
  if (error instanceof AgentCallError) {
    if (error.outcome === 'not-dispatched') return 'not-started';
    if (error.outcome === 'rejected') return 'definite';
  }
  return 'unknown';
}

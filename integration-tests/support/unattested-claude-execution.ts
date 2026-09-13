import type { AgentDispatchOutcome } from '../../server-agents/interface/src/index.js';
import type { ProviderExecutionService, ProviderRetainedExecutionService } from '../../server/execution-nodes/provider-execution.js';

/** Preserves legacy control characterization without attesting native settlement or capacity reuse. */
export function unattestedClaudeExecution(
  service: ProviderExecutionService & { readonly retained: ProviderRetainedExecutionService | null },
): ProviderRetainedExecutionService {
  if (service.retained !== null) throw new Error('Claude lifetime support must use the production worker fixture');
  return {
    prepare: (...args) => service.prepare(...args),
    release: (...args) => service.release(...args),
    abort: (...args) => service.abort(...args),
    prepareSteer: (...args) => service.prepareSteer(...args),
    steer: (...args) => service.steer(...args),
    submitGoalControl: (...args) => service.submitGoalControl(...args),
    beginDispatch(operation, input, delivery) {
      const dispatch = Promise.resolve().then(() => service.dispatch(operation, input, delivery)).then<AgentDispatchOutcome, AgentDispatchOutcome>(
        () => ({ kind: 'accepted' }),
        (error: unknown) => ({ kind: 'unknown', error }),
      );
      return { dispatch, settled: new Promise<void>(() => {}) };
    },
  };
}

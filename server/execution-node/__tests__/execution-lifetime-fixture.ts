import type { AgentExecutionHandle, AgentExecutionLifetime, AgentExecutionV5 } from '@garcon/server-agent-interface';

/** Separates controlled native completion from the legacy mock's handle and terminal timing. */
export function executionLifetimeFixture(execution: AgentExecutionV5, handle: AgentExecutionHandle | null) {
  const settlements: PromiseWithResolvers<void>[] = [];
  const lifetime: AgentExecutionLifetime = {
    begin(input) {
      let capturedHandle = handle;
      const settlement = Promise.withResolvers<void>();
      settlements.push(settlement);
      const dispatched = Promise.resolve().then(() => {
        if (input.kind === 'start') return execution.start(input.request);
        if (input.kind === 'resume') return execution.resume(input.request);
        throw new Error('Synthetic native compaction is unsupported');
      });
      return {
        dispatch: dispatched.then((returnedHandle) => { capturedHandle = returnedHandle; return { kind: 'accepted' }; }, (error: unknown) => ({ kind: 'unknown', error })),
        settled: settlement.promise,
        abort: async () => capturedHandle ? execution.abort(capturedHandle) : false,
      };
    },
  };
  return { lifetime, settlements };
}

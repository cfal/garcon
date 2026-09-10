import CodexIntegration from '../../server-agents/codex/src/index.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { createAgentProducerAdapter } from '../../server-agents/common/src/execution/producer-adapter.js';
import type { AgentRuntimeExecution, AgentRuntimePublisher } from '../../server-agents/common/src/execution/runtime-events.js';
import { defaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';

const gate = process.env.GARCON_TEST_PROVIDER_ABORT_GATE;
if (!gate) throw new Error('Goal handle fixture requires its isolated barrier');

// Supplies controlled provider lifetime while retaining the real producer and controller boundaries.
class DelayedGoalHandleIntegration extends CodexIntegration {
  constructor(host: AgentHost) {
    super(host);
    let active: { agentSessionId: string; publish: AgentRuntimePublisher } | null = null;
    const resumed = Promise.withResolvers<void>();
    const runtime: AgentRuntimeExecution = {
      async start(request, publish) {
        await request.admission.markStarted();
        const session = { agentSessionId: 'synthetic-native-session', nativeSession: null, nativeSeedReceipt: null };
        active = { agentSessionId: session.agentSessionId, publish };
        publish({ type: 'session', session });
        publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
        active = null;
        return session;
      },
      async resume(request, publish) {
        await request.admission.markStarted();
        active = { agentSessionId: request.agentSessionId, publish };
        resumed.resolve();
      },
      async abort(agentSessionId, publish) {
        const matches = active?.agentSessionId === agentSessionId && active.publish === publish;
        if (matches) active = null;
        const recorded = await fetch(`${gate}/result`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(matches),
          signal: AbortSignal.timeout(5_000),
        });
        if (!recorded.ok) throw new Error('Goal abort result barrier failed');
        return matches;
      },
      runningSessions: () => [],
    };
    const adapter = createAgentProducerAdapter(runtime, host.logger);
    Object.assign(this.execution, adapter.execution);
    this.execution.resume = async (request) => {
      const handle = await adapter.execution.resume(request);
      await resumed.promise;
      const held = await fetch(`${gate}/hold`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (!held.ok) throw new Error('Goal handle barrier failed');
      return handle;
    };
    this.goals.submitControl = (request) => adapter.submitGoalControl(request, async (goal, publish) => {
      const validate = () => {
        if (active?.publish !== publish) throw new Error('Synthetic goal occurrence changed');
      };
      await goal.beforeDelivery({ validate, commit: validate });
      return true;
    });
  }
}

const index = defaultAgentIntegrations.indexOf(CodexIntegration);
if (index < 0) throw new Error('Missing Codex integration in goal handle fixture');
defaultAgentIntegrations[index] = DelayedGoalHandleIntegration;

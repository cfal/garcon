import CodexIntegration from '../../server-agents/codex/src/index.js';
import type { AgentHost } from '../../server-agents/interface/src/index.js';
import { createAgentProducerAdapter } from '../../server-agents/common/src/execution/producer-adapter.js';
import type { AgentRuntimeExecution, AgentRuntimePublisher } from '../../server-agents/common/src/execution/runtime-events.js';
import { loadDefaultAgentIntegrations } from '../../server/agents/default-agent-integrations.js';
import { AssistantMessage } from '../../common/chat-types.js';

const defaultAgentIntegrations = await loadDefaultAgentIntegrations();

const gate = process.env.GARCON_TEST_PROVIDER_ABORT_GATE;
if (!gate) throw new Error('Goal handle fixture requires its isolated barrier');
const commitMode = process.env.GARCON_TEST_GOAL_COMMIT_MODE;
if (commitMode && !['terminal', 'terminal-throw', 'transfer-throw'].includes(commitMode)) {
  throw new Error('Unknown goal commit fixture mode');
}

// Supplies controlled provider lifetime while retaining the real producer and controller boundaries.
class DelayedGoalHandleIntegration extends CodexIntegration {
  constructor(host: AgentHost) {
    super(host);
    let active: { agentSessionId: string; publish: AgentRuntimePublisher; runId: string } | null = null;
    const resumed = Promise.withResolvers<void>();
    const runtime: AgentRuntimeExecution = {
      async start(request, publish) {
        await request.admission.markStarted();
        const session = { agentSessionId: 'synthetic-native-session', nativeSession: null, nativeSeedReceipt: null };
        active = { agentSessionId: session.agentSessionId, publish, runId: request.runId };
        publish({ type: 'session', session });
        publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
        active = null;
        return session;
      },
      async resume(request, publish) {
        await request.admission.markStarted();
        active = { agentSessionId: request.agentSessionId, publish, runId: request.runId };
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
      await goal.beforeDelivery({ validate, commit() {
        validate();
        if (!commitMode || !active) return;
        const predecessorRunId = active.runId;
        active.runId = goal.runId;
        publish({ type: 'run-ended', runId: predecessorRunId, outcome: 'finished' });
        if (commitMode !== 'transfer-throw') {
          publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-01T00:00:00.000Z', 'synthetic goal commit output') }] });
          publish({ type: 'run-ended', runId: goal.runId, outcome: 'finished' });
        }
        if (commitMode.endsWith('throw')) throw new Error('Synthetic failure after native goal transfer');
      } });
      return true;
    });
  }
}

const index = defaultAgentIntegrations.indexOf(CodexIntegration);
if (index < 0) throw new Error('Missing Codex integration in goal handle fixture');
defaultAgentIntegrations[index] = DelayedGoalHandleIntegration;

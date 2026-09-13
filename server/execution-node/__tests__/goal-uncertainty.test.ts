import { expect, test } from 'bun:test';
import { executionWireFixture } from './execution-wire-fixture.js';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import type { AgentRuntimeExecution, AgentRuntimePublisher } from '@garcon/server-agent-common/execution/runtime-events';

test('goal transfer failure retains the successor across wire, table, local execution and producer', async () => {
  const fixture = executionWireFixture();
  let source: AgentRuntimePublisher | null = null;
  let nativeRunId = 'synthetic-run';
  let abortCalls = 0;
  const runtime = {
    async start(_request, publish) {
      source = publish;
      return { agentSessionId: 'synthetic-native', nativeSession: null, nativeSeedReceipt: null };
    },
    async resume() {},
    async abort(agentSessionId, publish) {
      expect(agentSessionId).toBe('synthetic-native');
      expect(publish).toBe(source!);
      abortCalls++;
      return true;
    },
    runningSessions: () => [],
  } satisfies AgentRuntimeExecution;
  const producer = createAgentProducerAdapter(runtime, { debug() {}, info() {}, warn() {}, error() {} });
  fixture.execution.start.mockImplementation((request) => producer.execution.start(request));
  fixture.execution.abort.mockImplementation((handle) => producer.execution.abort(handle));
  fixture.goals.submitControl.mockImplementation((request) => producer.submitGoalControl(request, async (control) => {
    await control.beforeDelivery({
      validate() {},
      commit() {
        nativeRunId = control.runId;
        throw new Error('Synthetic post-transfer failure');
      },
    });
    return true;
  }));
  try {
    const ticket = await fixture.start();
    const prepared = await fixture.call({ method: 'prepare-goal', identity: ticket.identity,
      runId: 'synthetic-successor', configuration: fixture.request.configuration,
      body: fixture.body(ticket.identity, { kind: 'goal', prompt: 'synthetic goal input', attachments: [] }) });
    if (prepared.kind !== 'control-prepared' || prepared.preparation.kind !== 'ready') throw new Error('Synthetic goal was not prepared');
    expect(await fixture.call({ method: 'commit-goal', identity: ticket.identity, controlId: prepared.preparation.ticket.controlId }))
      .toEqual({ kind: 'goal-result', outcome: { kind: 'failed', outcome: 'unknown' } });
    expect(nativeRunId).toBe('synthetic-successor');
    expect(await fixture.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: {
      runId: nativeRunId, phase: 'dispatched', control: { outcome: { kind: 'failed', outcome: 'unknown' } },
    } });
    source!({ type: 'run-ended', runId: 'synthetic-run', outcome: 'finished' });
    expect(await fixture.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched' } });
    expect(await fixture.call({ method: 'prepare', location: fixture.location, request: fixture.request }))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(await fixture.call({ method: 'abort-run', identity: ticket.identity, runId: nativeRunId }))
      .toEqual({ kind: 'abort-result', requested: true });
    expect(abortCalls).toBe(1);
    source!({ type: 'run-ended', runId: nativeRunId, outcome: 'finished' });
    expect(await fixture.call({ method: 'status', identity: ticket.identity })).toMatchObject({ kind: 'status', receipt: { phase: 'ended', runId: nativeRunId } });
    expect(fixture.execution.start).toHaveBeenCalledTimes(1);
  } finally { await fixture.dispose(); }
});

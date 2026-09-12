import { describe, expect, it, mock } from 'bun:test';
import type {
  AgentEmissionSink, AgentEstablishedSession, AgentGoalControlRequest,
  AgentProducerEvent, AgentResumeRequestV5,
} from '@garcon/server-agent-interface';
import { createAgentProducerAdapter } from '../producer-adapter.js';
import { AgentRuntimeAdmissionRejectedError, type AgentRuntimeExecution, type AgentRuntimePublisher } from '../runtime-events.js';

const session: AgentEstablishedSession = {
  agentSessionId: 'native-session', nativeSession: null, nativeSeedReceipt: null,
};

function fixture() {
  const events: AgentProducerEvent[] = [];
  const output: AgentEmissionSink = { emit: (event) => { events.push(event); } };
  const publishers: AgentRuntimePublisher[] = [];
  let active: AgentRuntimePublisher | null = null;
  const activate = (publish: AgentRuntimePublisher) => {
    publishers.push(publish);
    active = publish;
  };
  const runtime = {
    async start(request, publish) { await request.admission.markStarted(); activate(publish); return session; },
    async resume(request, publish) { await request.admission.markStarted(); activate(publish); },
    abort: mock(async (agentSessionId: string, publish: AgentRuntimePublisher) => (
      agentSessionId === session.agentSessionId && publish === active
    )),
    runningSessions: () => [],
  } satisfies AgentRuntimeExecution;
  const adapter = createAgentProducerAdapter(runtime, {
    debug() {}, info() {}, warn() {}, error() {},
  });
  const request: AgentResumeRequestV5 = {
    chatId: 'chat', ...session, projectPath: '/project', model: 'model',
    permissionMode: 'default', thinkingMode: 'medium',
    settings: { ownerId: 'test', schemaVersion: 1, values: {} }, endpoint: null,
    runId: 'run-1', output,
    admission: { signal: new AbortController().signal, async markStarted() {} },
    prompt: 'synthetic prompt', attachments: [],
  };
  const goalRequest = (runId: string): AgentGoalControlRequest => ({
    ...request, runId, async beforeDelivery(handoff) { handoff.validate(); handoff.commit(); },
  });
  const goal = mock(async (input: Omit<AgentGoalControlRequest, 'output'>, publish: AgentRuntimePublisher) => {
    await input.beforeDelivery({ validate() {}, commit() {} });
    expect(publish).toBe(active!);
    return true;
  });
  return { adapter, runtime, request, goalRequest, goal, publishers, activate, events };
}

describe('producer execution occurrences', () => {
  it('preserves the admitted controls while a later attempt waits and then definitely refuses', async () => {
    const f = fixture();
    const handle = await f.adapter.execution.resume(f.request);
    const refusal = Promise.withResolvers<void>();
    f.runtime.resume = async () => refusal.promise;
    await f.adapter.execution.resume({ ...f.request, runId: 'refused-run' });
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).toBe(true);
    refusal.reject(new AgentRuntimeAdmissionRejectedError('synthetic busy admission'));
    await refusal.promise.catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.events).toContainEqual({ type: 'run-ended', runId: 'refused-run', outcome: 'failed',
      error: { code: 'SESSION_BUSY', message: 'synthetic busy admission' },
    });
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).toBe(true);
    expect(await f.adapter.execution.abort(handle)).toBe(true);
    expect(f.publishers).toHaveLength(1);
  });

  it.each(['start', 'compact'] as const)('preserves controls after a definitely refused %s', async (kind) => {
    const f = fixture();
    const handle = await f.adapter.execution.resume(f.request);
    const refuse = async () => { throw new AgentRuntimeAdmissionRejectedError('synthetic busy admission'); };
    f.runtime.start = refuse;
    const pending = kind === 'start'
      ? f.adapter.execution.start({ ...f.request, runId: 'refused', carriedContext: null })
      : f.adapter.compact({ ...f.request, runId: 'refused' }, refuse);
    await expect(pending).rejects.toBeInstanceOf(AgentRuntimeAdmissionRejectedError);
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).toBe(true);
    expect(await f.adapter.execution.abort(handle)).toBe(true);
  });

  it.each(['unknown', 'marked', 'published'] as const)('never restores previous controls after %s transfer evidence', async (mode) => {
    const f = fixture();
    await f.adapter.execution.resume(f.request);
    f.runtime.resume = async (request, publish) => {
      if (mode === 'marked') await request.admission.markStarted();
      if (mode === 'published') publish({ type: 'session', session });
      throw mode === 'unknown'
        ? new Error('synthetic uncertain admission')
        : new AgentRuntimeAdmissionRejectedError('synthetic late refusal');
    };
    await f.adapter.execution.resume({ ...f.request, runId: 'attempted-run' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).toBe(false);
  });

  it('does not revive a delayed older admission after its successor has ended', async () => {
    const f = fixture();
    const older = Promise.withResolvers<void>();
    f.runtime.resume = async (request, publish) => {
      if (request.runId === 'run-1') await older.promise;
      await request.admission.markStarted();
      publish({ type: 'session', session });
      if (request.runId === 'run-2') publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    };
    await f.adapter.execution.resume(f.request);
    await f.adapter.execution.resume({ ...f.request, runId: 'run-2' });
    older.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).toBe(false);
    expect(f.events.at(-1)).toEqual({ type: 'session', session });
  });
  it.each(['run-1', 'run-2'] as const)('attributes a terminal published inside goal commit for %s', async (terminalRunId) => {
    const f = fixture();
    await f.adapter.execution.resume(f.request);
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-2'), async (request, publish) => {
      await request.beforeDelivery({ validate() {}, commit() {
        publish({ type: 'run-ended', runId: terminalRunId, outcome: 'finished' });
      } });
      return true;
    })).toBe(true);
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).toBe(terminalRunId === 'run-1');
  });

  it('does not restore predecessor controls after a native goal transfer throws', async () => {
    const f = fixture();
    const handle = await f.adapter.execution.resume(f.request);
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-2'), async (request) => {
      await request.beforeDelivery({ validate() {}, commit() { throw new Error('synthetic post-transfer failure'); } });
      return true;
    })).rejects.toThrow('synthetic post-transfer failure');
    f.publishers[0]!({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
    expect(await f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).toBe(true);
    expect(await f.adapter.execution.abort(handle)).toBe(true);
  });

  it('issues frozen opaque handles and rejects structural or foreign handles', async () => {
    const owner = fixture();
    const foreign = fixture();
    const handle = await owner.adapter.execution.resume(owner.request);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(() => owner.adapter.execution.abort({ agentSessionId: session.agentSessionId }))
      .toThrow('Agent execution handle is invalid');
    expect(() => foreign.adapter.execution.abort(handle)).toThrow('Agent execution handle is invalid');
    expect(owner.runtime.abort).not.toHaveBeenCalled();
    expect(foreign.runtime.abort).not.toHaveBeenCalled();
    await expect(owner.adapter.execution.abort(handle)).resolves.toBe(true);
    expect(owner.runtime.abort).toHaveBeenCalledWith(session.agentSessionId, owner.publishers[0]);
  });

  it('cannot abort a successor sharing the session and output', async () => {
    const f = fixture();
    const old = await f.adapter.execution.resume(f.request);
    const current = await f.adapter.execution.resume({ ...f.request, runId: 'run-2' });
    expect(f.publishers[0]).not.toBe(f.publishers[1]);
    await expect(f.adapter.execution.abort(old)).resolves.toBe(false);
    await expect(f.adapter.execution.abort(current)).resolves.toBe(true);
    await expect(f.adapter.execution.abort(current)).resolves.toBe(true);
  });

  it('keeps an abort bound to its occurrence across an output replacement', async () => {
    const f = fixture();
    const old = await f.adapter.execution.resume(f.request);
    const current = await f.adapter.execution.resume({
      ...f.request, runId: 'run-2', output: { emit() {} },
    });
    await expect(f.adapter.execution.abort(old)).resolves.toBe(false);
    await expect(f.adapter.execution.abort(current)).resolves.toBe(true);
  });

  it('a delayed start handle cannot abort a successor or replace its goal target', async () => {
    const f = fixture();
    const started = Promise.withResolvers<AgentEstablishedSession>();
    f.runtime.start = async (_request, publish) => {
      f.activate(publish);
      return started.promise;
    };
    const old = f.adapter.execution.start({ ...f.request, carriedContext: null });
    await f.adapter.execution.resume({ ...f.request, runId: 'run-2' });
    f.publishers[0]!({ type: 'session', session });
    started.resolve(session);
    await expect(f.adapter.execution.abort(await old)).resolves.toBe(false);
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).resolves.toBe(true);
    expect(f.goal.mock.calls[0]![1]).toBe(f.publishers[1]!);
  });

  it('manual compaction starts a fresh occurrence on the same output', async () => {
    const f = fixture();
    const old = await f.adapter.execution.resume(f.request);
    const handle = await f.adapter.compact({ ...f.request, runId: 'compact' }, async (request, publish) => {
      expect(request).not.toHaveProperty('output');
      f.activate(publish);
    });
    await expect(f.adapter.execution.abort(old)).resolves.toBe(false);
    await expect(f.adapter.execution.abort(handle)).resolves.toBe(true);
  });

  it('goal handoff preserves the publisher and abort handle while retargeting terminal bookkeeping', async () => {
    const f = fixture();
    const handle = await f.adapter.execution.resume(f.request);
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).resolves.toBe(true);
    await expect(f.adapter.execution.abort(handle)).resolves.toBe(true);
    f.publishers[0]!({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).resolves.toBe(true);
    f.publishers[0]!({ type: 'run-ended', runId: 'run-3', outcome: 'finished' });
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-4'), f.goal)).resolves.toBe(false);
    f.publishers[0]!({ type: 'session', session });
    expect(f.events.at(-1)).toEqual({ type: 'session', session });
  });

  it('recognizes session activation and goal handoff before start returns its handle', async () => {
    const f = fixture();
    const started = Promise.withResolvers<AgentEstablishedSession>();
    f.runtime.start = async (_request, publish) => {
      f.activate(publish);
      publish({ type: 'session', session });
      return started.promise;
    };
    const pending = f.adapter.execution.start({ ...f.request, carriedContext: null });
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).resolves.toBe(true);
    started.resolve(session);
    await expect(f.adapter.execution.abort(await pending)).resolves.toBe(true);
  });

  it.each(['chat', 'session', 'output'] as const)('refuses goal control against a different %s', async (target) => {
    const f = fixture();
    await f.adapter.execution.resume(f.request);
    const request = {
      ...f.goalRequest('run-2'),
      ...(target === 'chat' ? { chatId: 'other-chat' } : {}),
      ...(target === 'session' ? { agentSessionId: 'other-session' } : {}),
      ...(target === 'output' ? { output: { emit() {} } } : {}),
    };
    await expect(f.adapter.submitGoalControl(request, f.goal)).resolves.toBe(false);
    expect(f.goal).not.toHaveBeenCalled();
  });

  it.each(['successor', 'terminal'] as const)('revalidates a goal handoff after %s during preparation', async (change) => {
    const f = fixture();
    await f.adapter.execution.resume(f.request);
    const commit = mock(() => {});
    const request = {
      ...f.goalRequest('run-2'),
      async beforeDelivery(handoff: Parameters<AgentGoalControlRequest['beforeDelivery']>[0]) {
        if (change === 'successor') await f.adapter.execution.resume({ ...f.request, runId: 'run-3' });
        else f.publishers[0]!({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
        handoff.commit();
      },
    };
    await expect(f.adapter.submitGoalControl(request, async (input) => {
      await input.beforeDelivery({ validate() {}, commit });
      return true;
    })).rejects.toThrow('execution occurrence changed');
    expect(commit).not.toHaveBeenCalled();
  });

  it('retires the goal target on asynchronous resume failure without dropping late session facts', async () => {
    const f = fixture();
    const completion = Promise.withResolvers<void>();
    f.runtime.resume = async (request, publish) => { await request.admission.markStarted(); f.activate(publish); return completion.promise; };
    await f.adapter.execution.resume(f.request);
    completion.reject(new Error('synthetic launch failure'));
    await completion.promise.catch(() => {});
    await Promise.resolve();
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).resolves.toBe(false);
    f.publishers[0]!({ type: 'session', session });
    expect(f.events.map((event) => event.type)).toEqual(['run-ended', 'session']);
  });

  it('asynchronous resume failure ends its handed-off run and retires goal control', async () => {
    const f = fixture();
    const completion = Promise.withResolvers<void>();
    f.runtime.resume = async (request, publish) => { await request.admission.markStarted(); f.activate(publish); return completion.promise; };
    await f.adapter.execution.resume(f.request);
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-2'), f.goal)).resolves.toBe(true);
    completion.reject(new Error('synthetic launch failure'));
    await completion.promise.catch(() => {});
    await Promise.resolve();
    expect(f.events).toEqual([{
      type: 'run-ended', runId: 'run-2', outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'synthetic launch failure' },
    }]);
    await expect(f.adapter.submitGoalControl(f.goalRequest('run-3'), f.goal)).resolves.toBe(false);
  });
});

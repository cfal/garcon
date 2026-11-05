import { expect, test } from 'bun:test';
import { WORKFLOW_LIMITS, type WorkflowMutation, type WorkflowMutationResult, type WorkflowOverview,
  type WorkflowPlan } from '../../../common/workflows.js';
import { WORKFLOW_MUTATION_PATHS, type WorkflowBootstrap } from '../../../common/workflow-http.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('maximum workflow reconciliation preserves ordinary output, Stop, and browser heartbeats', async () => {
  await withIntegrationFixture('workflow-responsiveness', async fixture => {
    const tasks: WorkflowPlan['tasks'] = Array.from({ length: WORKFLOW_LIMITS.tasks }, (_, index) => ({
      id: `gate-${index}`, title: `Synthetic gate ${index}`,
      dependsOn: index < 128 ? [] : Array.from({ length: 8 }, (_, dependency) => `gate-${dependency}`),
      spec: { kind: 'approval', purpose: 'manual', requirements: [] }, acceptance: [],
      retry: { maxAttempts: 1, backoffMs: 1000, repeatableFailure: false },
    }));
    expect(tasks.reduce((total, task) => total + task.dependsOn.length, 0)).toBe(WORKFLOW_LIMITS.edges);
    const plan: WorkflowPlan = { title: 'Synthetic maximum workflow', tasks,
      goal: { kind: 'artifacts', taskIds: ['gate-255'] }, policy: { concurrency: 1, allowRemoteWrites: false } };
    await fixture.client.put('/api/v1/workflows/enabled', { enabled: true });
    const bootstrap = await fixture.client.get<WorkflowBootstrap>('/api/v1/workflows/bootstrap');
    const mutate = (mutation: WorkflowMutation) => fixture.client.post<WorkflowMutationResult>(WORKFLOW_MUTATION_PATHS[mutation.action], {
      expectedStoreId: bootstrap.storeId, operationId: crypto.randomUUID(), mutation,
    });
    const created = await mutate({ action: 'create', captainChatId: null, plan });
    const read = () => fixture.client.get<WorkflowOverview>(`/api/v1/workflows/detail?id=${created.workflowId}`);
    const activation = (await read()).activationDigest;
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic ordinary output under workflow load' });
    const started = await fixture.client.startDirectChat({ chatId, projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.openAi, content: 'Synthetic ordinary output under workflow load' });
    await held.received;
    const cursor = fixture.client.markEvents();
    let probing = true;
    const samples: number[] = [];
    const probe = (async () => {
      while (probing) {
        const before = performance.now();
        await fixture.client.ping();
        samples.push(performance.now() - before);
        await Bun.sleep(25);
      }
    })();
    try {
      await mutate({ action: 'activate', workflowId: created.workflowId, manifestDigest: activation });
      await Promise.all([
        (async () => {
          for (let index = 0; index < 16; index++) {
            let detail = await read();
            const deadline = Date.now() + 10_000;
            while (!detail.gates.some(gate => gate.manifest.gateId === `gate-${index}`) && Date.now() < deadline) {
              await Bun.sleep(25); detail = await read();
            }
            const gate = detail.gates.find(gate => gate.manifest.gateId === `gate-${index}`)!;
            expect(gate).toBeDefined();
            await mutate({ action: 'approve', workflowId: created.workflowId, gateId: gate.manifest.gateId,
              manifestDigest: gate.digest, decision: 'approve' });
            expect((await read()).tasks).toHaveLength(WORKFLOW_LIMITS.tasks);
          }
        })(),
        (async () => {
          held.releaseText('Synthetic ordinary output remains responsive');
          expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
          const stoppedCall = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic stopped turn under workflow load' });
          const resumed = await fixture.client.runDirectChat({ chatId, agent: fixture.directAgents.openAi,
            content: 'Synthetic stopped turn under workflow load' });
          await stoppedCall.received;
          const aborted = stoppedCall.expectAbort();
          const before = performance.now();
          expect(await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() }))
            .toMatchObject({ outcome: 'interrupt-requested' });
          expect(performance.now() - before).toBeLessThan(1000);
          await aborted;
          await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
          await fixture.client.waitForProcessing(chatId, false);
        })(),
      ]);
    } finally {
      probing = false;
      await probe;
    }
    expect(samples.length).toBeGreaterThan(10);
    expect(Math.max(...samples)).toBeLessThan(500);
    expect(fixture.client.eventsSince(cursor).some(event => event.type === 'workflow-invalidated')).toBe(true);
    expect((await fixture.client.getMessages(chatId)).messages.length).toBeGreaterThan(0);
  });
}, 90_000);

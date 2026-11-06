import type { AutomationResult } from '../../../../common/automation.js';
import type { WorkflowManagedTarget, WorkflowPlan, WorkflowPlanTask, WorkflowRepositoryTarget } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import { WorkflowEvidence } from '../evidence.js';
import { workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { WorkflowResources } from '../resources.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import { effectFence, fixture, plan, prepareManagedTarget } from './fixture.js';

export const now = () => '2026-01-01T00:00:00.000Z';

export function integrationPlan(count = 2): WorkflowPlan {
  const check = plan().tasks[0]!;
  if (check.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const target = check.spec.target;
  const sources: WorkflowPlanTask[] = Array.from({ length: count }, (_, index) => ({ ...check, id: `source${index}`,
    spec: { kind: 'agent', target, outputs: ['commit'], prompt: 'Synthetic implementation.', selection: { agentId: 'codex', model: 'synthetic',
      apiProviderId: null, modelEndpointId: null, modelProtocol: null, providerRevision: null, permissionMode: 'default',
      thinkingMode: 'none', preambles: [], agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} } } } }));
  const integrate: WorkflowPlanTask = { ...check, id: 'integrate', dependsOn: sources.map(source => source.id),
    spec: { kind: 'integrate', target, strategy: 'ordered-merge', inputs: sources.map(source => source.id).reverse() },
    acceptance: [{ kind: 'artifact', output: 'commit' }] };
  return { ...plan(), goal: { kind: 'artifacts', taskIds: ['check'] }, tasks: [...sources, integrate,
    { ...check, dependsOn: ['integrate'], spec: { ...check.spec, target: { ...target, inputTaskId: 'integrate' } } }] };
}

export function replaceTarget(task: WorkflowPlanTask, change: Partial<WorkflowRepositoryTarget>): WorkflowPlanTask {
  if (!('target' in task.spec)) throw new Error('Synthetic target required.');
  return { ...task, spec: { ...task.spec, target: { ...task.spec.target, ...change } } };
}

export function observedRepository(resource: WorkflowManagedTarget, head = 'd'.repeat(40)) {
  return { executorId: resource.target.executorId, instanceId: resource.instanceId,
    managed: { managedResourceId: resource.managedResourceId, operationId: resource.operationId, repositoryIdentity: resource.repositoryIdentity,
      worktreeIdentity: resource.worktreeIdentity, worktreePath: resource.target.projectPath, branch: resource.branch,
      baseCommit: resource.head, head, dirty: false },
    commit: { commit: head, tree: 'e'.repeat(40), parents: [], containsAncestor: true } };
}

export function integrationFixture(input = integrationPlan()) {
  const f = fixture();
  const id = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId;
  f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const resources = new WorkflowResources(f.store, now);
  async function produce(task: WorkflowPlanTask, index: number) {
    let attempt = attempts.beginPreparation(attempts.reserve(id, task.id)!.attemptId);
    attempt = attempts.bindTarget(attempt.attemptId, prepareManagedTarget(resources, attempt));
    const resource = attempt.managedTarget!;
    const head = (index + 10).toString(16).padStart(40, '0');
    const key = { serverInstanceId: 'synthetic-controller', chatId: `${index + 1}234567890123456`, turnId: `synthetic-turn-${index}`, clientRequestId: attempt.requestId };
    attempt = attempts.bindPrepared(attempt.attemptId, key, workflowEffectiveInput(workflowStartInput(attempt, task)));
    attempts.markDispatching(attempt.attemptId, effectFence());
    const terminal: AutomationResult = { kind: 'completed', executionScope: { executorId: resource.target.executorId, instanceId: resource.instanceId },
      commandOutcome: null, receivedOutputCoverage: 'complete', receipt: { ...key, state: 'completed', acceptedAt: now(), updatedAt: now(), settledAt: now(),
        output: { availability: 'unavailable', reason: 'no-final-response' } } };
    attempt = attempts.observe(attempt.attemptId, workflowTerminalObservation(task, terminal), effectFence());
    const evidence = new WorkflowEvidence(f.store, { inspect: async () => observedRepository(resource, head) }, { now });
    (await evidence.capture(attempt, task, terminal, { ...effectFence(), outputGapped: false }, new AbortController().signal)).commit();
  }
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, id, attempts, resources, input,
    task: input.tasks.find(task => task.id === 'integrate')!,
    async produce() { for (const [index, task] of input.tasks.filter(task => task.spec.kind === 'agent').entries()) await produce(task, index); } };
}

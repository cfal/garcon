import type { AutomationService } from '../../automation/service.js';
import type { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.js';
import type { IChatRegistry } from '../../chats/store.js';
import type { ExecutorManager } from '../../executors/manager.js';
import type { WorkflowPlan, WorkflowPlanTask } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import { WorkflowApprovals } from '../approvals.js';
import { WorkflowChatAdmission } from '../admission.js';
import { WorkflowIntegrationAdmission } from '../integration-admission.js';
import { WorkflowEvidence } from '../evidence.js';
import { WorkflowResources } from '../resources.js';
import { WorkflowReconciler } from '../reconciler.js';
import { createWorkflowDispatchPort } from '../dispatch.js';
import { workflowCommitInputIds, workflowNeedsTransfer } from '../inputs.js';
import type { WorkflowStore } from '../store.js';
import type { WorkflowEngineLifecycle } from '../setup.js';
import { createWorkflowChatPort } from './garcon.js';
import { createWorkflowRepositoryPort } from './repositories.js';
import { createWorkflowIntegrationPort } from './integration.js';
import { createWorkflowPublicationPort, findRecoveredWorkflowPublication } from './publication.js';
import { WorkflowPublicationAdmission } from '../publication-admission.js';
import { inspectRecoveredWorkflowRepository } from './repository-runtime.js';
import { workflowConflict } from '../errors.js';
import { recheckPublication } from '../publication-recovery.js';
import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import { cleanupWorkflowResource } from '../cleanup.js';

export function workflowTargetsAvailable(task: WorkflowPlanTask, plan: WorkflowPlan,
  ready: (executorId: string) => boolean): boolean {
  if (!('target' in task.spec) || !ready(task.spec.target.executorId)) return false;
  const destination = task.spec.target;
  return workflowCommitInputIds(task).every(id => {
    const source = plan.tasks.find(candidate => candidate.id === id);
    return source && 'target' in source.spec
      && (!workflowNeedsTransfer(source.spec.target, destination) || ready(source.spec.target.executorId));
  });
}

export function createWorkflowEngine(store: WorkflowStore, deps: {
  readonly automation: AutomationService;
  readonly execution: ChatExecutionCoordinator;
  readonly chats: IChatRegistry;
  readonly executors: ExecutorManager;
  readonly onFailure: (error: unknown) => void;
  readonly onInvalidated: (workflowId: string, revision: number) => void;
}): WorkflowEngineLifecycle {
  const now = () => new Date().toISOString();
  let engine: WorkflowReconciler;
  const onInvalidated = (id: string, revision: number) => { deps.onInvalidated(id, revision); engine?.wake(id); };
  const attempts = new WorkflowAttempts(store, { now, onInvalidated });
  const resources = new WorkflowResources(store, now);
  const resolve = async (id: string) => deps.executors.requireExecutor(id);
  const repositories = createWorkflowRepositoryPort(resources, resolve);
  const chatPort = createWorkflowChatPort(deps.automation, deps.execution, deps.chats);
  const shutdown = new AbortController();
  const recoveries = new Set<Promise<void>>();
  const chats = new WorkflowChatAdmission(attempts, chatPort,
    repositories, new WorkflowEvidence(store, repositories, { now, onInvalidated }), {
      onFailure: deps.onFailure, onRevoked: id => engine.revokeAttempt(id),
    });
  const integration = new WorkflowIntegrationAdmission(attempts, resources, repositories, createWorkflowIntegrationPort(resolve), { now, onInvalidated });
  const publicationPort = createWorkflowPublicationPort(resolve);
  const publication = new WorkflowPublicationAdmission(attempts, resources, repositories, publicationPort, { now, onInvalidated });
  const ready = (id: string) => deps.executors.isReady(id) && deps.executors.list().some(executor => executor.id === id
    && executor.executorServices.git && (executor.bulk === null || executor.bulk.availability === 'ready'));
  const port = createWorkflowDispatchPort(attempts, chats, integration, (task, plan) => workflowTargetsAvailable(task, plan, ready), publication);
  const approvals = new WorkflowApprovals(store, { now, onInvalidated });
  engine = new WorkflowReconciler(store, attempts, port, { now, onFailure: deps.onFailure,
    async prepareApprovals(id, signal) {
      approvals.prepare(id);
      try { await approvals.preparePublication(id, publicationPort, signal); }
      catch { if (!signal.aborted) approvals.holdPublication(id); }
    } });
  const unsubscribeAvailability = deps.executors.onAvailabilityChanged(() => engine.wake());
  const unsubscribeChanges = deps.executors.onChanged(() => engine.wake());
  return {
    async observeAdoption(capture, requestSignal) {
      const signal = AbortSignal.any([requestSignal, shutdown.signal]);
      if (capture.kind === 'publication') {
        const lookup = await findRecoveredWorkflowPublication(resolve, capture.saved.publication, capture.saved.remote, signal);
        return { kind: 'publication', lookup, assertCurrent() { signal.throwIfAborted(); } };
      }
      const chatId = capture.attempt.chatId;
      const idle = async () => {
        if (chatId && deps.chats.hasChat(chatId)) {
          const current = await chatPort.inspect(chatId, signal);
          if (current.ownsExecution || current.pendingInput) workflowConflict('The worker has active or pending manual work.');
        }
      };
      await idle();
      const repository = await inspectRecoveredWorkflowRepository(resolve, capture.attempt.managedTarget!, signal);
      await idle();
      return { kind: 'commit', repository, assertCurrent() {
        signal.throwIfAborted();
        if (chatId && deps.execution.ownsExecution(chatId)) workflowConflict('The worker acquired execution during adoption.');
      } };
    },
    async recheckPublication(id, requestSignal) {
      const signal = AbortSignal.any([requestSignal, shutdown.signal, AbortSignal.timeout(10 * GIT_OPERATION_TIMEOUT_MS + 15_000)]);
      const work = recheckPublication(store, id, signal,
        (saved, signal) => findRecoveredWorkflowPublication(resolve, saved.publication, saved.remote, signal), { now, onInvalidated });
      recoveries.add(work);
      try { await work; } finally { recoveries.delete(work); }
    },
    async cleanup(id) {
      const work = cleanupWorkflowResource(store, id, resolve, shutdown.signal, { now, onInvalidated,
        async inspectWriters(executorId, path, signal) {
          for (const [chatId, chat] of Object.entries(deps.chats.listAllChats())) {
            if ((chat.executorId ?? 'local') !== executorId || !(chat.projectPath === path || chat.projectPath.startsWith(`${path}/`))) continue;
            const observed = await chatPort.inspect(chatId, signal);
            if (observed.ownsExecution || observed.pendingInput) workflowConflict('A chat still owns or queues work in this managed worktree.');
          }
        } });
      recoveries.add(work);
      try { await work; } finally { recoveries.delete(work); }
    },
    start: () => engine.start(), pauseAdmission: () => engine.pauseAdmission(),
    refreshControl: id => engine.refreshControl(id), stopRunning: id => engine.stopRunning(id), wake: id => engine.wake(id),
    beginShutdown() { shutdown.abort(); engine.beginShutdown(); },
    async waitForSettlements() { await engine.waitForSettlements(); await chats.waitForStops(); await Promise.allSettled(recoveries); },
    dispose() { shutdown.abort(); engine.beginShutdown(); unsubscribeAvailability(); unsubscribeChanges(); },
  };
}

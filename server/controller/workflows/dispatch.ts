import type { WorkflowAttempts } from './attempts.js';
import type { WorkflowDispatchPort } from './contracts.js';
import { workflowConflict } from './errors.js';
import { readPlan } from './records.js';

export function createWorkflowDispatchPort(attempts: WorkflowAttempts, chats: Pick<WorkflowDispatchPort, 'dispatch' | 'stop'>,
  integration: Pick<WorkflowDispatchPort, 'dispatch' | 'stop'>, available: WorkflowDispatchPort['available'],
  publication?: Pick<WorkflowDispatchPort, 'dispatch' | 'stop'>): WorkflowDispatchPort {
  const port = (attempt: Parameters<WorkflowDispatchPort['dispatch']>[0]) => {
    const task = attempts.store.read(db => readPlan(db, attempt.workflowId, attempt.planRevision)).plan.tasks.find(task => task.id === attempt.taskId)!;
    if (task.spec.kind === 'integrate') return integration;
    if (task.spec.kind === 'publish-pr' && publication) return publication;
    if (task.spec.kind === 'agent' || task.spec.kind === 'command') return chats;
    return workflowConflict('Task dispatcher is not available.');
  };
  return {
    available: (task, plan) => (['agent', 'command', 'integrate'].includes(task.spec.kind)
      || task.spec.kind === 'publish-pr' && !!publication) && available(task, plan),
    dispatch: (attempt, fence) => port(attempt).dispatch(attempt, fence),
    stop: (attempt, kind) => port(attempt).stop(attempt, kind),
  };
}

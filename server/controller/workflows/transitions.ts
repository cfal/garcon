import type { WorkflowAttempt, WorkflowOutcome, WorkflowPlan, WorkflowPlanTask, WorkflowRecord,
  WorkflowTaskRecord, WorkflowTaskView } from '../../../common/workflows.js';
import { workflowDescendants } from './graph.js';
import { workflowDigest } from './inputs.js';

export function invalidatedWorkflowTasks(previous: WorkflowPlan | null, next: WorkflowPlan): ReadonlySet<string> {
  if (!previous) return new Set(next.tasks.map(task => task.id));
  const previousById = new Map(previous.tasks.map(task => [task.id, task]));
  const changed = new Set(next.tasks.filter(task => workflowDigest(previousById.get(task.id) ?? null) !== workflowDigest(task)).map(task => task.id));
  if (workflowDigest(previous.policy) !== workflowDigest(next.policy)) next.tasks.forEach(task => changed.add(task.id));
  const removed = previous.tasks.filter(task => !next.tasks.some(candidate => candidate.id === task.id));
  removed.forEach(task => changed.add(task.id));
  return workflowDescendants(next, workflowDescendants(previous, changed));
}

export function projectWorkflowTasks(workflow: WorkflowRecord, plan: WorkflowPlan | null,
  tasks: readonly WorkflowTaskRecord[], attempts: readonly WorkflowAttempt[], admissionEpoch: number): WorkflowTaskView[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const succeeded = new Set(tasks.filter(task => attempts.some(attempt => attempt.taskId === task.id
    && attempt.generation === task.generation && attempt.resolution === 'succeeded' && task.hold === 'none')).map(task => task.id));
  return (plan?.tasks ?? []).map(spec => {
    const task = byId.get(spec.id)!;
    const history = attempts.filter(attempt => attempt.taskId === task.id);
    const unsettled = history.find(attempt => attempt.resolution === 'open' || attempt.resolution === 'unknown');
    const attempt = unsettled ?? history.findLast(attempt => attempt.generation === task.generation) ?? null;
    const base = { ...task, attempt, blockedReason: null };
    if (task.hold !== 'none') return { ...base, phase: 'outcome-unknown', blockedReason: task.holdReason ?? task.hold };
    if (attempt?.resolution === 'unknown') return { ...base, phase: 'outcome-unknown', blockedReason: 'Resolve the uncertain attempt before continuing.' };
    if (unsettled && unsettled.generation !== task.generation) return { ...base, phase: 'superseded', blockedReason: 'An earlier generation remains unsettled.' };
    if (attempt?.resolution === 'open') return { ...base, phase: attempt.result ? 'checking'
      : attempt.dispatchPhase === 'dispatching' || attempt.dispatchPhase === 'observed-running' ? 'running' : 'preparing' };
    if (attempt?.resolution === 'succeeded') return { ...base, phase: 'succeeded' };
    if (workflow.desired === 'canceled') return { ...base, phase: 'canceled' };
    if (attempt?.resolution === 'interrupted' || attempt?.resolution === 'abandoned') return { ...base, phase: 'interrupted' };
    if (attempt?.resolution === 'failed' && !automaticRetryAllowed(spec, history)) return { ...base, phase: 'failed' };
    if (history.filter(item => item.generation === task.generation && item.resolution === 'not-started').length >= 3) {
      return { ...base, phase: 'failed', blockedReason: 'Admission retry limit reached.' };
    }
    if (workflow.desired !== 'active' || workflow.admissionEpoch !== admissionEpoch) return { ...base, phase: 'blocked', blockedReason: 'Workflow admission is paused.' };
    if (!spec.dependsOn.every(id => succeeded.has(id))) return { ...base, phase: 'blocked', blockedReason: 'Waiting for current dependency evidence.' };
    if (spec.spec.kind === 'approval') return { ...base, phase: 'awaiting-approval' };
    return { ...base, phase: 'ready' };
  });
}

export function automaticRetryAllowed(task: WorkflowPlanTask, history: readonly WorkflowAttempt[]): boolean {
  const latest = history.at(-1);
  if (!latest || !task.retry.repeatableFailure || latest.resolution !== 'failed'
    || latest.result?.certainty !== 'definite' || latest.controlState === 'revoked') return false;
  const executed = history.filter(attempt => attempt.generation === latest.generation && attempt.resolution !== 'not-started');
  return executed.length < task.retry.maxAttempts;
}

export function workflowOutcome(plan: WorkflowPlan | null, tasks: readonly WorkflowTaskView[]): WorkflowOutcome {
  if (!plan) return 'pending';
  if (tasks.some(task => task.phase === 'outcome-unknown' || task.phase === 'awaiting-approval' || task.phase === 'interrupted')) return 'needs-attention';
  if (plan.goal.taskIds.every(id => tasks.some(task => task.id === id && task.phase === 'succeeded'))) return 'succeeded';
  if (tasks.some(task => task.phase === 'failed')) return 'failed';
  return 'pending';
}

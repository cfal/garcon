import type { WorkflowAttemptInspection, WorkflowDetail, WorkflowPlanTask, WorkflowTaskPhase, WorkflowTaskView } from '$shared/workflows';
import { WORKFLOW_ATTENTION_PHASES } from '$shared/workflows';

export interface WorkflowTaskRow {
  readonly task: WorkflowPlanTask;
  readonly current: WorkflowTaskView | null;
  readonly phase: WorkflowTaskPhase | 'draft';
}
export function historicalWorkflowRow(inspection: WorkflowAttemptInspection): WorkflowTaskRow {
  const resolution = inspection.attempt.resolution;
  const phase = resolution === 'unknown' || resolution === 'abandoned' ? 'outcome-unknown'
    : resolution === 'open' ? 'running' : resolution === 'not-started' ? 'interrupted' : resolution;
  return { task: inspection.task, current: null, phase };
}
export function workflowRows(detail: WorkflowDetail, view: 'active' | 'draft'): WorkflowTaskRow[] {
  const plan = view === 'draft' ? detail.draft : detail.active ?? detail.draft;
  const current = plan.revision === detail.active?.revision;
  return plan.plan.tasks.map(task => {
    const row = current ? detail.tasks.find(row => row.id === task.id) ?? null : null;
    return { task, current: row, phase: row?.phase ?? 'draft' };
  });
}
export function workflowNeedsAttention(phase: WorkflowTaskRow['phase']): boolean {
  return phase !== 'draft' && WORKFLOW_ATTENTION_PHASES.includes(phase);
}
export function workflowPhaseLabel(phase: WorkflowTaskRow['phase']): string {
  return phase.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase());
}

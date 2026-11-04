import type { Database } from 'bun:sqlite';
import { parseWorkflowPlan } from '../../../common/workflow-validation.js';
import { readAttempts, readPlan, readTasks, requireWorkflow } from './records.js';

export function workflowProviderReferences(database: Database): ReadonlySet<string> {
  const refs = new Set<string>();
  const addPlan = (json: string) => {
    for (const task of parseWorkflowPlan(JSON.parse(json)).tasks) {
      if (task.spec.kind === 'agent' && task.spec.selection.apiProviderId) refs.add(task.spec.selection.apiProviderId);
    }
  };
  for (const row of database.query<{ id: string }, []>('SELECT id FROM workflows').all()) {
    const workflow = requireWorkflow(database, row.id);
    const unsettled = database.query(`SELECT 1 FROM attempts WHERE workflow_id=? AND resolution IN ('open','unknown')
      UNION ALL SELECT 1 FROM operation_intents o JOIN attempts a ON a.id=o.attempt_id
      WHERE a.workflow_id=? AND o.status IN ('planned','dispatching','unknown') LIMIT 1`).get(row.id, row.id);
    if (unsettled) {
      for (const plan of database.query<{ plan_json: string }, [string]>(`SELECT DISTINCT p.plan_json FROM plan_revisions p
        JOIN attempts a ON a.workflow_id=p.workflow_id AND a.plan_revision=p.revision
        WHERE a.workflow_id=? AND (a.resolution IN ('open','unknown') OR EXISTS
          (SELECT 1 FROM operation_intents o WHERE o.attempt_id=a.id AND o.status IN ('planned','dispatching','unknown')))`)
        .all(row.id)) addPlan(plan.plan_json);
    }
    if (workflow.archived || workflow.desired === 'canceled') continue;
    const draft = readPlan(database, row.id, workflow.draftPlanRevision);
    const active = workflow.activePlanRevision === null ? null : readPlan(database, row.id, workflow.activePlanRevision);
    const tasks = readTasks(database, row.id);
    const attempts = readAttempts(database, row.id);
    const completed = active?.plan.goal.taskIds.every(id => {
      const task = tasks.find(entry => entry.id === id);
      return task?.hold === 'none' && attempts.some(attempt => attempt.taskId === id && attempt.generation === task.generation && attempt.resolution === 'succeeded');
    });
    if (!completed || workflow.draftPlanRevision !== workflow.activePlanRevision) addPlan(JSON.stringify(draft.plan));
    if (active && !completed) addPlan(JSON.stringify(active.plan));
  }
  return refs;
}

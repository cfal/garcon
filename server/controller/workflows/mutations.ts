import type { Database } from 'bun:sqlite';
import type { WorkflowMutation, WorkflowPlan, WorkflowRecord } from '../../../common/workflows.js';
import { DomainError } from '../../common/domain-error.js';
import { workflowConflict } from './errors.js';
import { validateWorkflowGraph, workflowDescendants } from './graph.js';
import { workflowDigest } from './inputs.js';
import { activationManifest, readAttempts, readGateManifests, readPlan, readTasks, requireAttempt, requireWorkflow, workflowEpoch } from './records.js';
import { invalidatedWorkflowTasks } from './transitions.js';

export function mutateWorkflow(database: Database, mutation: WorkflowMutation, actor: string, now: string): string {
  if (mutation.action === 'create') {
    validateWorkflowGraph(mutation.plan);
    const id = crypto.randomUUID();
    database.query(`INSERT INTO workflows VALUES (?,1,'draft',1,NULL,?,0,?,?,0,?,?)`)
      .run(id, workflowEpoch(database), mutation.plan.title, mutation.captainChatId, now, now);
    insertPlan(database, id, 1, mutation.plan);
    return id;
  }
  const workflow = requireWorkflow(database, mutation.workflowId);
  if (workflow.archived && mutation.action !== 'archive') workflowConflict('Archived workflows cannot be changed.');
  switch (mutation.action) {
    case 'plan': {
      if (workflow.desired === 'canceled') workflowConflict('Canceled workflows cannot be replanned.');
      if (workflow.draftPlanRevision !== mutation.expectedPlanRevision) workflowConflict('Draft plan changed.');
      validateWorkflowGraph(mutation.plan);
      const revision = workflow.draftPlanRevision + 1;
      insertPlan(database, workflow.id, revision, mutation.plan);
      database.query('UPDATE workflows SET draft_plan_revision=?,title=? WHERE id=?').run(revision, mutation.plan.title, workflow.id);
      break;
    }
    case 'activate': activate(database, workflow, mutation.manifestDigest); break;
    case 'pause': case 'stop': case 'cancel': {
      const desired = workflow.desired === 'canceled' || mutation.action === 'cancel' ? 'canceled' : 'paused';
      database.query('UPDATE workflows SET desired=?,control_epoch=control_epoch+1 WHERE id=?').run(desired, workflow.id);
      if (mutation.action !== 'pause') {
        database.query(`UPDATE tasks SET hold='intervention',hold_reason=? WHERE workflow_id=? AND EXISTS
          (SELECT 1 FROM attempts a WHERE a.workflow_id=tasks.workflow_id AND a.task_id=tasks.id AND a.resolution IN ('open','unknown'))`)
          .run(`Workflow ${mutation.action} requested.`, workflow.id);
        database.query(`UPDATE attempts SET control_state='revoked',revocation_reason=? WHERE workflow_id=? AND resolution IN ('open','unknown')`)
          .run(`Workflow ${mutation.action} requested.`, workflow.id);
      }
      break;
    }
    case 'resume':
      if (workflow.desired === 'canceled' || !workflow.activePlanRevision || workflow.controlEpoch !== mutation.controlEpoch
        || workflow.activePlanRevision !== mutation.planRevision) workflowConflict('Workflow control or approved plan changed.');
      database.query(`UPDATE workflows SET desired='active',admission_epoch=?,control_epoch=control_epoch+1 WHERE id=?`)
        .run(workflowEpoch(database), workflow.id);
      break;
    case 'archive':
      if (workflow.desired !== 'canceled' && workflow.desired !== 'paused' && workflow.desired !== 'draft') workflowConflict('Pause or cancel before archiving.');
      database.query('UPDATE workflows SET archived=1 WHERE id=?').run(workflow.id);
      break;
    case 'approve': {
      const gate = readGateManifests(database, workflow.id).find(entry => entry.manifest.gateId === mutation.gateId);
      if (!gate || gate.digest !== mutation.manifestDigest) workflowConflict('Approval manifest changed.');
      const previous = database.query('SELECT 1 FROM approvals WHERE workflow_id=? AND gate_id=? AND manifest_digest=?')
        .get(workflow.id, mutation.gateId, mutation.manifestDigest);
      if (previous) workflowConflict('This manifest already has a decision.');
      database.query('INSERT INTO approvals VALUES (?,?,?,?)').run(workflow.id, mutation.gateId, mutation.manifestDigest,
        JSON.stringify({ gateId: mutation.gateId, manifestDigest: gate.digest, manifest: gate.manifest, decision: mutation.decision, actor, at: now }));
      break;
    }
    case 'retry': {
      const attempt = requireAttempt(database, mutation.attemptId);
      const task = readTasks(database, workflow.id).find(entry => entry.id === mutation.taskId);
      if (!task || attempt.workflowId !== workflow.id || attempt.taskId !== task.id || task.generation !== mutation.generation
        || attempt.generation !== task.generation || task.hold !== 'none'
        || readAttempts(database, workflow.id).findLast(entry => entry.taskId === task.id)?.attemptId !== attempt.attemptId
        || !['failed', 'interrupted', 'not-started', 'abandoned'].includes(attempt.resolution)) workflowConflict('Attempt is not eligible for retry.');
      if (database.query(`SELECT 1 FROM resource_claims WHERE attempt_id=? AND risk_released=0`).get(attempt.attemptId)) {
        workflowConflict('Resolve retained resources before retrying.');
      }
      invalidate(database, workflow, new Set([task.id]));
      break;
    }
    case 'resolve': {
      const attempt = requireAttempt(database, mutation.attemptId);
      const task = readTasks(database, workflow.id).find(entry => entry.id === mutation.taskId);
      if (!task || attempt.workflowId !== workflow.id || attempt.taskId !== task.id || attempt.generation !== mutation.generation
        || (attempt.resolution !== 'unknown' && task.hold === 'none')) workflowConflict('Uncertain attempt changed.');
      // Runtime adoption is added by the execution service after independent observation.
      if (mutation.resolution === 'adopt') throw new DomainError('WORKFLOW_CONFLICT', 'Artifact adoption requires a current executor observation.', 409);
      database.query(`UPDATE attempts SET resolution=?,dispatch_phase='settled',control_state='released' WHERE id=?`)
        .run(mutation.resolution === 'not-started' ? 'not-started' : 'abandoned', attempt.attemptId);
      database.query(`UPDATE tasks SET hold='none',hold_reason=NULL WHERE workflow_id=? AND id=?`).run(workflow.id, task.id);
      if (mutation.resolution === 'not-started') database.query('DELETE FROM resource_claims WHERE attempt_id=?').run(attempt.attemptId);
      else database.query('UPDATE resource_claims SET quarantined=1,risk_released=? WHERE attempt_id=?').run(mutation.releaseRisk ? 1 : 0, attempt.attemptId);
      break;
    }
  }
  return workflow.id;
}

function insertPlan(database: Database, id: string, revision: number, plan: WorkflowPlan): void {
  database.query('INSERT INTO plan_revisions VALUES (?,?,?,?)').run(id, revision, workflowDigest(plan), JSON.stringify(plan));
}
function activate(database: Database, workflow: WorkflowRecord, digest: string): void {
  if (workflow.desired === 'canceled') workflowConflict('Canceled workflows cannot be activated.');
  const next = readPlan(database, workflow.id, workflow.draftPlanRevision);
  if (workflowDigest(activationManifest(next)) !== digest) workflowConflict('Activation manifest changed.');
  const previous = workflow.activePlanRevision === null ? null : readPlan(database, workflow.id, workflow.activePlanRevision);
  const affected = invalidatedWorkflowTasks(previous?.plan ?? null, next.plan);
  for (const task of next.plan.tasks) {
    database.query(`INSERT INTO tasks VALUES (?,?,1,NULL,'none',NULL,NULL) ON CONFLICT(workflow_id,id) DO NOTHING`).run(workflow.id, task.id);
  }
  if (previous) invalidate(database, workflow, affected, next.plan);
  database.query(`UPDATE workflows SET active_plan_revision=?,desired='active',admission_epoch=?,control_epoch=control_epoch+1 WHERE id=?`)
    .run(next.revision, workflowEpoch(database), workflow.id);
}
function invalidate(database: Database, workflow: WorkflowRecord, roots: ReadonlySet<string>, next?: WorkflowPlan): void {
  const current = workflow.activePlanRevision === null ? null : readPlan(database, workflow.id, workflow.activePlanRevision).plan;
  const affected = current ? workflowDescendants(current, roots) : roots;
  const all = next ? workflowDescendants(next, affected) : affected;
  for (const id of all) {
    database.query('UPDATE tasks SET generation=generation+1,input_digest=NULL,next_eligible_at=NULL WHERE workflow_id=? AND id=?').run(workflow.id, id);
    database.query(`UPDATE attempts SET control_state='revoked',revocation_reason='Generation superseded.' WHERE workflow_id=? AND task_id=? AND resolution IN ('open','unknown')`).run(workflow.id, id);
    database.query('DELETE FROM gate_manifests WHERE workflow_id=? AND gate_id=?').run(workflow.id, id);
  }
}

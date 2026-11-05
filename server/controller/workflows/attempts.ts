import type { Database } from 'bun:sqlite';
import type { AutomationTurnKey, EffectiveAutomationInput } from '../../../common/automation.js';
import { WORKFLOW_LIMITS, type WorkflowAttempt, type WorkflowAttemptResult,
  type WorkflowDispatchPhase, type WorkflowManagedTarget, type WorkflowRevocationKind } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { workflowDigest, workflowEffectiveInput, workflowInputDigest, workflowResolvedTarget, workflowStartInput } from './inputs.js';
import { appendWorkflowActivity, readDependencyArtifacts, readPlan, readTasks, readWorkflowSchedule,
  requireAttempt, requireWorkflow, workflowEpoch, workflowRevision } from './records.js';
import type { WorkflowStore } from './store.js';
import { managedTargetRequest, parseManagedTarget } from './managed-target.js';
import { workflowResultDetail } from './terminal-observation.js';
import { requireWorkflowGates } from './acceptance.js';
import { requireIntegrationOperation } from './integration-manifest.js';
import { requireResourceDispatch } from './resource-dispatch.js';
import { requirePublicationApproval, requirePublicationOperation } from './publication-manifest.js';
import type { WorkflowEffectFence } from './contracts.js';

export interface WorkflowTerminalObservation {
  readonly resolution: 'checking' | 'failed' | 'interrupted' | 'not-started' | 'unknown';
  readonly result: WorkflowAttemptResult;
  readonly admissionFailure?: boolean;
  readonly admissionHold?: string;
  readonly retainControl?: boolean;
}

export interface WorkflowAttemptFence {
  readonly revoked: boolean;
  readonly reason: string | null;
  readonly revocationKind?: WorkflowRevocationKind | null;
}

export class WorkflowAttempts {
  constructor(readonly store: WorkflowStore, private readonly options: {
    readonly now: () => string;
    readonly onInvalidated?: (workflowId: string, revision: number) => void;
  }) {}

  get(attemptId: string): WorkflowAttempt { return this.store.read(db => requireAttempt(db, attemptId)); }

  holdAdmission(workflowId: string, taskId: string, reason: string): void {
    const revision = this.store.transaction(db => {
      db.query("UPDATE tasks SET hold='output-unknown',hold_reason=? WHERE workflow_id=? AND id=? AND hold='none'")
        .run(reason.slice(0, 4096), workflowId, taskId);
      appendWorkflowActivity(db, workflowId, 'admission-held', 'engine', taskId, this.options.now());
      return workflowRevision(db);
    });
    this.#notify(workflowId, revision);
  }

  reserve(workflowId: string, taskId: string): WorkflowAttempt | null {
    const reserved = this.store.transaction(db => {
      const detail = readWorkflowSchedule(db, workflowId);
      const task = detail.tasks.find(candidate => candidate.id === taskId);
      const spec = detail.active?.plan.tasks.find(candidate => candidate.id === taskId);
      const now = this.options.now();
      if (detail.workflow.archived || !task || task.phase !== 'ready' || !spec || spec.spec.kind === 'approval'
        || task.nextEligibleAt && task.nextEligibleAt > now) return null;
      const dependencies = readDependencyArtifacts(db, workflowId, spec.dependsOn);
      const target = workflowResolvedTarget(spec, dependencies);
      const capacity = readWorkflowCapacity(db);
      if (capacity.length >= WORKFLOW_LIMITS.globalAttempts
        || capacity.filter(row => row.workflowId === workflowId).length >= Math.min(WORKFLOW_LIMITS.workflowAttempts, detail.active!.plan.policy.concurrency)
        || capacity.filter(row => row.executorId === target.executorId).length >= WORKFLOW_LIMITS.executorAttempts) return null;
      if (db.query(`SELECT 1 FROM resource_claims c JOIN attempts a ON a.id=c.attempt_id
        WHERE a.workflow_id=? AND a.task_id=? AND c.risk_released=0 AND c.retained=0 LIMIT 1`).get(workflowId, taskId)) return null;
      const inputDigest = workflowInputDigest(spec, dependencies);
      if (task.inputDigest !== null && task.inputDigest !== inputDigest) workflowConflict('Task inputs changed; activate a new generation.');
      const attemptId = crypto.randomUUID();
      db.query('UPDATE tasks SET input_digest=?,next_eligible_at=NULL WHERE workflow_id=? AND id=?')
        .run(inputDigest, workflowId, taskId);
      db.query(`INSERT INTO attempts (id,workflow_id,task_id,plan_revision,generation,input_digest,dispatch_phase,
        resolution,control_state,request_id,target_json,created_at) VALUES (?,?,?,?,?,?,'planned','open','leased',?,?,?)`)
        .run(attemptId, workflowId, taskId, detail.active!.revision, task.generation, inputDigest,
          crypto.randomUUID(), JSON.stringify(target), now);
      appendWorkflowActivity(db, workflowId, 'attempt-planned', 'engine', attemptId, now);
      return { attempt: requireAttempt(db, attemptId), revision: workflowRevision(db) };
    });
    if (reserved) this.#notify(workflowId, reserved.revision);
    return reserved?.attempt ?? null;
  }

  beginPreparation(attemptId: string): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-preparing', (db, attempt) => {
      requirePhase(attempt, 'planned');
      requireWorkflowDispatch(db, attempt);
      db.query("UPDATE attempts SET dispatch_phase='preparing' WHERE id=?").run(attemptId);
    });
  }

  bindTarget(attemptId: string, value: WorkflowManagedTarget): WorkflowAttempt {
    const resource = parseManagedTarget(value);
    const { target, resourceKey } = resource;
    return this.#update(attemptId, 'attempt-target-bound', (db, attempt) => {
      requirePhase(attempt, 'preparing');
      requireWorkflowDispatch(db, attempt);
      if (!attempt.target || target.executorId !== attempt.target.executorId
        || target.repositoryId !== attempt.target.repositoryId || target.baseCommit !== attempt.target.baseCommit
        || target.inputTaskId !== attempt.target.inputTaskId || target.worktreeRoot !== attempt.target.worktreeRoot
        || workflowDigest(target.remote) !== workflowDigest(attempt.target.remote)) {
        workflowConflict('Prepared repository does not match the approved target.');
      }
      const owner = db.query<{ attempt_id: string }, [string]>(
        'SELECT attempt_id FROM resource_claims WHERE resource_key=? AND quarantined=0 AND risk_released=0 AND retained=0').get(resourceKey);
      const operation = db.query<{ payload_json: string; result_json: string | null }, [string, string, string]>(
        "SELECT payload_json,result_json FROM operation_intents WHERE id=? AND attempt_id=? AND resource_key=? AND kind='worktree' AND status='succeeded'")
        .get(resource.operationId, attemptId, resourceKey);
      if (owner?.attempt_id !== attemptId || !operation?.result_json) {
        workflowConflict('Prepared resource has no confirmed creation intent.');
      }
      let request: unknown;
      let observed: WorkflowManagedTarget;
      try { request = JSON.parse(operation.payload_json); observed = parseManagedTarget(JSON.parse(operation.result_json)); }
      catch { return workflowConflict('Prepared resource has no valid ownership observation.'); }
      if (workflowDigest(observed) !== workflowDigest(resource)
        || workflowDigest(request) !== workflowDigest(managedTargetRequest(resource))
        || resource.head !== target.baseCommit || target.projectPath === attempt.target.projectPath) {
        workflowConflict('Prepared resource does not match its exact creation intent and ownership marker.');
      }
      db.query('UPDATE attempts SET target_json=?,managed_target_json=? WHERE id=?').run(JSON.stringify(target), JSON.stringify(resource), attemptId);
    });
  }

  bindPrepared(attemptId: string, key: AutomationTurnKey, effective: EffectiveAutomationInput): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-prepared', (db, attempt) => {
      requirePhase(attempt, 'preparing');
      requireWorkflowDispatch(db, attempt);
      const task = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
      const expected = workflowEffectiveInput(workflowStartInput(attempt, task));
      if (key.clientRequestId !== attempt.requestId || effective.executorId !== attempt.target?.executorId
        || effective.projectPath !== attempt.target.projectPath || workflowDigest(expected) !== workflowDigest(effective)) {
        workflowConflict('Prepared turn does not match the approved input.');
      }
      if (!attempt.managedTarget || !db.query(`SELECT 1 FROM resource_claims c JOIN operation_intents o ON o.resource_key=c.resource_key
        WHERE c.attempt_id=? AND c.resource_key=? AND c.quarantined=0 AND c.risk_released=0 AND c.retained=0
        AND o.id=? AND o.attempt_id=c.attempt_id AND o.status='succeeded'`)
        .get(attemptId, attempt.managedTarget.resourceKey, attempt.managedTarget.operationId)) {
        workflowConflict('Prepared turn has no owned repository resource.');
      }
      db.query(`UPDATE attempts SET dispatch_phase='prepared',server_instance_id=?,chat_id=?,turn_id=?,effective_input_json=? WHERE id=?`)
        .run(key.serverInstanceId, key.chatId, key.turnId, JSON.stringify(effective), attemptId);
    });
  }

  markDispatching(attemptId: string, fence: WorkflowAttemptFence): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-dispatching', (db, attempt) => {
      requirePhase(attempt, 'prepared');
      if (fence.revoked || !attempt.effectiveInput) workflowConflict('Attempt control or captured input is unavailable.');
      requireWorkflowDispatch(db, attempt);
      db.query("UPDATE attempts SET dispatch_phase='dispatching' WHERE id=?").run(attemptId);
    });
  }

  bindIntegrationPrepared(attemptId: string, operationId: string): WorkflowAttempt {
    return this.#update(attemptId, 'integration-prepared', (db, attempt) => {
      requirePhase(attempt, 'preparing');
      requireWorkflowDispatch(db, attempt);
      const { operation } = requireIntegrationOperation(db, attempt, operationId);
      if (operation.status !== 'planned') workflowConflict('Integration was already dispatched.');
      db.query("UPDATE attempts SET dispatch_phase='prepared' WHERE id=?").run(attemptId);
    });
  }

  markIntegrationDispatching(attemptId: string, operationId: string, fence: WorkflowEffectFence): WorkflowAttempt {
    return this.#update(attemptId, 'integration-dispatching', (db, attempt) => {
      requirePhase(attempt, 'prepared');
      requireWorkflowDispatch(db, attempt);
      const { operation } = requireIntegrationOperation(db, attempt, operationId);
      requireResourceDispatch(db, operation, fence);
      db.query("UPDATE attempts SET dispatch_phase='dispatching' WHERE id=?").run(attemptId);
      db.query("UPDATE operation_intents SET status='dispatching' WHERE id=?").run(operationId);
    });
  }

  markPublicationDispatching(attemptId: string, pushId: string, createId: string, fence: WorkflowEffectFence): WorkflowAttempt {
    return this.#update(attemptId, 'publication-dispatching', (db, attempt) => {
      requirePhase(attempt, 'preparing');
      requireWorkflowDispatch(db, attempt);
      const push = requirePublicationOperation(db, attempt, pushId, 'push');
      const create = requirePublicationOperation(db, attempt, createId, 'create');
      if (create.status !== 'planned') workflowConflict('Publication was already dispatched.');
      requireResourceDispatch(db, push, fence);
      db.query("UPDATE attempts SET dispatch_phase='dispatching' WHERE id=?").run(attemptId);
      db.query("UPDATE operation_intents SET status='dispatching' WHERE id=?").run(pushId);
    });
  }

  observe(attemptId: string, observation: WorkflowTerminalObservation, fence: WorkflowAttemptFence): WorkflowAttempt {
    if (Buffer.byteLength(JSON.stringify(observation.result)) > WORKFLOW_LIMITS.resultBytes) workflowConflict('Attempt result exceeds its bound.');
    if (observation.result.outputCaptured || observation.resolution === 'checking'
        && (observation.result.certainty !== 'definite' || observation.result.termination !== 'observed')
      || observation.resolution === 'not-started'
        && (observation.result.certainty !== 'not-started' || observation.result.termination !== 'not-started')
      || observation.resolution === 'failed' && observation.result.certainty !== 'definite') {
      workflowConflict('Terminal evidence does not support this resolution.');
    }
    return this.#update(attemptId, 'attempt-observed', (db, attempt) => {
      if (attempt.resolution !== 'open' || attempt.result) return false;
      if (observation.resolution !== 'not-started' && observation.resolution !== 'unknown'
        && attempt.dispatchPhase !== 'dispatching' && attempt.dispatchPhase !== 'observed-running') {
        workflowConflict('No dispatch was recorded for this terminal.');
      }
      const current = currentGeneration(db, attempt);
      const revoked = fence.revoked || attempt.controlState === 'revoked' || !current;
      const revocationKind = attempt.revocationKind === 'intervention' ? 'intervention' : fence.revoked ? fence.revocationKind ?? 'intervention'
        : attempt.revocationKind ?? (current ? null : 'superseded');
      const resolution = observation.resolution === 'checking' ? revoked ? 'unknown' : 'open' : observation.resolution;
      const workflow = requireWorkflow(db, attempt.workflowId);
      const admissionFailure = resolution === 'not-started' && !observation.admissionHold && observation.admissionFailure !== false && !revoked
        && workflow.desired === 'active' && workflow.admissionEpoch === workflowEpoch(db);
      // A terminal can precede start settlement; revocation does not release that admission owner.
      db.query(`UPDATE attempts SET result_json=?,resolution=?,dispatch_phase=?,control_state=?,revocation_reason=?,revocation_kind=?,admission_failure=? WHERE id=?`)
        .run(JSON.stringify(observation.result), resolution, resolution === 'open' || observation.retainControl ? attempt.dispatchPhase : 'settled',
          revoked ? 'revoked' : resolution === 'open' || observation.retainControl ? 'leased' : 'released',
          revoked ? fence.reason ?? attempt.revocationReason ?? 'Task generation changed.' : null,
          revoked ? revocationKind : null, admissionFailure ? 1 : 0, attemptId);
      if (revocationKind === 'intervention' || observation.resolution === 'interrupted' && revocationKind !== 'superseded') {
        holdTask(db, attempt, 'intervention', fence.reason ?? 'Attempt control was interrupted.');
      } else if (resolution === 'unknown' || observation.result.termination === 'unknown') {
        holdTask(db, attempt, 'output-unknown', observation.result.detail);
      } else if (current && resolution === 'not-started' && observation.admissionHold) {
        holdTask(db, attempt, 'output-unknown', observation.admissionHold);
      }
      if (resolution !== 'open') {
        if (observation.result.termination !== 'unknown' && resolution !== 'unknown') {
          if (!observation.retainControl) releaseSettledClaims(db, attemptId);
        }
        else db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(attemptId);
      }
      if (current && !revoked && (resolution === 'failed' || resolution === 'not-started')) {
        const spec = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
        const deadline = new Date(Date.parse(this.options.now()) + Math.max(1000, spec.retry.backoffMs)).toISOString();
        db.query('UPDATE tasks SET next_eligible_at=? WHERE workflow_id=? AND id=?').run(deadline, attempt.workflowId, attempt.taskId);
      }
    });
  }

  revoke(attemptId: string, reason: string, kind: WorkflowRevocationKind = 'intervention'): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-revoked', (db, attempt) => {
      if (!['open', 'unknown'].includes(attempt.resolution) && attempt.controlState !== 'leased' && attempt.dispatchPhase === 'settled') return false;
      if (attempt.controlState === 'revoked' && (attempt.revocationKind === 'intervention' || kind === 'superseded')) return false;
      db.query("UPDATE attempts SET control_state='revoked',revocation_reason=?,revocation_kind=? WHERE id=?").run(reason, kind, attemptId);
      if (kind === 'intervention') holdTask(db, attempt, 'intervention', reason);
    });
  }

  releaseControl(attemptId: string, fence: WorkflowAttemptFence): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-control-released', (db, attempt) => {
      if (!['open', 'unknown'].includes(attempt.resolution) && attempt.controlState !== 'leased' && attempt.dispatchPhase === 'settled') return false;
      if (fence.revoked) {
        const kind = attempt.revocationKind === 'intervention' ? 'intervention' : fence.revocationKind ?? 'intervention';
        db.query("UPDATE attempts SET control_state='revoked',revocation_reason=?,revocation_kind=? WHERE id=?")
          .run(fence.reason, kind, attemptId);
        if (kind === 'intervention') holdTask(db, attempt, 'intervention', fence.reason ?? 'Attempt control was interrupted.');
      } else if (attempt.controlState === 'leased' && attempt.resolution !== 'open') {
        db.query("UPDATE attempts SET control_state='released' WHERE id=?").run(attemptId);
      } else if (attempt.dispatchPhase === 'settled' || attempt.resolution === 'open') return false;
      if (attempt.resolution !== 'open') db.query("UPDATE attempts SET dispatch_phase='settled' WHERE id=?").run(attemptId);
      if (attempt.result && attempt.result.termination !== 'unknown' && !['open', 'unknown'].includes(attempt.resolution)) releaseSettledClaims(db, attemptId);
    });
  }

  holdOutput(attemptId: string, reason: string, fence: WorkflowAttemptFence, outputGapped = false): WorkflowAttempt {
    return this.#update(attemptId, 'attempt-output-unavailable', (db, attempt) => {
      if (attempt.resolution !== 'open' || !attempt.result) return false;
      const revoked = fence.revoked || attempt.controlState === 'revoked' || !currentGeneration(db, attempt);
      const kind = attempt.revocationKind === 'intervention' ? 'intervention' : fence.revoked ? fence.revocationKind ?? 'intervention' : attempt.revocationKind;
      db.query(`UPDATE attempts SET resolution='unknown',dispatch_phase='settled',control_state=?,
        revocation_reason=?,revocation_kind=?,result_json=? WHERE id=?`).run(revoked ? 'revoked' : 'released',
          revoked ? fence.reason ?? attempt.revocationReason ?? reason : null,
          revoked ? kind ?? 'superseded' : null,
          JSON.stringify({ ...attempt.result, detail: workflowResultDetail(reason),
            receivedOutputCoverage: outputGapped ? 'gapped' : attempt.result.receivedOutputCoverage }), attemptId);
      holdTask(db, attempt, kind === 'intervention' ? 'intervention' : 'output-unknown', reason);
      db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(attemptId);
    });
  }

  #update(attemptId: string, action: string, update: (db: Database, attempt: WorkflowAttempt) => void | false): WorkflowAttempt {
    const result = this.store.transaction(db => {
      const attempt = requireAttempt(db, attemptId);
      if (update(db, attempt) === false) return { attempt, revision: null };
      appendWorkflowActivity(db, attempt.workflowId, action, 'engine', attemptId, this.options.now());
      return { attempt: requireAttempt(db, attemptId), revision: workflowRevision(db) };
    });
    if (result.revision !== null) this.#notify(result.attempt.workflowId, result.revision);
    return result.attempt;
  }

  #notify(workflowId: string, revision: number): void {
    try { this.options.onInvalidated?.(workflowId, revision); }
    catch (error) { console.error('Workflow invalidation delivery failed', error); }
  }
}

export function readWorkflowCapacity(db: Database): { workflowId: string; executorId: string | null }[] {
  return db.query<{ workflowId: string; executorId: string | null }, []>(`SELECT a.workflow_id AS workflowId,
    json_extract(a.target_json,'$.executorId') AS executorId FROM attempts a WHERE a.id IN
    (SELECT id FROM attempts WHERE resolution IN ('open','unknown') OR control_state='leased' OR dispatch_phase!='settled'
      UNION SELECT attempt_id FROM resource_claims WHERE risk_released=0 AND retained=0)
    LIMIT ${WORKFLOW_LIMITS.globalAttempts}`).all();
}

export function currentGeneration(db: Database, attempt: WorkflowAttempt): boolean {
  return readTasks(db, attempt.workflowId).some(task => task.id === attempt.taskId
    && task.generation === attempt.generation && task.inputDigest === attempt.inputDigest);
}

export function requireWorkflowDispatch(db: Database, attempt: WorkflowAttempt): void {
  const workflow = requireWorkflow(db, attempt.workflowId);
  if (workflow.archived || workflow.desired !== 'active' || workflow.admissionEpoch !== workflowEpoch(db)) {
    workflowConflict('Workflow admission changed.');
  }
  requireWorkflowInputs(db, attempt);
}

export function requireWorkflowInputs(db: Database, attempt: WorkflowAttempt): void {
  const tasks = readTasks(db, attempt.workflowId);
  const task = tasks.find(task => task.id === attempt.taskId);
  if (attempt.resolution !== 'open' || attempt.controlState !== 'leased' || !currentGeneration(db, attempt)
    || task?.hold !== 'none') {
    workflowConflict('Workflow admission or attempt generation changed.');
  }
  requireCurrentAttemptInputs(db, attempt);
}

export function requireCurrentAttemptInputs(db: Database, attempt: WorkflowAttempt): void {
  if (!currentGeneration(db, attempt)) workflowConflict('Attempt generation changed.');
  const spec = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(task => task.id === attempt.taskId)!;
  for (const id of spec.dependsOn) {
    if (!db.query(`SELECT 1 FROM tasks t JOIN attempts a ON a.workflow_id=t.workflow_id AND a.task_id=t.id
      WHERE t.workflow_id=? AND t.id=? AND t.hold='none' AND a.generation=t.generation
      AND a.input_digest=t.input_digest AND a.resolution='succeeded' AND a.control_state='released'
      AND a.dispatch_phase='settled'`).get(attempt.workflowId, id)) {
      workflowConflict('Dependency evidence is no longer current.');
    }
  }
  const dependencies = readDependencyArtifacts(db, attempt.workflowId, spec.dependsOn);
  if (attempt.inputDigest !== workflowInputDigest(spec, dependencies)
    || 'target' in spec.spec && attempt.target?.baseCommit !== workflowResolvedTarget(spec, dependencies).baseCommit) {
    workflowConflict('Dependency artifacts changed after reservation.');
  }
  if (attempt.target) requireWorkflowGates(db, attempt, spec, attempt.target.baseCommit);
  if (spec.spec.kind === 'publish-pr') requirePublicationApproval(db, attempt);
}

export function holdTask(db: Database, attempt: WorkflowAttempt, hold: 'intervention' | 'output-unknown', reason: string): void {
  db.query(`UPDATE tasks SET hold=?,hold_reason=? WHERE workflow_id=? AND id=? AND hold!='intervention'`)
    .run(hold, reason.slice(0, 4096), attempt.workflowId, attempt.taskId);
}

export function releaseSettledClaims(db: Database, attemptId: string): void {
  // Separate uncertain Git/publication operations retain their resource claims.
  if (!db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('dispatching','unknown','abandoned')").get(attemptId)) {
    db.query(`DELETE FROM resource_claims WHERE attempt_id=? AND NOT EXISTS
      (SELECT 1 FROM operation_intents o WHERE o.attempt_id=resource_claims.attempt_id AND o.resource_key=resource_claims.resource_key AND o.status='succeeded')`).run(attemptId);
    db.query('UPDATE resource_claims SET retained=1,quarantined=0 WHERE attempt_id=? AND risk_released=0').run(attemptId);
  } else {
    db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(attemptId);
    holdTask(db, requireAttempt(db, attemptId), 'output-unknown', 'Repository operations remain uncertain. Resolve retained resources before continuing.');
  }
}

function requirePhase(attempt: WorkflowAttempt, phase: WorkflowDispatchPhase): void {
  if (attempt.resolution !== 'open' || attempt.dispatchPhase !== phase) workflowConflict('Attempt dispatch phase changed.');
}

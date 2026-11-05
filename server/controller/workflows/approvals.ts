import type { Database } from 'bun:sqlite';
import type { WorkflowApprovalManifest, WorkflowAttemptResult } from '../../../common/workflows.js';
import { workflowConflict } from './errors.js';
import { workflowDigest, workflowInputDigest } from './inputs.js';
import { appendWorkflowActivity, readGateManifests, readWorkflowSchedule, workflowRevision } from './records.js';
import type { WorkflowStore } from './store.js';
import { matchesPublicationSpec, publicationGateSource, workflowPublicationMarker } from './publication-manifest.js';
import type { WorkflowPublicationPort } from './publication-contracts.js';
import { workflowGateInputs, workflowGateInputsFromSchedule } from './gate-inputs.js';

export class WorkflowApprovals {
  constructor(private readonly store: WorkflowStore, private readonly options: {
    readonly now: () => string;
    readonly onInvalidated: (workflowId: string, revision: number) => void;
  }) {}

  holdPublication(workflowId: string): void {
    const revision = this.store.transaction(db => {
      const schedule = readWorkflowSchedule(db, workflowId);
      const gates = schedule.tasks.filter(task => task.phase === 'awaiting-approval' && schedule.active?.plan.tasks.some(
        definition => definition.id === task.id && definition.spec.kind === 'approval' && definition.spec.purpose === 'publication'));
      if (!gates.length) return null;
      for (const gate of gates) db.query("UPDATE tasks SET hold='output-unknown',hold_reason=? WHERE workflow_id=? AND id=?")
        .run('Publication approval could not verify its executor, repository, account or base. Restore the target and clear this hold to recheck.', workflowId, gate.id);
      appendWorkflowActivity(db, workflowId, 'publication-approval-unavailable', 'engine', gates.map(gate => gate.id).join(', '), this.options.now());
      return workflowRevision(db);
    });
    if (revision !== null) this.options.onInvalidated(workflowId, revision);
  }

  prepare(workflowId: string): void {
    const revision = this.store.transaction(db => {
      const schedule = readWorkflowSchedule(db, workflowId);
      const prepared = new Set(readGateManifests(db, workflowId).map(gate => gate.digest));
      let changed = false;
      for (const task of schedule.tasks) {
        if (task.phase !== 'awaiting-approval') continue;
        const inputs = workflowGateInputsFromSchedule(db, schedule, task.id);
        if (inputs.definition.spec.kind !== 'approval' || inputs.definition.spec.purpose !== 'manual') continue;
        const digest = workflowDigest(inputs.manifest);
        if (prepared.has(digest)) continue;
        db.query(`INSERT INTO gate_manifests VALUES (?,?,?,?) ON CONFLICT(workflow_id,gate_id)
          DO UPDATE SET manifest_digest=excluded.manifest_digest,payload_json=excluded.payload_json`)
          .run(workflowId, task.id, digest, JSON.stringify(inputs.manifest));
        appendWorkflowActivity(db, workflowId, 'approval-ready', 'engine', task.id, this.options.now());
        changed = true;
      }
      return changed ? workflowRevision(db) : null;
    });
    if (revision !== null) this.options.onInvalidated(workflowId, revision);
  }

  async preparePublication(workflowId: string, port: WorkflowPublicationPort, signal: AbortSignal): Promise<void> {
    const schedule = this.store.read(db => readWorkflowSchedule(db, workflowId));
    const publicationIds = new Set(schedule.active?.plan.tasks.filter(task => task.spec.kind === 'approval'
      && task.spec.purpose === 'publication').map(task => task.id));
    const gates = schedule.tasks.filter(task => task.phase === 'awaiting-approval' && publicationIds.has(task.id));
    for (const gate of gates) {
      const captured = this.store.read(db => {
        const inputs = workflowGateInputs(db, workflowId, gate.id);
        if (inputs.definition.spec.kind !== 'approval' || inputs.definition.spec.purpose !== 'publication') return null;
        const source = publicationGateSource(db, workflowId, gate.id);
        const previous = readGateManifests(db, workflowId).find(value => value.manifest.gateId === gate.id);
        return { ...source, previous };
      });
      if (!captured) continue;
      const observed = await port.inspectTarget(captured.spec, signal);
      signal.throwIfAborted();
      if (observed.executorId !== captured.spec.target.executorId) workflowConflict('Publication executor changed.');
      const operationId = captured.previous && matchesPublicationSpec(captured.previous.manifest, captured.spec, captured.source.commit!)
        ? captured.previous.manifest.publication!.operationId : crypto.randomUUID();
      const manifest: WorkflowApprovalManifest = { ...captured.manifest, publication: {
        executorId: observed.executorId, runtimeInstanceId: observed.instanceId, repositoryId: captured.spec.target.repositoryId,
        projectPath: captured.spec.target.projectPath, remoteUrl: captured.spec.target.remote!.url,
        repository: observed.repository, actor: observed.actor, baseCommit: observed.baseCommit,
        baseBranch: captured.spec.baseBranch, headBranch: captured.spec.headBranch, headCommit: captured.source.commit!,
        title: captured.spec.title, body: `${captured.spec.body}\n\n${workflowPublicationMarker(operationId)}`,
        draft: captured.spec.draft, operationId,
      } };
      const digest = workflowDigest(manifest);
      const { previous: _previous, ...snapshot } = captured;
      const revision = this.store.transaction(db => {
        const current = publicationGateSource(db, workflowId, gate.id);
        if (workflowDigest(current) !== workflowDigest(snapshot)) return null;
        if (readGateManifests(db, workflowId).some(value => value.digest === digest)) return null;
        db.query(`INSERT INTO gate_manifests VALUES (?,?,?,?) ON CONFLICT(workflow_id,gate_id)
          DO UPDATE SET manifest_digest=excluded.manifest_digest,payload_json=excluded.payload_json`)
          .run(workflowId, gate.id, digest, JSON.stringify(manifest));
        appendWorkflowActivity(db, workflowId, 'approval-ready', 'engine', gate.id, this.options.now());
        return workflowRevision(db);
      });
      if (revision !== null) this.options.onInvalidated(workflowId, revision);
    }
  }
}

export function settleWorkflowApproval(db: Database, workflowId: string, manifest: WorkflowApprovalManifest,
  decision: 'approve' | 'reject', now: string): void {
  const inputs = workflowGateInputs(db, workflowId, manifest.gateId);
  if (workflowDigest({ ...manifest, publication: null }) !== workflowDigest(inputs.manifest)) workflowConflict('Approval inputs changed.');
  if (db.query(`SELECT 1 FROM attempts WHERE workflow_id=? AND task_id=? AND generation=?`)
    .get(workflowId, inputs.task.id, inputs.task.generation)) workflowConflict('This gate already has a decision.');
  const inputDigest = workflowInputDigest(inputs.definition, inputs.dependencies);
  const result: WorkflowAttemptResult = { certainty: 'definite', termination: 'observed', executionScope: null,
    detail: decision === 'approve' ? 'Exact manifest approved by the operator.' : 'Exact manifest rejected by the operator.',
    commandOutcome: null, receivedOutputCoverage: 'unknown', outputCaptured: true };
  db.query('UPDATE tasks SET input_digest=? WHERE workflow_id=? AND id=?').run(inputDigest, workflowId, inputs.task.id);
  db.query(`INSERT INTO attempts (id,workflow_id,task_id,plan_revision,generation,input_digest,dispatch_phase,
    resolution,control_state,request_id,target_json,result_json,created_at) VALUES (?,?,?,?,?,?,'settled',?,'released',?,'null',?,?)`)
    .run(crypto.randomUUID(), workflowId, inputs.task.id, inputs.plan.revision, inputs.task.generation, inputDigest,
      decision === 'approve' ? 'succeeded' : 'failed', crypto.randomUUID(), JSON.stringify(result), now);
}

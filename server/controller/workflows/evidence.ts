import type { Database } from 'bun:sqlite';
import type { AutomationResult } from '../../../common/automation.js';
import { WORKFLOW_LIMITS, type WorkflowArtifact, type WorkflowAttempt, type WorkflowPlanTask } from '../../../common/workflows.js';
import { parseWorkflowReview } from './agent-output.js';
import { releaseSettledClaims, requireWorkflowInputs } from './attempts.js';
import type { WorkflowEvidenceRepositoryPort, WorkflowOutputFence, WorkflowOutputPort, WorkflowRepositoryObservation } from './contracts.js';
import { workflowConflict } from './errors.js';
import { workflowDigest } from './inputs.js';
import { appendWorkflowActivity, readPlan,
  requireAttempt, requireWorkflow, workflowRevision } from './records.js';
import type { WorkflowStore } from './store.js';

type EvidenceOutcome = WorkflowArtifact['outcome'];
interface OutputEvidence {
  readonly kind: WorkflowArtifact['kind'];
  readonly provenance: WorkflowArtifact['provenance'];
  readonly outcome: EvidenceOutcome;
  readonly summary: string;
}

export class WorkflowEvidence implements WorkflowOutputPort {
  constructor(private readonly store: WorkflowStore, private readonly repositories: WorkflowEvidenceRepositoryPort,
    private readonly options: { readonly now: () => string; readonly onInvalidated?: (workflowId: string, revision: number) => void }) {}

  async capture(initial: WorkflowAttempt, task: WorkflowPlanTask, terminal: AutomationResult,
    fence: WorkflowOutputFence, signal: AbortSignal): Promise<{ commit(): void }> {
    const attempt = this.store.read(db => requireEvidenceAttempt(db, initial, task, fence, signal));
    if (!attempt.managedTarget) return workflowConflict('Evidence requires a confirmed managed input.');
    const observation = structuredClone(await this.repositories.inspect(attempt.managedTarget, signal));
    signal.throwIfAborted();
    const observedAt = this.options.now();
    return { commit: () => {
      const revision = this.store.transaction(db => {
        const current = requireEvidenceAttempt(db, attempt, task, fence, signal);
        const coverage = fence.outputGapped ? 'gapped' : current.result!.receivedOutputCoverage;
        const outputs = evaluateOutput(current, task, terminal, observation, coverage);
        const outcome: EvidenceOutcome = outputs.some(output => output.outcome === 'unknown') ? 'unknown'
          : outputs.some(output => output.outcome === 'fail') ? 'fail' : 'pass';
        if (outcome === 'pass') {
          for (const requirement of task.acceptance) {
            if (requirement.kind === 'artifact' && !outputs.some(output => output.kind === requirement.output)) {
              workflowConflict('Required output was not observed.');
            }
          }
        }
        for (const output of outputs) {
          const content = {
            id: crypto.randomUUID(), attempt: { workflowId: current.workflowId, taskId: current.taskId,
              generation: current.generation, attemptId: current.attemptId, inputDigest: current.inputDigest },
            ...output, executorId: observation.executorId, repositoryId: current.target!.repositoryId,
            commit: output.kind === 'summary' ? null : observation.managed.head, dirty: observation.managed.dirty, url: null,
            commandOutcome: current.result!.commandOutcome, receivedOutputCoverage: coverage, observedAt,
            git: { scope: 'managed-worktree-endpoints' as const, executionScope: current.result!.executionScope,
              effectiveInputDigest: current.effectiveInput!.digest,
              runtimeInstanceId: observation.instanceId, repositoryIdentity: observation.managed.repositoryIdentity,
              worktreeIdentity: observation.managed.worktreeIdentity, projectPath: observation.managed.worktreePath,
              inputCommit: current.managedTarget!.head, inputTree: current.managedTarget!.baseTree,
              outputTree: observation.commit.tree, containsInput: observation.commit.containsAncestor },
          };
          const artifact: WorkflowArtifact = { ...content, digest: workflowDigest(content) };
          const payload = JSON.stringify(artifact);
          if (Buffer.byteLength(payload) > WORKFLOW_LIMITS.evidenceBytes) workflowConflict('Output evidence exceeds its bound.');
          db.query('INSERT INTO artifacts VALUES (?,?,?)').run(artifact.id, current.attemptId, payload);
        }
        const resolution = outcome === 'pass' ? 'succeeded' : outcome === 'fail' ? 'failed' : 'unknown';
        db.query(`UPDATE attempts SET resolution=?,dispatch_phase='settled',control_state='released',result_json=? WHERE id=?`)
          .run(resolution, JSON.stringify({ ...current.result, outputCaptured: true, receivedOutputCoverage: coverage }), current.attemptId);
        if (outcome === 'unknown') {
          db.query("UPDATE tasks SET hold='output-unknown',hold_reason=? WHERE workflow_id=? AND id=?")
            .run('Output could not be accepted against the prepared input.', current.workflowId, current.taskId);
          db.query('UPDATE resource_claims SET quarantined=1 WHERE attempt_id=?').run(current.attemptId);
        } else {
          releaseSettledClaims(db, current.attemptId);
          if (outcome === 'fail') db.query('UPDATE tasks SET next_eligible_at=? WHERE workflow_id=? AND id=?')
            .run(new Date(Date.parse(this.options.now()) + task.retry.backoffMs).toISOString(), current.workflowId, current.taskId);
        }
        appendWorkflowActivity(db, current.workflowId, 'evidence-observed', 'engine', current.attemptId, this.options.now());
        return workflowRevision(db);
      });
      try { this.options.onInvalidated?.(attempt.workflowId, revision); }
      catch (error) { console.error('Workflow evidence notification failed', error); }
    } };
  }
}

function requireEvidenceAttempt(db: Database, captured: WorkflowAttempt, task: WorkflowPlanTask,
  fence: WorkflowOutputFence, signal: AbortSignal): WorkflowAttempt {
  if (signal.aborted || fence.shutdown.aborted) return workflowConflict('Output observation was canceled.');
  if (fence.revoked) return workflowConflict('Output attribution was revoked.');
  const attempt = requireAttempt(db, captured.attemptId);
  const workflow = requireWorkflow(db, attempt.workflowId);
  if (attempt.resolution !== 'open' || attempt.controlState !== 'leased'
    || !['dispatching', 'observed-running'].includes(attempt.dispatchPhase)
    || attempt.result?.certainty !== 'definite' || attempt.result.termination !== 'observed' || attempt.result.outputCaptured
    || workflow.archived || workflow.desired === 'canceled'
    || workflowDigest(attempt) !== workflowDigest(captured)) {
    return workflowConflict('Evidence no longer owns this observed attempt.');
  }
  requireWorkflowInputs(db, attempt);
  const approved = readPlan(db, attempt.workflowId, attempt.planRevision).plan.tasks.find(value => value.id === attempt.taskId);
  if (workflowDigest(approved) !== workflowDigest(task)) return workflowConflict('Evidence task differs from its approved definition.');
  if (!attempt.managedTarget || !db.query(`SELECT 1 FROM resource_claims WHERE resource_key=? AND attempt_id=?
    AND quarantined=0 AND risk_released=0 AND retained=0`).get(attempt.managedTarget.resourceKey, attempt.attemptId)
    || db.query("SELECT 1 FROM operation_intents WHERE attempt_id=? AND status IN ('planned','dispatching','unknown','abandoned') LIMIT 1")
      .get(attempt.attemptId)) return workflowConflict('Evidence has no exclusively owned, settled repository input.');
  return attempt;
}

function evaluateOutput(attempt: WorkflowAttempt, task: WorkflowPlanTask, terminal: AutomationResult,
  observed: WorkflowRepositoryObservation, coverage: WorkflowArtifact['receivedOutputCoverage']): OutputEvidence[] {
  const input = attempt.managedTarget!;
  const after = observed.managed;
  const sameResource = observed.executorId === input.target.executorId && observed.instanceId === input.instanceId
    && attempt.result!.executionScope?.executorId === input.target.executorId && attempt.result!.executionScope.instanceId === input.instanceId
    && after.operationId === input.operationId && after.managedResourceId === input.managedResourceId
    && after.repositoryIdentity === input.repositoryIdentity && after.worktreeIdentity === input.worktreeIdentity
    && after.worktreePath === input.target.projectPath && after.branch === input.branch && after.baseCommit === input.head
    && observed.commit.commit === after.head;
  if (task.spec.kind !== 'agent' && task.spec.kind !== 'command') return workflowConflict('This output requires a different evidence observer.');
  const kinds = task.spec.kind === 'command' ? ['command' as const] : task.spec.outputs;
  if (!kinds.length) return workflowConflict('The task declares no output evidence.');
  if (!sameResource || after.dirty || observed.commit.containsAncestor !== true) return kinds.map(kind => ({
    kind, provenance: kind === 'review' || kind === 'summary' ? 'agent-asserted' : 'runtime-observed',
    outcome: 'unknown', summary: 'Managed output identity, cleanliness or lineage differs from its prepared input.',
  }));
  const unchanged = after.head === input.head && observed.commit.tree === input.baseTree;
  if (task.spec.kind === 'command') {
    const command = attempt.result!.commandOutcome;
    const complete = coverage === 'complete' && command?.capture === 'complete';
    const failed = command && (command.outcome === 'finished' || command.outcome === 'failed')
      && (command.exitCode !== null && command.exitCode !== task.spec.expectedExitCode || command.signal !== null);
    const known = unchanged && command && (command.outcome === 'finished' || command.outcome === 'failed')
      && command.exitCode !== null && command.signal === null
      && command.cwd.kind === 'reported' && command.cwd.path === input.target.projectPath
      && (task.spec.outputRequirement === 'exit-status-only' || complete);
    return [{ kind: 'command', provenance: 'runtime-observed', outcome: unchanged && failed ? 'fail' : !known ? 'unknown' : 'pass',
    summary: !known && !failed ? 'Command input, termination, working directory or required output coverage could not be confirmed.'
      : command.signal ? `Observed signal ${command.signal}; expected exit ${task.spec.expectedExitCode}.`
        : `Observed exit ${command.exitCode}; expected ${task.spec.expectedExitCode}.` }];
  }
  const exactReceipt = terminal.kind === 'completed' && terminal.receipt.chatId === attempt.chatId
    && terminal.receipt.turnId === attempt.turnId && terminal.receipt.clientRequestId === attempt.requestId;
  if (!exactReceipt || coverage !== 'complete') return kinds.map(kind => ({ kind,
    provenance: kind === 'review' || kind === 'summary' ? 'agent-asserted' : 'runtime-observed',
    outcome: 'unknown', summary: 'The exact completed turn or its output coverage is unavailable.' }));
  const text = terminal.receipt.output.availability === 'available' && terminal.receipt.output.completeness === 'complete'
    && Buffer.byteLength(terminal.receipt.output.text) <= 16 * 1024 ? terminal.receipt.output.text.trim() : null;
  const review = task.spec.outputs.includes('review') && text ? parseWorkflowReview(text) : null;
  return task.spec.outputs.map(kind => {
    if (kind === 'commit') return { kind, provenance: 'runtime-observed', outcome: after.head === input.head ? 'fail' : 'pass',
      summary: after.head === input.head ? 'No output commit was produced.' : 'Clean commit observed in the managed worktree.' };
    if (kind === 'summary') return { kind, provenance: 'agent-asserted', outcome: text ? 'pass' : 'unknown',
      summary: review?.summary ?? text ?? 'A bounded complete final response is unavailable.' };
    return { kind, provenance: 'agent-asserted', outcome: !unchanged || !review || review.commit !== input.head ? 'unknown'
      : review.decision === 'accept' ? 'pass' : 'fail', summary: review?.summary ?? 'An exact structured review is unavailable.' };
  });
}


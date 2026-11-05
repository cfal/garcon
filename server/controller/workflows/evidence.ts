import type { AutomationResult } from '../../../common/automation.js';
import type { WorkflowArtifact, WorkflowAttempt, WorkflowPlanTask } from '../../../common/workflows.js';
import { parseWorkflowReview } from './agent-output.js';
import type { WorkflowEvidenceRepositoryPort, WorkflowOutputFence, WorkflowOutputPort, WorkflowRepositoryObservation } from './contracts.js';
import { workflowConflict } from './errors.js';
import type { WorkflowStore } from './store.js';
import { WorkflowEvidenceSettlement, type WorkflowOutputEvidence } from './evidence-settlement.js';
import { matchesManagedTarget } from './managed-target.js';

export class WorkflowEvidence implements WorkflowOutputPort {
  readonly #settlement: WorkflowEvidenceSettlement;
  constructor(store: WorkflowStore, private readonly repositories: WorkflowEvidenceRepositoryPort,
    private readonly options: { readonly now: () => string; readonly onInvalidated?: (workflowId: string, revision: number) => void }) {
    this.#settlement = new WorkflowEvidenceSettlement(store, options);
  }

  async capture(initial: WorkflowAttempt, task: WorkflowPlanTask, terminal: AutomationResult,
    fence: WorkflowOutputFence, signal: AbortSignal): Promise<{ commit(): void }> {
    const attempt = this.#settlement.requireAttempt(initial, task, fence, signal);
    if (!attempt.managedTarget) return workflowConflict('Evidence requires a confirmed managed input.');
    const observation = structuredClone(await this.repositories.inspect(attempt.managedTarget, signal));
    signal.throwIfAborted();
    const observedAt = this.options.now();
    return { commit: () => {
      this.#settlement.commit(attempt, task, fence, signal, (_db, current) => {
        const coverage = fence.outputGapped ? 'gapped' : current.result!.receivedOutputCoverage;
        const outputs = evaluateOutput(current, task, terminal, observation, coverage);
        return outputs.map(output => ({
          ...output, executorId: observation.executorId, repositoryId: current.target!.repositoryId,
          commit: output.kind === 'summary' ? null : observation.managed.head, dirty: observation.managed.dirty, url: null,
          commandOutcome: current.result!.commandOutcome, receivedOutputCoverage: coverage, observedAt,
          git: { scope: 'managed-worktree-endpoints' as const, executionScope: current.result!.executionScope,
            effectiveInputDigest: current.effectiveInput!.digest,
            runtimeInstanceId: observation.instanceId, repositoryIdentity: observation.managed.repositoryIdentity,
            worktreeIdentity: observation.managed.worktreeIdentity, projectPath: observation.managed.worktreePath,
            inputCommit: current.managedTarget!.head, inputTree: current.managedTarget!.baseTree,
            outputTree: observation.commit.tree, containsInput: observation.commit.containsAncestor },
        }));
      });
    } };
  }
}

function evaluateOutput(attempt: WorkflowAttempt, task: WorkflowPlanTask, terminal: AutomationResult,
  observed: WorkflowRepositoryObservation, coverage: WorkflowArtifact['receivedOutputCoverage']): WorkflowOutputEvidence[] {
  const input = attempt.managedTarget!;
  const after = observed.managed;
  const sameResource = observed.executorId === input.target.executorId && observed.instanceId === input.instanceId
    && attempt.result!.executionScope?.executorId === input.target.executorId && attempt.result!.executionScope.instanceId === input.instanceId
    && matchesManagedTarget(input, after)
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


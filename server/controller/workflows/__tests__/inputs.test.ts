import { expect, test } from 'bun:test';
import type { WorkflowPlanTask } from '../../../../common/workflows.js';
import { parseWorkflowPlan } from '../../../../common/workflow-validation.js';
import { validateWorkflowGraph } from '../graph.js';
import { workflowInputDigest, workflowResolvedTarget, type WorkflowDependencyArtifact } from '../inputs.js';
import { workflowAgentPrompt } from '../agent-output.js';
import { plan } from './fixture.js';

function tasks() {
  const command = plan().tasks[0]!;
  if (command.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const source: WorkflowPlanTask = { ...command, id: 'source', spec: { kind: 'agent', target: command.spec.target,
    prompt: 'Synthetic implementation.', outputs: ['commit'], selection: { agentId: 'codex', model: 'synthetic',
      apiProviderId: null, modelEndpointId: null, modelProtocol: null, providerRevision: null, permissionMode: 'default',
      thinkingMode: 'none', preambles: [], agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} } } } };
  const target = { ...command, dependsOn: ['source'], spec: { ...command.spec, target: { ...command.spec.target, inputTaskId: 'source' } } };
  const artifact: WorkflowDependencyArtifact = { id: 'synthetic-artifact', digest: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40),
    kind: 'commit', outcome: 'pass', provenance: 'runtime-observed', executorId: 'local', repositoryId: 'synthetic', dirty: false,
    attempt: { taskId: 'source' } };
  return { source, target, artifact };
}

test('explicit selector binds one exact commit and preserves the immutable plan root', () => {
  const { target, artifact } = tasks();
  const resolved = workflowResolvedTarget(target, [artifact]);
  expect(resolved.baseCommit).toBe(artifact.commit!);
  expect(target.spec.target.baseCommit).not.toBe(resolved.baseCommit);
  expect(workflowInputDigest(target, [artifact])).not.toBe(workflowInputDigest(target, [{ ...artifact, digest: `sha256:${'b'.repeat(64)}` }]));
});

test('publication gates bind the sourceTaskId commit rather than the approved root', () => {
  const { target, artifact } = tasks();
  const publication: WorkflowPlanTask = { ...target, spec: { kind: 'publish-pr',
    target: { ...target.spec.target, inputTaskId: null }, sourceTaskId: 'source', approvalTaskId: 'gate',
    baseBranch: 'main', headBranch: 'synthetic-output', title: 'Synthetic delivery', body: 'Synthetic body.', draft: true } };
  expect(workflowResolvedTarget(publication, [artifact]).baseCommit).toBe(artifact.commit!);
  expect(publication.spec.target.baseCommit).not.toBe(artifact.commit!);
  expect(() => workflowResolvedTarget(publication, [{ ...artifact, kind: 'command' }])).toThrow('exactly one');
});

test.each(['missing', 'multiple', 'summary', 'command', 'failed', 'asserted', 'dirty', 'repository', 'null-commit'] as const)(
  'selector rejects %s evidence instead of guessing an input', change => {
    const { target, artifact } = tasks();
    let inputs = [artifact];
    if (change === 'missing') inputs = [];
    if (change === 'multiple') inputs.push({ ...artifact, id: 'other' });
    if (change === 'summary' || change === 'command') inputs = [{ ...artifact, kind: change }];
    if (change === 'failed') inputs = [{ ...artifact, outcome: 'fail' }];
    if (change === 'asserted') inputs = [{ ...artifact, provenance: 'agent-asserted' }];
    if (change === 'dirty') inputs = [{ ...artifact, dirty: true }];
    if (change === 'repository') inputs = [{ ...artifact, repositoryId: 'other' }];
    if (change === 'null-commit') inputs = [{ ...artifact, commit: null }];
    expect(() => workflowResolvedTarget(target, inputs)).toThrow('exactly one');
  },
);

test.each(['missing-edge', 'self', 'root', 'repository', 'command-source'] as const)('graph rejects %s input selection', change => {
  const { source, target } = tasks();
  const selected = { ...target, dependsOn: change === 'missing-edge' ? [] : target.dependsOn,
    spec: { ...target.spec, target: { ...target.spec.target,
      inputTaskId: change === 'self' ? target.id : 'source',
      baseCommit: change === 'root' ? 'c'.repeat(40) : target.spec.target.baseCommit,
      repositoryId: change === 'repository' ? 'other' : target.spec.target.repositoryId } } };
  const producer = change === 'command-source' ? { ...plan().tasks[0]!, id: 'source' } : source;
  expect(() => validateWorkflowGraph(parseWorkflowPlan({ ...plan(), tasks: [producer, selected] }))).toThrow();
});

test('review response requirements are composed before effective-input capture', () => {
  const { source } = tasks();
  if (source.spec.kind !== 'agent') throw new Error('Synthetic task kind.');
  const review = { ...source.spec, outputs: ['review'] as const };
  expect(workflowAgentPrompt(review, 'b'.repeat(40))).toContain('b'.repeat(40));
  expect(workflowAgentPrompt(review, 'b'.repeat(40))).toContain('"decision"');
  expect(workflowAgentPrompt(source.spec, 'b'.repeat(40))).toContain(source.spec.prompt);
  expect(workflowAgentPrompt(source.spec, 'b'.repeat(40))).toContain('current branch');
  expect(workflowAgentPrompt(source.spec, 'b'.repeat(40))).toContain('clean');
});

test.each(['matching', 'selector', 'repository', 'root'] as const)('independent review requires matching input: %s', change => {
  const { source, target } = tasks();
  if (source.spec.kind !== 'agent') throw new Error('Synthetic task kind.');
  const reviewer = { ...source, id: 'reviewer', dependsOn: ['source'], spec: { ...source.spec, outputs: ['review'] as const,
    target: { ...target.spec.target, inputTaskId: change === 'selector' ? 'source' : null,
      repositoryId: change === 'repository' ? 'other' : target.spec.target.repositoryId,
      baseCommit: change === 'root' ? 'd'.repeat(40) : target.spec.target.baseCommit } } };
  const check = { ...target, dependsOn: ['source', 'reviewer'], spec: { ...target.spec, target: { ...target.spec.target, inputTaskId: null } },
    acceptance: [{ kind: 'independent-review' as const, taskId: 'reviewer' }] };
  const validate = () => validateWorkflowGraph({ ...plan(), tasks: [source, reviewer, check] });
  if (change === 'matching') expect(validate).not.toThrow();
  else expect(validate).toThrow();
});

test('independent reviews cannot automatically retry a rejected input', () => {
  const { source } = tasks();
  if (source.spec.kind !== 'agent') throw new Error('Synthetic task kind.');
  const reviewer = { ...source, spec: { ...source.spec, outputs: ['review'] as const },
    retry: { ...source.retry, repeatableFailure: true, maxAttempts: 2 } };
  expect(() => validateWorkflowGraph({ ...plan(), goal: { kind: 'artifacts', taskIds: [reviewer.id] }, tasks: [reviewer] }))
    .toThrow('retry');
});

test('review and approval accept existing inputs, never a future agent commit', () => {
  const { source } = tasks();
  if (source.spec.kind !== 'agent') throw new Error('Synthetic task kind.');
  const reviewer = { ...source, id: 'reviewer', spec: { ...source.spec, outputs: ['review'] as const } };
  const producing = { ...source, dependsOn: ['reviewer'], acceptance: [{ kind: 'independent-review' as const, taskId: 'reviewer' }] };
  expect(() => validateWorkflowGraph({ ...plan(), goal: { kind: 'artifacts', taskIds: ['source'] }, tasks: [reviewer, producing] }))
    .toThrow('existing input');
});

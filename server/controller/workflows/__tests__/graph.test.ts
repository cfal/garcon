import { expect, test } from 'bun:test';
import { parseWorkflowPlan } from '../../../../common/workflow-validation.js';
import { validateWorkflowGraph, workflowMermaid, workflowOrder } from '../graph.js';
import { workflowDigest } from '../inputs.js';
import { invalidatedWorkflowTasks } from '../transitions.js';
import { plan } from './fixture.js';
import { integrationPlan, replaceTarget } from './integration-fixture.js';

test('rejects missing, duplicate, self and cyclic dependencies', () => {
  const first = plan().tasks[0]!;
  for (const tasks of [
    [first, first], [{ ...first, dependsOn: ['missing'] }], [{ ...first, dependsOn: ['check'] }],
    [{ ...first, dependsOn: ['other'] }, { ...first, id: 'other', dependsOn: ['check'] }],
  ]) expect(() => validateWorkflowGraph(parseWorkflowPlan({ ...plan(), tasks }))).toThrow();
});
test('strict parser rejects deferred kinds, goals, unbounded commands and forged fields', () => {
  const original = plan();
  for (const spec of [{ kind: 'external-gate', predicate: 'pr-merged' },
    { ...original.tasks[0]!.spec, command: 'a'.repeat(65537) }, { ...original.tasks[0]!.spec, lease: 'forged' }]) {
    expect(() => parseWorkflowPlan({ ...original, tasks: [{ ...original.tasks[0], spec }] })).toThrow();
  }
  expect(() => parseWorkflowPlan({ ...original, goal: { kind: 'pr-merged', taskIds: ['check'] } })).toThrow();
});
test('canonical digests ignore object property order but preserve dependency order', () => {
  expect(workflowDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(workflowDigest({ b: { d: 3, c: 2 }, a: 1 }));
  expect(workflowDigest(['a', 'b'])).not.toBe(workflowDigest(['b', 'a']));
});
test('changed tasks invalidate descendants, not independent branches', () => {
  const first = plan().tasks[0]!;
  const original = { ...plan(), tasks: [first, { ...first, id: 'dependent', dependsOn: ['check'] }, { ...first, id: 'independent' }] };
  const changed = { ...original, tasks: [{ ...first, title: 'Changed' }, ...original.tasks.slice(1)] };
  expect([...invalidatedWorkflowTasks(original, changed)]).toEqual(['check', 'dependent']);
  expect(workflowOrder(original)).toEqual(['check', 'independent', 'dependent']);
});
test('Mermaid uses stored edges and escapes executable labels', () => {
  const first = plan().tasks[0]!;
  const graph = { ...plan(), tasks: [{ ...first, title: '\"]\nclick n0 javascript:bad' }, { ...first, id: 'next', dependsOn: ['check'] }] };
  const diagram = workflowMermaid(graph);
  expect(diagram).toContain('n0 --> n1');
  expect(diagram).not.toContain('\nclick');
  expect(diagram).not.toContain('javascript:');
});

test.each([15, 16])('integration input budget rejects %s inputs before effects', count => {
  const validate = () => validateWorkflowGraph(parseWorkflowPlan(integrationPlan(count)));
  if (count === 15) expect(validate).not.toThrow();
  else expect(validate).toThrow('15');
});

test.each(['repository', 'root', 'retry', 'summary', 'clone', 'executor'] as const)('integration rejects invalid %s contracts', kind => {
  const input = integrationPlan();
  const tasks = input.tasks.map(task => {
    if (task.id === 'source0') {
      if (kind === 'repository') return replaceTarget(task, { repositoryId: 'different' });
      if (kind === 'root') return replaceTarget(task, { baseCommit: 'b'.repeat(40) });
      if (kind === 'clone') return replaceTarget(task, { projectPath: '/synthetic/other-clone' });
      if (kind === 'executor') return replaceTarget(task, { executorId: '11111111-1111-4111-8111-111111111111' });
    }
    if (task.id === 'integrate') {
      if (kind === 'retry') return { ...task, retry: { ...task.retry, maxAttempts: 2, repeatableFailure: true } };
      if (kind === 'summary') return { ...task, acceptance: [{ kind: 'artifact' as const, output: 'summary' as const }] };
    }
    return task;
  });
  expect(() => validateWorkflowGraph(parseWorkflowPlan({ ...input, tasks }))).toThrow();
});

test('different clones on one executor require matching approved remote writes', () => {
  const input = integrationPlan();
  const remote = { name: 'origin', url: 'https://example.invalid/synthetic.git' };
  const tasks = input.tasks.map(task => replaceTarget(task, { remote,
    ...(task.id === 'source0' ? { projectPath: '/synthetic/other-clone' } : {}) }));
  expect(() => validateWorkflowGraph(parseWorkflowPlan({ ...input, tasks, policy: { ...input.policy, allowRemoteWrites: true } }))).not.toThrow();
  expect(() => validateWorkflowGraph(parseWorkflowPlan({ ...input, tasks }))).toThrow('remote');
});

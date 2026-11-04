import { expect, test } from 'bun:test';
import { parseWorkflowPlan } from '../../../../common/workflow-validation.js';
import { validateWorkflowGraph, workflowMermaid, workflowOrder } from '../graph.js';
import { workflowDigest } from '../inputs.js';
import { invalidatedWorkflowTasks } from '../transitions.js';
import { plan } from './fixture.js';

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

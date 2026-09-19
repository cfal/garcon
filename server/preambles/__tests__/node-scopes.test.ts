import { expect, test } from 'bun:test';
import { normalizePreambleDefinitionInput, PREAMBLE_COMBINED_MAX_LENGTH, type Preamble } from '../../../common/preambles.js';
import { preambleScopeMatches } from '../matching.js';
import { preambleCatalogCompositionViolation } from '../catalog-budget.js';
import { PreambleProjectPathService } from '../project-path-service.js';

const NODE_ID = '22222222-2222-4222-8222-222222222222';
function preamble(nodeId?: string): Preamble {
  return {
    id: '33333333-3333-4333-8333-333333333333', title: 'Synthetic scope',
    content: 'Synthetic instructions', enabled: true, agentIds: [], tagFilter: { mode: 'any', tags: [] },
    scope: { type: 'project-paths', rules: [{ projectPath: '/project', includeNested: true, ...(nodeId ? { nodeId } : {}) }] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('project scopes and duplicate path validation include the execution node', () => {
  expect(preambleScopeMatches(preamble(), '/project/child')).toBe(true);
  expect(preambleScopeMatches(preamble(), '/project', NODE_ID)).toBe(false);
  expect(preambleScopeMatches(preamble(NODE_ID), '/project')).toBe(false);
  expect(preambleScopeMatches(preamble(NODE_ID), '/project/child', NODE_ID)).toBe(true);
  const definition = { ...preamble(), scope: { type: 'project-paths', rules: [
    { projectPath: '/project', includeNested: true },
    { nodeId: NODE_ID, projectPath: '/project', includeNested: true },
  ] } };
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = definition;
  expect(normalizePreambleDefinitionInput(input)?.scope).toEqual(definition.scope);
  expect(normalizePreambleDefinitionInput({ ...input, scope: { ...input.scope, rules: [input.scope.rules[0], input.scope.rules[0]] } })).toBeNull();
});

test('catalog budgets do not combine project-specific text from different nodes', () => {
  const first = { ...preamble(), content: 'A'.repeat(PREAMBLE_COMBINED_MAX_LENGTH / 2) };
  const second = { ...preamble(NODE_ID), content: 'B'.repeat(PREAMBLE_COMBINED_MAX_LENGTH / 2) };
  expect(preambleCatalogCompositionViolation([first, second])).toBeNull();
  expect(preambleCatalogCompositionViolation([first, { ...second, scope: first.scope }])?.kind).toBe('combined-limit');
});

test('scope mutation inspection reaches the selected node and does not fall back', async () => {
  const seen: (string | null | undefined)[] = [];
  const paths = new PreambleProjectPathService(async (_path, nodeId) => {
    seen.push(nodeId);
    if (nodeId !== NODE_ID) throw new Error('Unavailable node');
    return { kind: 'available', effectiveProjectKey: '/canonical' };
  });
  expect(await paths.resolve('/project', NODE_ID)).toBe('/canonical');
  await expect(paths.resolve('/project')).rejects.toThrow('Unavailable node');
  expect(seen).toEqual([NODE_ID, undefined]);
});

import { expect, test } from 'bun:test';
import { normalizePreambleDefinitionInput, PREAMBLE_COMBINED_MAX_LENGTH, type Preamble } from '../../../../common/preambles.js';
import { preambleScopeMatches } from '../matching.js';
import { preambleCatalogCompositionViolation } from '../catalog-budget.js';
import { PreambleProjectPathService } from '../project-path-service.js';

const EXECUTOR_ID = '22222222-2222-4222-8222-222222222222';
function preamble(executorId?: string): Preamble {
  return {
    id: '33333333-3333-4333-8333-333333333333', title: 'Synthetic scope',
    content: 'Synthetic instructions', enabled: true, agentIds: [], tagFilter: { mode: 'any', tags: [] },
    scope: { type: 'project-paths', rules: [{ projectPath: '/project', includeNested: true, ...(executorId ? { executorId } : {}) }] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('project scopes and duplicate path validation include the executor', () => {
  expect(preambleScopeMatches(preamble(), '/project/child')).toBe(true);
  expect(preambleScopeMatches(preamble(), '/project', EXECUTOR_ID)).toBe(false);
  expect(preambleScopeMatches(preamble(EXECUTOR_ID), '/project')).toBe(false);
  expect(preambleScopeMatches(preamble(EXECUTOR_ID), '/project/child', EXECUTOR_ID)).toBe(true);
  const definition = { ...preamble(), scope: { type: 'project-paths', rules: [
    { projectPath: '/project', includeNested: true },
    { executorId: EXECUTOR_ID, projectPath: '/project', includeNested: true },
  ] } };
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = definition;
  expect(normalizePreambleDefinitionInput(input)?.scope).toEqual(definition.scope);
  expect(normalizePreambleDefinitionInput({ ...input, scope: { ...input.scope, rules: [input.scope.rules[0], input.scope.rules[0]] } })).toBeNull();
});

test('catalog budgets do not combine project-specific text from different executors', () => {
  const first = { ...preamble(), content: 'A'.repeat(PREAMBLE_COMBINED_MAX_LENGTH / 2) };
  const second = { ...preamble(EXECUTOR_ID), content: 'B'.repeat(PREAMBLE_COMBINED_MAX_LENGTH / 2) };
  expect(preambleCatalogCompositionViolation([first, second])).toBeNull();
  expect(preambleCatalogCompositionViolation([first, { ...second, scope: first.scope }])?.kind).toBe('combined-limit');
});

test('scope mutation inspection reaches the selected executor and does not fall back', async () => {
  const seen: (string | null | undefined)[] = [];
  const paths = new PreambleProjectPathService(async (_path, executorId) => {
    seen.push(executorId);
    if (executorId !== EXECUTOR_ID) throw new Error('Unavailable executor');
    return { kind: 'available', effectiveProjectKey: '/canonical' };
  });
  expect(await paths.resolve('/project', EXECUTOR_ID)).toBe('/canonical');
  await expect(paths.resolve('/project')).rejects.toThrow('Unavailable executor');
  expect(seen).toEqual([EXECUTOR_ID, undefined]);
});

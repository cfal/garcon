import { expect, mock, test } from 'bun:test';
import { CompatibilityEvidence } from '../../support/compatibility-evidence.js';
import { catalogRequirements } from '../../support/compatibility-workflows.js';
import { EXECUTION_LAUNCH_OPERATIONS_V1, EXECUTION_WORKFLOW_V1, supportsProviderInitialization } from '../../../common/executor-contracts.js';
import { executorSupportsExecution } from '../../../common/executors.js';

const missing = { surface: 'executor', name: 'files.read' } as const;
const list = { surface: 'executor', name: 'files.list' } as const;
const catalogs = { executor: ['files.list'], 'direct-cli': {}, 'gateway-cli': {} };

test('absence requires an exact declared contract and an executed refusal check', async () => {
  const evidence = new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]);
  const read = mock(async () => {});
  const refusal = mock(async () => {});
  const listing = mock(async () => {});
  await evidence.check('read', [missing], read, refusal);
  await evidence.check('list', [list], listing, refusal);
  expect(read).not.toHaveBeenCalled();
  expect(refusal).toHaveBeenCalledTimes(1);
  expect(refusal).toHaveBeenCalledWith([missing]);
  expect(listing).toHaveBeenCalledTimes(1);
  expect(evidence.report()).toEqual({ checked: ['list'], unsupported: [{ workflow: 'read', missing: [missing] }], contracts: catalogs });
});

test('unexpected absence, false unsupported expectations, and untested expectations fail closed', async () => {
  const run = mock(async () => {});
  await expect(new CompatibilityEvidence(catalogs, []).check('read', [missing], run, run)).rejects.toThrow('Unexpected contract availability');
  const falseExpectation = new CompatibilityEvidence(catalogs, [{ workflow: 'list', missing: [list] }]);
  await expect(falseExpectation.check('list', [list], run, run)).rejects.toThrow('Unexpected contract availability');
  expect(() => falseExpectation.report()).toThrow('Unverified');
  expect(() => new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]).report()).toThrow('Unverified');
  expect(run).not.toHaveBeenCalled();
});

test('an unproved refusal is never reported as a skipped success', async () => {
  const evidence = new CompatibilityEvidence(catalogs, [{ workflow: 'read', missing: [missing] }]);
  await expect(evidence.check('read', [missing], async () => {}, async () => { throw new Error('Not a definite refusal'); })).rejects.toThrow('Not a definite refusal');
  expect(evidence.unsupported).toEqual([]);
  expect(() => evidence.report()).toThrow('Unverified');
});

const workflow = EXECUTION_WORKFLOW_V1.map(definition => definition.name);
const launches = ['execution.start', 'execution.resume', 'compaction.compact'] as const;

test('catalog evidence and execution availability preserve the production launch requirements', () => {
  expect(EXECUTION_LAUNCH_OPERATIONS_V1).toEqual(launches);
  for (let mask = 0; mask < 2 ** launches.length; mask++) {
    const available = launches.filter((_, index) => mask & (1 << index));
    for (const absent of [null, ...workflow]) {
      const executor: readonly string[] = ['singleQuery.run', ...workflow.filter(name => name !== absent), ...available];
      const canInitialize = absent === null && available.length > 0;
      expect(supportsProviderInitialization(definitions => definitions.every(definition => executor.includes(definition.name))))
        .toBe(canInitialize);
      expect(catalogRequirements(executor).every(ref => executor.includes(ref.name))).toBe(canInitialize);
      for (const launch of launches) {
        expect(executorSupportsExecution({ operations: executor }, launch)).toBe(absent === null && available.includes(launch));
      }
    }
  }
});

for (const absent of [...workflow.map(name => [name]), [...launches]]) {
  test(`catalog evidence refuses missing initialization operations: ${absent.join(', ')}`, async () => {
    const executor: readonly string[] = [...workflow, ...launches].filter(name => !absent.some(value => value === name));
    expect(catalogRequirements(executor).every(ref => executor.includes(ref.name))).toBe(
      supportsProviderInitialization(definitions => definitions.every(definition => executor.includes(definition.name))),
    );
    const expected = absent.map(name => ({ surface: 'executor' as const, name }));
    const evidence = new CompatibilityEvidence({ ...catalogs, executor }, [{ workflow: 'catalog', missing: expected }]);
    const run = mock(async () => {});
    const refusal = mock(async () => {});
    await evidence.check('catalog', catalogRequirements(executor), run, refusal);
    expect(run).not.toHaveBeenCalled();
    expect(refusal).toHaveBeenCalledWith(expected);
    expect(evidence.report().unsupported).toHaveLength(1);
  });
}

test.each(launches)('catalog evidence accepts initialization with only %s', async launch => {
  const executor: readonly string[] = [...workflow, launch];
  expect(catalogRequirements(executor).every(ref => executor.includes(ref.name))).toBe(
    supportsProviderInitialization(definitions => definitions.every(definition => executor.includes(definition.name))),
  );
  const evidence = new CompatibilityEvidence({ ...catalogs, executor }, []);
  const run = mock(async () => {});
  const refusal = mock(async () => {});
  await evidence.check('catalog', catalogRequirements(executor), run, refusal);
  expect(run).toHaveBeenCalledTimes(1);
  expect(refusal).not.toHaveBeenCalled();
  expect(evidence.report().checked).toEqual(['catalog']);
});

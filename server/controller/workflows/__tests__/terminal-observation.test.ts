import { expect, test } from 'bun:test';
import type { AutomationResult } from '../../../../common/automation.js';
import { WORKFLOW_LIMITS } from '../../../../common/workflows.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import { plan } from './fixture.js';

const task = plan().tasks[0]!;
const failed: AutomationResult = { kind: 'failed', certainty: 'definite', receipt: null, detail: 'Synthetic failure',
  receivedOutputCoverage: 'complete', commandOutcome: { outcome: 'failed', exitCode: 7, signal: null,
    capture: 'complete', cwd: { kind: 'reported', path: '/synthetic/managed' } } };

test('nonzero command evidence goes to checking rather than receipt-based failure', () => {
  expect(workflowTerminalObservation(task, failed)).toMatchObject({ resolution: 'checking',
    result: { certainty: 'definite', termination: 'observed', commandOutcome: failed.commandOutcome, outputCaptured: false } });
});

test.each(['unknown', 'not-started'] as const)('a %s delivery classification cannot be upgraded by command data', certainty => {
  expect(workflowTerminalObservation(task, { ...failed, certainty })).toMatchObject({
    resolution: certainty, result: { certainty, termination: certainty === 'not-started' ? 'not-started' : 'unknown' },
  });
});

test('missing native status and incomplete capture remain explicit', () => {
  expect(workflowTerminalObservation(task, { ...failed,
    commandOutcome: { ...failed.commandOutcome!, outcome: 'unknown', exitCode: null, capture: 'incomplete' } }))
    .toMatchObject({ resolution: 'unknown', result: { termination: 'unknown' } });
  expect(workflowTerminalObservation(task, { ...failed, receivedOutputCoverage: 'gapped',
    commandOutcome: { ...failed.commandOutcome!, capture: 'truncated' } })).toMatchObject({ resolution: 'checking',
      result: { receivedOutputCoverage: 'gapped', commandOutcome: { capture: 'truncated' } } });
});

test.each(['observed', 'requested'] as const)('interruption retains %s physical termination', termination => {
  expect(workflowTerminalObservation(task, { kind: 'interrupted', termination, receipt: null,
    commandOutcome: null, receivedOutputCoverage: 'unknown' })).toMatchObject({ resolution: 'interrupted',
      result: { termination: termination === 'observed' ? 'observed' : 'unknown' } });
});

test('unavailable receipt never fabricates retry authority', () => {
  expect(workflowTerminalObservation(task, { kind: 'unavailable', reason: 'Synthetic eviction',
    commandOutcome: null, receivedOutputCoverage: 'unknown' })).toMatchObject({ resolution: 'unknown',
      result: { certainty: 'unknown', termination: 'unknown' } });
});

test.each(['cwd', 'signal'] as const)('oversized escaped command %s omits metadata without erasing termination certainty', field => {
  const observation = workflowTerminalObservation(task, { ...failed, commandOutcome: { ...failed.commandOutcome!,
    signal: field === 'signal' ? '\u0001'.repeat(3000) : null,
    cwd: { kind: 'reported', path: field === 'cwd' ? '/' + '\u0001'.repeat(3000) : '/synthetic/managed' } } });
  expect(observation).toMatchObject({ resolution: 'checking', result: { certainty: 'definite', termination: 'observed',
    commandOutcome: { outcome: 'failed', exitCode: 7, capture: 'complete', cwd: { kind: 'unavailable' } } } });
  expect(observation.result.commandOutcome!.signal).toBe(field === 'signal' ? '\u0001'.repeat(256) : null);
  expect(observation.result.detail).toContain('omitted');
  expect(Buffer.byteLength(JSON.stringify(observation.result))).toBeLessThanOrEqual(WORKFLOW_LIMITS.resultBytes);
});

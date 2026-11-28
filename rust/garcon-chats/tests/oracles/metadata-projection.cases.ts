import { expect, test } from 'bun:test';
import { carryOverRevision, classify, projectChatActivityStatus, resolveChatTitle } from './metadata-projection.ts';

test('a carryover revision covers ordered segments and quarantine', () => {
  const ref = { id: '9df00801-0000-1000-9000-000000000009', agentId: 'codex', model: 'model',
    capturedAt: '2026-01-01T00:00:00.000Z', storedMessageCount: 8, visibleMessageCount: 5,
    trailingHandoff: { agentId: 'claude', model: 'next' } };
  const next = { ...ref, id: '9df00801-0000-1000-9000-000000000010', model: 'next', trailingHandoff: null };
  const quarantine = { artifactId: 'fixture-artifact', errorCode: 'INVALID_CARRYOVER_ENTRY' };
  expect(carryOverRevision([], null)).toBe('carry-v1:0');
  expect(carryOverRevision([], quarantine)).toMatch(/^carry-v5:/);
  expect(carryOverRevision([ref, next])).not.toBe(carryOverRevision([next, ref]));
  expect(carryOverRevision([ref])).not.toBe(carryOverRevision([{ ...ref, visibleMessageCount: 4 }]));
  expect(carryOverRevision([ref], quarantine)).not.toBe(carryOverRevision([ref]));
});

test('pending action only wins during a projected processing phase', () => {
  for (const processingPhase of [null, 'running', 'stopping', 'reconnecting'] as const) {
    for (const pendingUserAction of [false, true]) {
      for (const lastRunOutcome of [null, 'finished', 'failed', 'interrupted'] as const) {
        expect(projectChatActivityStatus({ processingPhase, pendingUserAction, lastRunOutcome })).toBe(
          processingPhase ? (pendingUserAction ? 'pending-user-action' : 'working')
            : lastRunOutcome === 'finished' ? 'complete' : lastRunOutcome === 'failed' ? 'error' : null,
        );
      }
    }
  }
});

test('title first line and order membership handle empty and overlapping inputs', () => {
  expect(resolveChatTitle(' \nName', 'first')).toBe('New Session');
  expect(resolveChatTitle('', '\ufeff First \r\nSecond')).toBe('First');
  expect(resolveChatTitle(null, null)).toBe('New Session');
  expect(resolveChatTitle(undefined, 'First\nSecond')).toBe('First');
  expect(resolveChatTitle('Name', 'First')).toBe('Name');
  const groups = { pinned: ['p'], normal: ['n', 'p'], archived: ['a', 'n', 'p'] };
  expect(classify('p', groups)).toBe('pinned');
  expect(classify('n', groups)).toBe('normal');
  expect(classify('a', groups)).toBe('archived');
  expect(classify('missing', groups)).toBe('orphan');
});

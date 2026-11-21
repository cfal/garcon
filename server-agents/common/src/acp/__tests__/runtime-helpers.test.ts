import { describe, expect, it } from 'bun:test';
import { autoApproveChoice, isAutoApproveMode, permissionChoiceOutcome } from '../runtime-helpers.ts';
import type { AcpAgentPolicy } from '../agent-runtime.ts';

const ANTIGRAVITY_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

const CURSOR_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function selected(optionId: string) {
  return { outcome: { outcome: 'selected', optionId } };
}

describe('permissionChoiceOutcome', () => {
  it('selects agent-defined option ids by ACP kind', () => {
    expect(permissionChoiceOutcome(ANTIGRAVITY_OPTIONS, 'allow-once')).toEqual(selected('allow'));
    expect(permissionChoiceOutcome(ANTIGRAVITY_OPTIONS, 'reject')).toEqual(selected('deny'));
  });

  it('falls back to a one-time grant when no persistent grant is offered', () => {
    expect(permissionChoiceOutcome(ANTIGRAVITY_OPTIONS, 'allow-always')).toEqual(selected('allow'));
    expect(permissionChoiceOutcome(CURSOR_OPTIONS, 'allow-always')).toEqual(selected('allow-always'));
  });

  it('never turns a one-time approval into a persistent grant', () => {
    const persistentOnly = [
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    expect(permissionChoiceOutcome(persistentOnly, 'allow-once')).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(permissionChoiceOutcome([{ optionId: 'allow-always' }], 'allow-once')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('never turns a one-time denial into a persistent deny rule', () => {
    const persistentDenyOnly = [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'never', kind: 'reject_always' },
    ];
    expect(permissionChoiceOutcome(persistentDenyOnly, 'reject')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('matches common untyped ids but never a typed option of another kind', () => {
    const untyped = [{ optionId: 'allow' }, { optionId: 'deny' }];
    expect(permissionChoiceOutcome(untyped, 'allow-once')).toEqual(selected('allow'));
    expect(permissionChoiceOutcome(untyped, 'reject')).toEqual(selected('deny'));
    const mislabeled = [{ optionId: 'deny', kind: 'reject_always' }];
    expect(permissionChoiceOutcome(mislabeled, 'reject')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('never resolves a denial to an allow option', () => {
    const allowOnly = [{ optionId: 'allow', kind: 'allow_once' }];
    expect(permissionChoiceOutcome(allowOnly, 'reject')).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('matches conventional ids when an agent omits kinds', () => {
    const untyped = [{ optionId: 'allow-once' }, { optionId: 'reject-once' }];
    expect(permissionChoiceOutcome(untyped, 'reject')).toEqual(selected('reject-once'));
    expect(permissionChoiceOutcome([], 'allow-once')).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('isAutoApproveMode', () => {
  it('follows the policy when an agent applies a mode natively', () => {
    const native = { agentId: 'native', command: 'agent', autoApprovePermissionModes: ['bypassPermissions'] } satisfies AcpAgentPolicy;
    const standard = { agentId: 'standard', command: 'agent' } satisfies AcpAgentPolicy;
    expect(isAutoApproveMode('acceptEdits', native)).toBe(false);
    expect(isAutoApproveMode('bypassPermissions', native)).toBe(true);
    expect(isAutoApproveMode('acceptEdits', standard)).toBe(true);
    expect(isAutoApproveMode('default', standard)).toBe(false);
  });
});

describe('autoApproveChoice', () => {
  it('grants persistently only under full bypass', () => {
    expect(autoApproveChoice('bypassPermissions')).toBe('allow-always');
    expect(autoApproveChoice('acceptEdits')).toBe('allow-once');
    expect(autoApproveChoice('manualBypass')).toBe('allow-once');
  });
});

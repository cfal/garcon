import { describe, expect, it } from 'bun:test';
import { autoApproveChoice, permissionChoiceOutcome } from '../runtime-helpers.ts';

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

describe('autoApproveChoice', () => {
  it('grants persistently only under full bypass', () => {
    expect(autoApproveChoice('bypassPermissions')).toBe('allow-always');
    expect(autoApproveChoice('acceptEdits')).toBe('allow-once');
    expect(autoApproveChoice('manualBypass')).toBe('allow-once');
  });
});

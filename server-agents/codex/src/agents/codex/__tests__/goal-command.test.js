import { describe, expect, it } from 'bun:test';

import { parseCodexGoalCommand } from '../goal-command.js';

describe('parseCodexGoalCommand', () => {
  it('parses and trims a Codex goal objective', () => {
    expect(parseCodexGoalCommand('/goal ship the feature')).toEqual({
      kind: 'set',
      objective: 'ship the feature',
    });
    expect(parseCodexGoalCommand('  /GOAL   ship carefully  ')).toEqual({
      kind: 'set',
      objective: 'ship carefully',
    });
  });

  it('parses lifecycle controls', () => {
    expect(parseCodexGoalCommand('/goal')).toEqual({ kind: 'status' });
    expect(parseCodexGoalCommand('/goal   ')).toEqual({ kind: 'status' });
    expect(parseCodexGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(parseCodexGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
    expect(parseCodexGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
  });

  it('parses explicit edit and replacement commands', () => {
    expect(parseCodexGoalCommand('/goal edit')).toEqual({ kind: 'edit', objective: null });
    expect(parseCodexGoalCommand('/goal edit ship more carefully')).toEqual({
      kind: 'edit',
      objective: 'ship more carefully',
    });
    expect(parseCodexGoalCommand('/goal replace ship a different feature')).toEqual({
      kind: 'replace',
      objective: 'ship a different feature',
    });
    expect(parseCodexGoalCommand('/goal replace')).toEqual({
      kind: 'unsupported',
      subcommand: 'replace',
    });
  });

  it('does not match similar or non-leading text', () => {
    expect(parseCodexGoalCommand('/goals ship')).toBeNull();
    expect(parseCodexGoalCommand('please /goal ship')).toBeNull();
  });
});

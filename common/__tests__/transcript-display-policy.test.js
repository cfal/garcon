import { describe, expect, test } from 'bun:test';
import { BashToolUseMessage, EnterPlanModeToolUseMessage, ReadToolUseMessage, parseChatMessage } from '../chat-types.js';
import { HIDEABLE_TOOL_GROUPS, TOOL_STRUCTURE, hasEmptyRequiredInput, intrinsicDisplayRole,
  toolHideGroup, toolResultVisible, toolSummaryCategory, toolSummaryWeight } from '../transcript-display-policy.js';
import { bashRevisionInput, compileHiddenBashCommandPatterns } from '../transcript-display-matcher.js';

const at = '2026-01-01T00:00:00.000Z';

describe('transcript display structural policy', () => {
  test('hide groups partition known tools without treating every bash-group tool as a command', () => {
    expect(HIDEABLE_TOOL_GROUPS).toHaveLength(7);
    const types = HIDEABLE_TOOL_GROUPS.flatMap(group => group.toolTypes);
    expect(new Set(types).size).toBe(types.length);
    expect(types.every(type => type in TOOL_STRUCTURE)).toBe(true);
    expect(toolHideGroup('claude-monitor-tool-use')).toBe('bash');
    expect(toolSummaryCategory('claude-monitor-tool-use')).toBe('other');
    expect(toolHideGroup('exit-plan-mode-tool-use')).toBeNull();
  });

  test('keeps plan boundaries despite their hidden ordinary tool input', () => {
    expect(intrinsicDisplayRole(new EnterPlanModeToolUseMessage(at, 'plan'))).toBe('breaker');
    expect(intrinsicDisplayRole(new BashToolUseMessage(at, 'command', 'true'))).toBe('member');
    expect(intrinsicDisplayRole(new ReadToolUseMessage(at, 'read', '/generic'))).toBe('member');
  });

  test('empty required input overrides only failed result suppression', () => {
    expect(hasEmptyRequiredInput(new BashToolUseMessage(at, 'command', ''))).toBe(true);
    expect(toolResultVisible('bash-tool-use', true, true)).toBe(true);
    expect(toolResultVisible('bash-tool-use', true, false)).toBe(false);
    expect(toolResultVisible('read-tool-use', false, true)).toBe(false);
    expect(toolResultVisible('glob-tool-use', false, false)).toBe(true);
  });

  test('counts edited files while membership remains one use', () => {
    const edit = parseChatMessage({ type: 'edit-tool-use', timestamp: at, toolId: 'edit', filePath: '/generic',
      oldString: '', newString: '', changes: [{ path: '/one' }, { path: '/two' }] });
    expect(toolSummaryWeight(edit)).toBe(2);
    expect(toolSummaryCategory(edit.type)).toBe('fileEdits');
  });

  test('preserves regex, whole-command glob, Unicode and revision semantics', () => {
    expect(compileHiddenBashCommandPatterns([])).toBeNull();
    const glob = compileHiddenBashCommandPatterns([{ mode: 'glob', pattern: '?' }]);
    expect(glob('\u{1f600}')).toBe(true);
    expect(glob('xx')).toBe(false);
    const regex = compileHiddenBashCommandPatterns([{ mode: 'regex', pattern: '^$' }]);
    expect(regex('')).toBe(true);
    const pattern = { mode: 'regex', pattern: 'command' };
    expect(bashRevisionInput([pattern, pattern])).toBe(bashRevisionInput([pattern]));
  });
});

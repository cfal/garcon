import { describe, expect, test } from 'bun:test';
import { BashToolUseMessage, EnterPlanModeToolUseMessage, ReadToolUseMessage, parseChatMessage } from '../chat-types.js';
import { HIDEABLE_TOOL_GROUPS, TOOL_STRUCTURE, hasEmptyRequiredInput, intrinsicDisplayRole,
  toolHideGroup, toolResultVisible, toolSummaryCategory, toolSummaryWeight } from '../transcript-display-policy.js';
import { bashRevisionInput, compileHiddenBashCommandPatterns } from '../transcript-display-matcher.js';

const at = '2026-01-01T00:00:00.000Z';
const toolPolicy = [
  ['bash-tool-use', 'bash', 'commands', 'member', false, false],
  ['exec-tool-use', 'exec', 'commands', 'member', false, false],
  ['wait-tool-use', 'exec', 'other', 'hidden', false, false],
  ['read-tool-use', 'file-reads', 'fileReads', 'member', false, false],
  ['list-tool-use', 'file-reads', 'fileReads', 'member', false, false],
  ['edit-tool-use', 'file-changes', 'fileEdits', 'member', false, false],
  ['write-tool-use', 'file-changes', 'fileEdits', 'member', false, false],
  ['apply-patch-tool-use', 'file-changes', 'fileEdits', 'member', false, false],
  ['grep-tool-use', 'file-reads', 'fileReads', 'member', true, true],
  ['glob-tool-use', 'file-reads', 'fileReads', 'member', true, true],
  ['web-search-tool-use', 'web', 'other', 'member', true, true],
  ['web-fetch-tool-use', 'web', 'other', 'member', true, true],
  ['todo-write-tool-use', 'tasks', 'other', 'member', true, true],
  ['todo-read-tool-use', 'tasks', 'other', 'member', true, true],
  ['task-tool-use', 'tasks', 'other', 'member', true, true],
  ['codex-subagent-tool-use', 'tasks', 'other', 'member', true, true],
  ['update-plan-tool-use', 'tasks', 'other', 'member', true, true],
  ['write-stdin-tool-use', 'bash', 'other', 'hidden', false, false],
  ['enter-plan-mode-tool-use', 'tasks', 'other', 'breaker', false, false],
  ['exit-plan-mode-tool-use', null, 'other', 'breaker', false, false],
  ['ask-user-question-tool-use', null, 'other', 'hidden', false, false],
  ['cursor-create-plan-tool-use', 'tasks', 'other', 'hidden', false, false],
  ['amp-finder-tool-use', 'provider', 'other', 'member', true, true],
  ['amp-oracle-tool-use', 'provider', 'other', 'member', true, true],
  ['amp-librarian-tool-use', 'provider', 'other', 'member', true, true],
  ['amp-skill-tool-use', 'provider', 'other', 'member', false, false],
  ['amp-mermaid-tool-use', 'provider', 'other', 'member', false, false],
  ['amp-handoff-tool-use', 'tasks', 'other', 'member', false, false],
  ['amp-look-at-tool-use', 'provider', 'other', 'member', false, false],
  ['amp-find-thread-tool-use', 'provider', 'other', 'member', true, true],
  ['amp-read-thread-tool-use', 'provider', 'other', 'member', true, true],
  ['amp-task-list-tool-use', 'tasks', 'other', 'member', true, true],
  ['pi-tool-search-tool-use', 'provider', 'other', 'member', true, true],
  ['claude-tool-search-tool-use', 'provider', 'other', 'member', true, true],
  ['claude-monitor-tool-use', 'bash', 'other', 'member', true, true],
  ['external-tool-use', 'provider', 'other', 'member', true, true],
  ['mcp-tool-use', 'provider', 'other', 'member', true, true],
  ['request-permissions-tool-use', null, 'other', 'member', false, false],
  ['unknown-tool-use', null, 'other', 'member', true, true],
];
function tool(type, overrides = {}) {
  return parseChatMessage({ type, timestamp: at, toolId: 'synthetic-tool', command: 'true', path: '/synthetic',
    filePath: '/synthetic', pattern: '*', code: 'true', language: 'javascript', executionId: 'synthetic-execution',
    query: 'synthetic', url: 'https://example.test', plan: 'Synthetic plan', description: 'Synthetic description',
    content: 'Synthetic content', action: 'spawn_agent', details: { taskName: 'synthetic-worker' }, ...overrides });
}

describe('transcript display structural policy', () => {
  test('independent policy goldens cover every concrete tool exactly once', () => {
    expect(toolPolicy.map(([type]) => type).sort()).toEqual(Object.keys(TOOL_STRUCTURE).filter(type => type !== 'default').sort());
  });
  test.each(toolPolicy)('preserves the explicit policy for %s', (type, hideGroup, category, role, success, failure) => {
    expect(toolHideGroup(type)).toBe(hideGroup);
    expect(toolSummaryCategory(type)).toBe(category);
    expect(intrinsicDisplayRole(tool(type))).toBe(role);
    expect(toolResultVisible(type, false, false)).toBe(success);
    expect(toolResultVisible(type, true, false)).toBe(failure);
  });
  test.each([
    ['bash-tool-use', 'command'], ['exec-tool-use', 'code'], ['read-tool-use', 'filePath'],
    ['write-tool-use', 'filePath'], ['edit-tool-use', 'filePath'],
    ['claude-tool-search-tool-use', 'query'], ['claude-monitor-tool-use', 'description'],
  ])('recognizes empty required input for %s', (type, field) => {
    expect(hasEmptyRequiredInput(tool(type))).toBe(false);
    expect(hasEmptyRequiredInput(tool(type, { [field]: '' }))).toBe(true);
    expect(toolResultVisible(type, true, true)).toBe(true);
  });

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

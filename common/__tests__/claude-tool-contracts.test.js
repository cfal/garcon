import { describe, expect, it } from 'bun:test';
import {
  ClaudeMonitorToolUseMessage, ClaudeToolSearchToolUseMessage, PermissionRequestMessage,
  ToolResultMessage, isToolUseMessage, parseChatMessage,
} from '../chat-types';
import { projectToolUseSummary } from '../transcript-seed';

describe('Claude discovery and Monitor contracts', () => {
  it('round-trips calls, rejected calls, structured results, and nested permissions', () => {
    const monitor = new ClaudeMonitorToolUseMessage('', 'monitor', 'Synthetic watch', 123.5,
      'printf synthetic', 'ws://synthetic.invalid/events', ['synthetic-events']);
    for (const message of [
      new ClaudeToolSearchToolUseMessage('', 'search', 'select:Monitor', 1), monitor,
      new ClaudeToolSearchToolUseMessage('', 'invalid-search', ''),
      new ClaudeMonitorToolUseMessage('', 'invalid-monitor', ''),
      new ToolResultMessage('', 'search', {
        items: [{ type: 'tool_reference', tool_name: 'Monitor' }],
        toolUseResult: { matches: ['Monitor'], query: 'select:Monitor', total_deferred_tools: 1 },
      }, false),
      new PermissionRequestMessage('', 'permission-synthetic', monitor),
    ]) {
      const parsed = parseChatMessage(JSON.parse(JSON.stringify(message)));
      expect(parsed).toEqual(message);
      expect(parsed).toBeInstanceOf(message.constructor);
      if (message.type.endsWith('-tool-use')) expect(isToolUseMessage(parsed)).toBe(true);
    }
  });

  it('coerces malformed display fields without guessing native validation rules', () => {
    expect(parseChatMessage({ type: 'claude-monitor-tool-use', description: null,
      timeoutMs: Infinity, command: 3, webSocketUrl: [], webSocketProtocols: ['synthetic', 7] }))
      .toEqual(new ClaudeMonitorToolUseMessage('', '', '', undefined, undefined, undefined, ['synthetic']));
    expect(parseChatMessage({ type: 'claude-tool-search-tool-use', query: false, maxResults: NaN }))
      .toEqual(new ClaudeToolSearchToolUseMessage('', '', ''));
    expect(parseChatMessage({ type: 'claude-monitor-tool-use', timeoutMs: -0.5 }).timeoutMs).toBe(-0.5);
  });

  it('carries discovery queries and watch descriptions into tool summaries', () => {
    expect(projectToolUseSummary(new ClaudeToolSearchToolUseMessage('', 'search', 'select:Monitor')).text)
      .toBe('select:Monitor');
    expect(projectToolUseSummary(new ClaudeMonitorToolUseMessage('', 'monitor', 'Synthetic watch')).text)
      .toBe('Synthetic watch');
  });
});

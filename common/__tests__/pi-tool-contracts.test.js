import { describe, expect, it } from 'bun:test';
import { ExecToolUseMessage, McpToolUseMessage, PiToolSearchToolUseMessage, isToolUseMessage, parseChatMessage } from '../chat-types';
import { projectToolUseSummary, renderTranscriptSeed } from '../transcript-seed';

describe('Pi tool contracts', () => {
  it('round-trips the canonical tool messages used by Pi', () => {
    for (const message of [
      new ExecToolUseMessage('', 'code', 'return 1;', 'javascript'),
      new McpToolUseMessage('', 'mcp', 'docs', 'read_mcp_resource', { uri: 'resource://intro' }),
      new PiToolSearchToolUseMessage('', 'search', 'issue tools', 3),
    ]) {
      const parsed = parseChatMessage(JSON.parse(JSON.stringify(message)));
      expect(parsed).toEqual(message);
      expect(isToolUseMessage(parsed)).toBe(true);
    }
  });

  it('includes the discovery query in carried tool summaries', () => {
    expect(projectToolUseSummary(new PiToolSearchToolUseMessage('', 'search', 'issue tools')).text).toBe('issue tools');
  });

  it('does not invent a server prefix for unnamed MCP resources or truncated names', () => {
    const message = new McpToolUseMessage('', 'resources', '', 'list_mcp_resources', {});
    expect(projectToolUseSummary(message).text).toBe('list_mcp_resources');
    expect(renderTranscriptSeed([message])).toContain('Assistant used mcp: /list_mcp_resources');
  });
});

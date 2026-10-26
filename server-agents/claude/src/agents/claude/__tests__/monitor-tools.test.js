import { describe, expect, it } from 'bun:test';
import { ClaudeMonitorToolUseMessage, ClaudeToolSearchToolUseMessage } from '@garcon/common/chat-types';
import { convertClaudeToolUse } from '../tool-use-converter.js';
import { convertClaudePermissionRequest } from '../permission-tool-converter.js';
import { convertClaudeEntries } from '../history-loader.js';
import { convertCLIMessageToChatMessages } from '../cli-protocol.js';

const timestamp = '2026-10-01T00:00:00.000Z';
const examples = [
  ['ToolSearch', { query: 'select:Monitor', max_results: 1 },
    new ClaudeToolSearchToolUseMessage(timestamp, 'synthetic-tool', 'select:Monitor', 1)],
  ['Monitor', { description: 'Synthetic command watch', timeout_ms: 123.5, command: 'printf synthetic' },
    new ClaudeMonitorToolUseMessage(timestamp, 'synthetic-tool', 'Synthetic command watch', 123.5, 'printf synthetic')],
  ['Monitor', { description: 'Synthetic session watch', timeout_ms: 300_000, persistent: true,
    command: 'printf synthetic', allowed_domains: ['synthetic.invalid'] },
    new ClaudeMonitorToolUseMessage(timestamp, 'synthetic-tool', 'Synthetic session watch', 300_000,
      'printf synthetic', undefined, undefined, true, ['synthetic.invalid'])],
  ['Monitor', { description: 'Synthetic socket watch', timeout_ms: 300_000,
    ws: { url: 'ws://synthetic.invalid/events', protocols: ['synthetic-events'] } },
    new ClaudeMonitorToolUseMessage(timestamp, 'synthetic-tool', 'Synthetic socket watch', 300_000,
      undefined, 'ws://synthetic.invalid/events', ['synthetic-events'])],
];

describe('Claude discovery and Monitor conversion', () => {
  it.each(examples)('normalizes %s consistently for live, reload, and permissions', (name, input, expected) => {
    const part = { type: 'tool_use', id: 'synthetic-tool', name, input };
    expect(convertClaudeToolUse(timestamp, part)).toEqual(expected);
    const native = { type: 'assistant', uuid: 'synthetic-row', timestamp,
      message: { role: 'assistant', content: [part] } };
    expect(convertClaudeEntries([native])).toEqual([expected]);
    expect(convertCLIMessageToChatMessages(native).map((message) => ({ ...message, timestamp }))).toEqual([expected]);
    const permission = convertClaudePermissionRequest(timestamp, 'synthetic-permission', {
      subtype: 'can_use_tool', tool_name: name, tool_use_id: part.id, input,
    });
    expect(permission.requestedTool).toEqual(expected);
  });

  it.each([{ values: [] }, { values: ['', ' ', 'synthetic-events', 7] }])(
    'preserves string-only Monitor arrays for live, reload, and permissions: $values', ({ values }) => {
      const input = { description: 'Synthetic watch', command: 'printf synthetic', persistent: false,
        allowed_domains: values, ws: { protocols: values } };
      const expected = { persistent: false,
        allowedDomains: values.filter((value) => typeof value === 'string'),
        webSocketProtocols: values.filter((value) => typeof value === 'string') };
      const part = { type: 'tool_use', name: 'Monitor', id: 'synthetic-tool', input };
      const native = { type: 'assistant', uuid: 'synthetic-row', timestamp,
        message: { role: 'assistant', content: [part] } };
      expect(convertClaudeToolUse(timestamp, part)).toMatchObject(expected);
      expect(convertClaudeEntries([native])[0]).toMatchObject(expected);
      expect(convertCLIMessageToChatMessages(native)[0]).toMatchObject(expected);
      expect(convertClaudePermissionRequest(timestamp, 'synthetic-permission', {
        subtype: 'can_use_tool', tool_name: 'Monitor', tool_use_id: part.id, input,
      }).requestedTool).toMatchObject(expected);
    });

  it.each(['ToolSearch', 'Monitor'])('keeps rejected %s calls typed with absent or malformed input', (name) => {
    for (const input of [undefined, null, {}, { query: 3, description: [], timeout_ms: Infinity, max_results: NaN }, 'invalid']) {
      const converted = convertClaudeToolUse(timestamp, { name, id: 'synthetic-tool', input });
      expect(converted).toBeInstanceOf(name === 'Monitor' ? ClaudeMonitorToolUseMessage : ClaudeToolSearchToolUseMessage);
      expect(converted.timeoutMs).toBeUndefined();
      expect(converted.maxResults).toBeUndefined();
    }
  });

  it('preserves both command and socket display fields without enforcing native exclusivity', () => {
    expect(convertClaudeToolUse(timestamp, { name: 'Monitor', input: {
      command: 'printf synthetic', timeout_ms: -0.5,
      ws: { url: 'ws://synthetic.invalid', protocols: ['synthetic', 5] },
    } })).toMatchObject({ command: 'printf synthetic', timeoutMs: -0.5,
      webSocketUrl: 'ws://synthetic.invalid', webSocketProtocols: ['synthetic'] });
  });
});

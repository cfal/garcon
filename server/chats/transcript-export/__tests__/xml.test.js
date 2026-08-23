import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { renderTranscriptExportXml } from '../xml.ts';

const AT = '2026-08-23T00:00:00.000Z';

describe('XML transcript export', () => {
  it('uses explicit user and assistant elements with preserved ordinals', () => {
    const document = renderTranscriptExportXml(model([
      entry(1, 'conversation', new UserMessage(AT, 'Prompt & <context>')),
      entry(4, 'conversation', new AssistantMessage(AT, 'Answer ]]> complete')),
    ]));

    expect(document).toContain('<user ordinal="1" category="conversation"');
    expect(document).toContain('<text>Prompt &amp; &lt;context&gt;</text>');
    expect(document).toContain('<assistant ordinal="4" category="conversation"');
    expect(document).toContain('<text>Answer ]]&gt; complete</text>');
    expect(document.endsWith('\n')).toBe(true);
    expect(document.endsWith('\n\n')).toBe(false);
  });

  it('escapes XML-illegal controls and malformed Unicode before metacharacters', () => {
    const malformed = `nul:${String.fromCharCode(0)} esc:${String.fromCharCode(27)} surrogate:${String.fromCharCode(0xd800)} &`;
    const document = renderTranscriptExportXml(model([
      entry(2, 'conversation', new AssistantMessage(AT, malformed)),
    ]));

    expect(document).toContain('nul:\\u0000 esc:\\u001b surrogate:� &amp;');
    expect(document).not.toContain(String.fromCharCode(0));
    expect(document).not.toContain(String.fromCharCode(27));
  });

  it('preserves XML-normalized whitespace through character references', () => {
    const document = renderTranscriptExportXml(model([
      entry(2, 'conversation', new AssistantMessage(AT, 'answer\rwith carriage')),
      entry(3, 'tool-calls', new BashToolUseMessage(AT, 'tool\t\r\n1', 'pwd')),
      entry(4, 'conversation', new UserMessage(AT, 'prompt', [{
        name: 'capture\t\r\n.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,secret',
      }])),
    ]));

    expect(document).toContain('<text>answer&#13;with carriage</text>');
    expect(document).toContain('tool-id="tool&#9;&#13;&#10;1"');
    expect(document).toContain('name="capture&#9;&#13;&#10;.png"');
  });

  it('renders typed tool elements and image metadata without body payloads', () => {
    const document = renderTranscriptExportXml(model([
      entry(1, 'conversation', new UserMessage(AT, 'Prompt', [{
        name: 'capture.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,secret',
      }])),
      entry(3, 'tool-calls', new BashToolUseMessage(AT, 'tool-1', 'pwd')),
    ], {
      totalEntryCount: 3,
      exclusions: ['reasoning'],
      omitted: [{ category: 'reasoning', count: 1 }],
    }));

    expect(document).toContain('<exclusion category="reasoning" omitted="1"/>');
    expect(document).toContain('<image name="capture.png" media-type="image/png" encoded-bytes="28"/>');
    expect(document).toContain('<tool-call ordinal="3" category="tool-calls"');
    expect(document).toContain('type="bash-tool-use"');
    expect(document).toContain('tool-id="tool-1"');
    expect(document).not.toContain('data:image/png;base64,secret');
  });

  it('preserves structured data syntax that is not a data URL', () => {
    const yaml = [
      'apiVersion: v1',
      'metadata:',
      '  name: fixture',
      'data:',
      '  key: value',
      'script: |',
      '  const record = { data: value };',
    ].join('\n');
    const document = renderTranscriptExportXml(model([
      entry(2, 'tool-calls', new BashToolUseMessage(AT, 'tool-1', yaml)),
    ]));

    expect(document).toContain(`<field name="command">${yaml}</field>`);
    expect(document).not.toContain('[data URL omitted from export]');
  });

  it('redacts data URLs at the start of diff lines', () => {
    const diff = [
      '@@ -1 +1 @@',
      '-data:image/png;base64,removed-secret',
      '+data:image/png;base64,added-secret',
    ].join('\n');
    const document = renderTranscriptExportXml(model([
      entry(2, 'tool-calls', new BashToolUseMessage(AT, 'tool-1', diff)),
    ]));

    expect(document.match(/\[data URL omitted from export\]/g)).toHaveLength(2);
    expect(document).not.toContain('removed-secret');
    expect(document).not.toContain('added-secret');
  });
});

function entry(ordinal, category, message) {
  return { kind: 'message', ordinal, category, message };
}

function model(entries, overrides = {}) {
  return {
    chat: {
      id: '1787505989127000',
      title: 'Export fixture',
      agentId: 'codex',
      model: 'gpt-test',
      projectPath: '/workspace/project',
    },
    transcriptViewId: 'view-1',
    lastOrdinal: 9,
    generatedAt: AT,
    totalEntryCount: entries.length,
    exclusions: [],
    omitted: [],
    entries,
    ...overrides,
  };
}

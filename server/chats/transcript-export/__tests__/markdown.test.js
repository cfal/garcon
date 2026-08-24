import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  CliRowMessage,
  ToolResultMessage,
  UserMessage,
} from '../../../../common/chat-types.ts';
import { renderTranscriptExportMarkdown } from '../markdown.ts';

const AT = '2026-08-23T00:00:00.000Z';

describe('Markdown transcript export', () => {
  it('renders compact metadata, original ordinals, filtering disclosure, and conversation text', () => {
    const document = renderTranscriptExportMarkdown(model([
      entry(2, 'conversation', new UserMessage(
        AT,
        'Prompt with data:text/plain,authored',
        undefined,
        { clientMessageId: 'private-message-id' },
        { origin: 'cli', style: 'notice', title: 'Presentation only' },
      )),
      entry(7, 'conversation', new AssistantMessage(AT, 'Answer')),
      entry(9, 'diagnostics', new CliRowMessage(
        AT,
        '**Styled operator note**',
        {
          style: 'custom',
          customStyle: { lightAccent: '#123456', darkAccent: '#abcdef' },
        },
        'markdown',
        'Automation checkpoint',
      )),
    ], {
      omitted: [{ category: 'tool-calls', count: 2 }],
    }));

    expect(document).toContain('# Transcript export — Export fixture');
    expect(document).toContain('Chat `1787505989127000` · Agent `codex` · Model `gpt-test`');
    expect(document).toContain('> Omitted: tool-calls 2');
    expect(document).toContain('## [2] User — CLI notice: Presentation only\n');
    expect(document).toContain('Prompt with data:text/plain,authored');
    expect(document).toContain('## [7] Assistant\n');
    expect(document).toContain('## [9] CLI row — CLI custom: Automation checkpoint\n');
    expect(document).toContain('**Styled operator note**');
    expect(document).toContain('- format: `markdown`');
    expect(document).not.toContain('lightAccent');
    expect(document).not.toContain(' — conversation — ');
    expect(document).not.toContain(AT);
    expect(document).not.toContain('private-message-id');
    expect(document.endsWith('\n')).toBe(true);
    expect(document.endsWith('\n\n')).toBe(false);
  });

  it('uses a fence longer than every backtick run in structured values', () => {
    const document = renderTranscriptExportMarkdown(model([
      entry(3, 'tool-results', new ToolResultMessage(AT, 'tool-1', {
        output: 'before\n````\nafter',
      }, false)),
    ]));

    expect(document).toContain('- tool id: `tool-1`');
    expect(document).toContain('`````json\n{"output":"before\\n````\\nafter"}\n`````');
  });

  it('keeps consecutive scalar fields compact and omits an unspecified model', () => {
    const document = renderTranscriptExportMarkdown(model([{
      kind: 'run-ended',
      ordinal: 4,
      category: 'diagnostics',
      at: AT,
      outcome: 'finished',
      origin: 'provider',
    }], {
      chat: {
        id: '1787505989127000',
        title: 'Export fixture',
        agentId: 'codex',
        model: null,
      },
    }));

    expect(document).toContain('Chat `1787505989127000` · Agent `codex`\n');
    expect(document).not.toContain('Model');
    expect(document).toContain('## [4] Run ended\n\n- outcome: `finished`\n- origin: `provider`');
  });

  it('omits image bodies and redacts data URLs only inside structured values', () => {
    const document = renderTranscriptExportMarkdown(model([
      entry(1, 'conversation', new UserMessage(
        AT,
        'The authored text data:image/png;base64,keep is retained.',
        [{ name: 'capture.png', mimeType: 'image/png', data: 'data:image/png;base64,secret' }],
      )),
      entry(
        2,
        'tool-calls',
        new BashToolUseMessage(AT, 'tool-1', 'echo "data:text/plain,embedded-secret"'),
      ),
    ]));

    expect(document).toContain('The authored text data:image/png;base64,keep is retained.');
    expect(document).toContain('[data URL omitted from export]');
    expect(document).toContain('capture.png (image/png, 28 encoded bytes) [body omitted from export]');
    expect(document).not.toContain('data:image/png;base64,secret');
    expect(document).not.toContain('data:text/plain,embedded-secret');
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
    const document = renderTranscriptExportMarkdown(model([
      entry(2, 'tool-calls', new BashToolUseMessage(AT, 'tool-1', yaml)),
    ]));

    expect(document).toContain(yaml);
    expect(document).not.toContain('[data URL omitted from export]');
  });

  it('redacts data URLs at the start of diff lines', () => {
    const diff = [
      '@@ -1 +1 @@',
      '-data:image/png;base64,removed-secret',
      '+data:image/png;base64,added-secret',
    ].join('\n');
    const document = renderTranscriptExportMarkdown(model([
      entry(2, 'tool-calls', new BashToolUseMessage(AT, 'tool-1', diff)),
    ]));

    expect(document.match(/\[data URL omitted from export\]/g)).toHaveLength(2);
    expect(document).not.toContain('removed-secret');
    expect(document).not.toContain('added-secret');
  });

  it('omits structured base64 image blocks from tool results', () => {
    const document = renderTranscriptExportMarkdown(model([
      entry(3, 'tool-results', new ToolResultMessage(AT, 'tool-1', {
        items: [{
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'structured-base64-secret',
          },
        }],
      }, false)),
    ]));

    expect(document).toContain('[image body omitted from export]');
    expect(document).not.toContain('structured-base64-secret');
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
    },
    omitted: [],
    entries,
    ...overrides,
  };
}

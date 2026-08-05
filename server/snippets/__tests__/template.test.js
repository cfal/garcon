import { describe, expect, it } from 'bun:test';
import { SNIPPET_EXPANDED_MAX_LENGTH } from '../../../common/snippets.ts';
import { expandSnippetTemplate } from '../template.ts';

describe('snippet template expansion', () => {
  it('expands all exact markers and preserves multiline arguments', () => {
    expect(
      expandSnippetTemplate(
        'Chat {{chat_id}}: review {{arguments}} in {{project_path}}',
        {
          arguments: 'API\ncontracts',
          projectPath: '/repo',
          chatId: 'chat-a',
        },
      ),
    ).toBe('Chat chat-a: review API\ncontracts in /repo');
  });

  it('keeps escaped, spaced, and unknown markers literal', () => {
    expect(
      expandSnippetTemplate(
        '\\{{arguments}} \\{{chat_id}} {{ arguments }} {{unknown}}',
        {
          arguments: 'ignored',
          projectPath: '/repo',
          chatId: 'chat-a',
        },
      ),
    ).toBe('{{arguments}} {{chat_id}} {{ arguments }} {{unknown}}');
  });

  it('is single-pass for marker-shaped replacement values', () => {
    expect(
      expandSnippetTemplate('{{arguments}}', {
        arguments: '{{project_path}}',
        projectPath: '/repo',
        chatId: 'chat-a',
      }),
    ).toBe('{{project_path}}');
  });

  it('rejects output beyond the configured bound before joining it', () => {
    expect(() =>
      expandSnippetTemplate('{{arguments}}{{arguments}}{{arguments}}', {
        arguments: 'x'.repeat(Math.floor(SNIPPET_EXPANDED_MAX_LENGTH / 2)),
        projectPath: '/repo',
        chatId: 'chat-a',
      }),
    ).toThrow('Expanded snippet exceeds');
  });
});

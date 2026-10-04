import { describe, expect, it } from 'bun:test';
import { SNIPPET_EXPANDED_MAX_LENGTH } from '../../../../common/snippets.ts';
import { expandScheduledSnippetTemplate, expandSnippetTemplate } from '../template.ts';
import { renderScheduledPrompt } from '../../../../common/scheduled-prompts.ts';

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

describe('scheduled snippet template expansion', () => {
  it('expands arguments and paths now and defers active and escaped chat tokens until each run', () => {
    const text = expandScheduledSnippetTemplate('Review {{arguments}} in {{project_path}} for {{chat_id}}; literal \\{{chat_id}}', {
      arguments: 'API\ncontracts', projectPath: '/repo',
    });
    expect(text).toBe('Review API\ncontracts in /repo for {{chat_id}}; literal \\{{chat_id}}');
    for (const chatId of ['1787471053739199', '1787471053739200']) {
      expect(renderScheduledPrompt(text, chatId)).toBe(`Review API\ncontracts in /repo for ${chatId}; literal {{chat_id}}`);
    }
  });

  it('keeps chat-shaped replacement values literal across both expansion phases', () => {
    const text = expandScheduledSnippetTemplate('{{arguments}} / {{project_path}} / {{chat_id}}', {
      arguments: '{{chat_id}} and \\{{chat_id}}', projectPath: '/repo/{{chat_id}}',
    });
    expect(renderScheduledPrompt(text, '1787471053739199')).toBe('{{chat_id}} and \\{{chat_id}} / /repo/{{chat_id}} / 1787471053739199');
  });

  it.each([0, 1, 2, 3])('preserves %i argument and path backslashes across both phases', (count) => {
    const literal = `${'\\'.repeat(count)}{{chat_id}}`;
    const text = expandScheduledSnippetTemplate('{{arguments}} / {{project_path}} / {{chat_id}}', {
      arguments: literal, projectPath: `/repo/${literal}`,
    });
    expect(renderScheduledPrompt(text, '1787471053739199')).toBe(`${literal} / /repo/${literal} / 1787471053739199`);
  });

  it('enforces the expansion length bound', () => {
    expect(() => expandScheduledSnippetTemplate('{{arguments}}{{arguments}}', {
      arguments: 'x'.repeat(SNIPPET_EXPANDED_MAX_LENGTH), projectPath: '/repo',
    })).toThrow('Expanded snippet exceeds');
  });
});

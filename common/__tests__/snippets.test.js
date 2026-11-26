import { describe, expect, it } from 'bun:test';
import {
  SNIPPET_EXPANDED_MAX_LENGTH,
  snippetTemplateUsesChatId,
  snippetTemplateUsesProjectPath,
  normalizeExpandSnippetRequest,
} from '../snippets.js';
import {
  expandScheduledSnippetTemplate,
  expandSnippetTemplate,
  ScheduledSnippetBoundaryError,
  SnippetExpansionError,
} from '../snippet-template.js';
import { TEMPLATE_VALIDATION_VALUES } from '../template-tokens.js';

describe('snippetTemplateUsesProjectPath', () => {
  it('detects an unescaped project path token', () => {
    expect(snippetTemplateUsesProjectPath('Review in {{project_path}}')).toBe(true);
    expect(snippetTemplateUsesProjectPath('{{project_path}}')).toBe(true);
  });

  it('ignores templates without the token', () => {
    expect(snippetTemplateUsesProjectPath('Review {{arguments}}')).toBe(false);
    expect(snippetTemplateUsesProjectPath('No tokens here')).toBe(false);
    expect(snippetTemplateUsesProjectPath('')).toBe(false);
  });

  it('ignores escaped tokens', () => {
    expect(snippetTemplateUsesProjectPath('Keep \\{{project_path}} literal')).toBe(false);
    expect(
      snippetTemplateUsesProjectPath('\\{{project_path}} and {{project_path}}'),
    ).toBe(true);
  });
});

describe('scheduled snippet expansion requests', () => {
  it('accepts a future new chat without inventing a chat ID and preserves executor identity', () => {
    const request = { shortName: 'review', arguments: { type: 'default' }, context: {
      type: 'scheduled-prompt', target: { type: 'new-chat', projectPath: '/repo', executorId: '11111111-1111-4111-8111-111111111111' },
    } };
    expect(normalizeExpandSnippetRequest(request)).toEqual(request);
    expect(normalizeExpandSnippetRequest({ ...request, context: { type: 'scheduled-prompt', target: { type: 'chat', chatId: '1787471053739199' } } })).toMatchObject({ context: { target: { chatId: '1787471053739199' } } });
  });

  it('rejects missing targets, invalid chat IDs, blank paths, and malformed executor IDs', () => {
    for (const target of [null, {}, { type: 'chat', chatId: 'invalid' },
      { type: 'new-chat', projectPath: '' }, { type: 'new-chat', projectPath: '/repo', executorId: 'invalid' }]) {
      expect(normalizeExpandSnippetRequest({ shortName: 'review', arguments: { type: 'default' },
        context: { type: 'scheduled-prompt', target } })).toBeNull();
    }
  });
});

describe('snippetTemplateUsesChatId', () => {
  it('detects only unescaped chat ID tokens', () => {
    expect(snippetTemplateUsesChatId('Send from {{chat_id}}')).toBe(true);
    expect(snippetTemplateUsesChatId('Keep \\{{chat_id}} literal')).toBe(false);
    expect(snippetTemplateUsesChatId('Review {{arguments}}')).toBe(false);
  });
});

describe('shared snippet template expansion', () => {
  it('expands snippet templates and reports oversized expansions with SnippetExpansionError', () => {
    expect(
      expandSnippetTemplate('Review {{arguments}} in {{chat_id}} (\\{{current_date}})', {
        arguments: 'API',
        projectPath: '',
        context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: 'chat-1' },
      }),
    ).toBe('Review API in chat-1 ({{current_date}})');

    expect(() =>
      expandSnippetTemplate('{{arguments}}{{arguments}}', {
        arguments: 'x'.repeat(SNIPPET_EXPANDED_MAX_LENGTH),
        projectPath: '',
        context: TEMPLATE_VALIDATION_VALUES,
      }),
    ).toThrow(SnippetExpansionError);
  });

  it('expands scheduled snippet templates and reports deferred boundary errors', () => {
    expect(
      expandScheduledSnippetTemplate('Review {{arguments}} on {{current_date}}', {
        arguments: '{{chat_id}}',
        projectPath: '',
      }),
    ).toBe('Review \\{{chat_id}} on {{current_date}}');

    expect(() =>
      expandScheduledSnippetTemplate('{{arguments}}{{current_date}}', {
        arguments: 'report\\',
        projectPath: '',
      }),
    ).toThrow(ScheduledSnippetBoundaryError);
  });
});

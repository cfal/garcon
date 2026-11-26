import { describe, expect, it } from 'bun:test';
import { SNIPPET_EXPANDED_MAX_LENGTH } from '../../../../common/snippets.ts';
import { expandScheduledSnippetTemplate, expandSnippetTemplate } from '../template.ts';
import { renderScheduledPrompt } from '../../../../common/scheduled-prompts.ts';
import { TEMPLATE_VALIDATION_VALUES, RUNTIME_TEMPLATE_VARIABLES } from '../../../../common/template-tokens.ts';

describe('snippet template expansion', () => {
  it('expands all exact markers and preserves multiline arguments', () => {
    expect(
      expandSnippetTemplate(
        'Chat {{chat_id}}: review {{arguments}} in {{project_path}}',
        {
          arguments: 'API\ncontracts',
          projectPath: '/repo',
          context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: 'chat-a' },
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
          context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: 'chat-a' },
        },
      ),
    ).toBe('{{arguments}} {{chat_id}} {{ arguments }} {{unknown}}');
  });

  it('is single-pass for marker-shaped replacement values', () => {
    expect(
      expandSnippetTemplate('{{arguments}}', {
        arguments: '{{project_path}}',
        projectPath: '/repo',
        context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: 'chat-a' },
      }),
    ).toBe('{{project_path}}');
  });

  it('rejects output beyond the configured bound before joining it', () => {
    expect(() =>
      expandSnippetTemplate('{{arguments}}{{arguments}}{{arguments}}', {
        arguments: 'x'.repeat(Math.floor(SNIPPET_EXPANDED_MAX_LENGTH / 2)),
        projectPath: '/repo',
        context: { ...TEMPLATE_VALIDATION_VALUES, chat_id: 'chat-a' },
      }),
    ).toThrow('Expanded snippet exceeds');
  });
});

describe('scheduled snippet template expansion', () => {
  it.each(RUNTIME_TEMPLATE_VARIABLES)('rejects joins that create or escape %s', (variable) => {
    for (const [template, argumentsText, projectPath] of [
      [`{{arguments}}{{${variable}}}`, 'report\\', '/repo'],
      [`{{project_path}}{{${variable}}}`, '', 'C:\\'],
      ['{{arguments}}{{project_path}}', '{{', `${variable}}}`],
      [`{{{{arguments}}}}`, variable, '/repo'],
      [`{{${variable}{{arguments}}}}`, '', '/repo'],
      [`{{arguments}}${variable}}}`, '{{', '/repo'],
    ]) {
      expect(() => expandScheduledSnippetTemplate(template, { arguments: argumentsText, projectPath }))
        .toThrow('Add a separator');
    }
    for (const template of [`{{arguments}} {{${variable}}}`, `{{arguments}}\\{{${variable}}}`]) {
      const values = { arguments: 'report\\', projectPath: '/repo', context: TEMPLATE_VALIDATION_VALUES };
      expect(renderScheduledPrompt(expandScheduledSnippetTemplate(template, values), values.context))
        .toBe(expandSnippetTemplate(template, values));
    }
  });
  it('defers both dates, including escapes, until each occurrence', () => {
    const template = '{{current_date}} {{current_date_local}} \\{{current_date}} \\{{current_date_local}} {{current_time}}';
    const text = expandScheduledSnippetTemplate(template, { arguments: '', projectPath: '/repo' });
    expect(text).toBe(template);
    for (const date of ['2030-01-01', '2030-01-02']) {
      const context = { ...TEMPLATE_VALIDATION_VALUES, current_date: date, current_date_local: '2029-12-31' };
      expect(renderScheduledPrompt(text, context)).toBe(`${date} 2029-12-31 {{current_date}} {{current_date_local}} {{current_time}}`);
      expect(expandSnippetTemplate(template, { arguments: '', projectPath: '/repo', context }))
        .toBe(renderScheduledPrompt(text, context));
    }
  });

  it.each([0, 1, 2, 3])('preserves all runtime-shaped replacements with %i backslashes', (count) => {
    const literal = RUNTIME_TEMPLATE_VARIABLES.map(variable => `${'\\'.repeat(count)}{{${variable}}}`).join(' / ');
    const template = '{{arguments}} in {{project_path}}';
    const values = { arguments: literal, projectPath: `/repo/${literal}` };
    const text = expandScheduledSnippetTemplate(template, values);
    expect(renderScheduledPrompt(text, TEMPLATE_VALIDATION_VALUES)).toBe(`${literal} in /repo/${literal}`);
    expect(expandSnippetTemplate(template, { ...values, context: TEMPLATE_VALIDATION_VALUES }))
      .toBe(renderScheduledPrompt(text, TEMPLATE_VALIDATION_VALUES));
  });

  it('expands arguments and paths now and defers active and escaped chat tokens until each run', () => {
    const text = expandScheduledSnippetTemplate('Review {{arguments}} in {{project_path}} for {{chat_id}}; literal \\{{chat_id}}', {
      arguments: 'API\ncontracts', projectPath: '/repo',
    });
    expect(text).toBe('Review API\ncontracts in /repo for {{chat_id}}; literal \\{{chat_id}}');
    for (const chatId of ['1787471053739199', '1787471053739200']) {
      expect(renderScheduledPrompt(text, { ...TEMPLATE_VALIDATION_VALUES, chat_id: chatId })).toBe(`Review API\ncontracts in /repo for ${chatId}; literal {{chat_id}}`);
    }
  });

  it('keeps chat-shaped replacement values literal across both expansion phases', () => {
    const text = expandScheduledSnippetTemplate('{{arguments}} / {{project_path}} / {{chat_id}}', {
      arguments: '{{chat_id}} and \\{{chat_id}}', projectPath: '/repo/{{chat_id}}',
    });
    expect(renderScheduledPrompt(text, { ...TEMPLATE_VALIDATION_VALUES, chat_id: '1787471053739199' })).toBe('{{chat_id}} and \\{{chat_id}} / /repo/{{chat_id}} / 1787471053739199');
  });

  it.each([0, 1, 2, 3])('preserves %i argument and path backslashes across both phases', (count) => {
    const literal = `${'\\'.repeat(count)}{{chat_id}}`;
    const text = expandScheduledSnippetTemplate('{{arguments}} / {{project_path}} / {{chat_id}}', {
      arguments: literal, projectPath: `/repo/${literal}`,
    });
    expect(renderScheduledPrompt(text, { ...TEMPLATE_VALIDATION_VALUES, chat_id: '1787471053739199' })).toBe(`${literal} / /repo/${literal} / 1787471053739199`);
  });

  it('enforces the expansion length bound', () => {
    expect(() => expandScheduledSnippetTemplate('{{arguments}}{{arguments}}', {
      arguments: 'x'.repeat(SNIPPET_EXPANDED_MAX_LENGTH), projectPath: '/repo',
    })).toThrow('Expanded snippet exceeds');
  });
});

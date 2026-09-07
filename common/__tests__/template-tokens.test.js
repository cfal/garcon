import { describe, expect, it } from 'bun:test';
import {
  expandTemplate,
  matchTemplateTokens,
  TemplateExpansionTooLongError,
} from '../template-tokens.js';

const VARIABLES = ['chat_id', 'project_path'];

describe('template tokens', () => {
  it('matches only exact allowed variables and reports escapes', () => {
    expect(
      Array.from(
        matchTemplateTokens(
          '{{chat_id}} \\{{project_path}} {{arguments}} {{ chat_id }}',
          VARIABLES,
        ),
      ),
    ).toEqual([
      { index: 0, raw: '{{chat_id}}', variable: 'chat_id', escaped: false },
      {
        index: 12,
        raw: '\\{{project_path}}',
        variable: 'project_path',
        escaped: true,
      },
    ]);
  });

  it('expands in one pass while preserving unknown tokens', () => {
    expect(
      expandTemplate(
        '{{chat_id}} \\{{chat_id}} {{arguments}}',
        ['chat_id'],
        { chat_id: '{{project_path}}' },
        100,
      ),
    ).toBe('{{project_path}} {{chat_id}} {{arguments}}');
  });

  it('rejects output beyond the configured limit', () => {
    expect(() =>
      expandTemplate('{{chat_id}}', ['chat_id'], { chat_id: '1234' }, 3),
    ).toThrow(TemplateExpansionTooLongError);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  expandTemplate,
  matchTemplateTokens,
  TemplateExpansionTooLongError,
  RUNTIME_TEMPLATE_VARIABLES,
  runtimeTemplateValues,
} from '../template-tokens.js';
import { renderPreambleContent } from '../preambles.js';
import { renderScheduledPrompt } from '../scheduled-prompts.js';

const VARIABLES = ['chat_id', 'project_path'];

describe('controller date templates', () => {
  it.each([
    ['America/Los_Angeles', '2030-01-01T00:30:00.000Z', '2030-01-01', '2029-12-31'],
    ['Pacific/Kiritimati', '2028-02-29T23:30:00.000Z', '2028-02-29', '2028-03-01'],
    ['UTC', '2028-02-29T00:00:00.000Z', '2028-02-29', '2028-02-29'],
  ])('formats UTC and controller-local dates in %s', (timezone, instant, utcDate, localDate) => {
    const original = process.env.TZ;
    try {
      process.env.TZ = timezone;
      const values = runtimeTemplateValues('1000000000000001', new Date(instant));
      expect(values).toEqual({ chat_id: '1000000000000001', current_date: utcDate, current_date_local: localDate });
      for (const render of [renderScheduledPrompt, renderPreambleContent]) {
        expect(render('{{current_date}} {{current_date_local}} {{current_date}} \\{{current_date}} \\{{current_date_local}} {{current_time}} {{ current_date }}', values))
          .toBe(`${utcDate} ${localDate} ${utcDate} {{current_date}} {{current_date_local}} {{current_time}} {{ current_date }}`);
      }
      for (const key of ['current_date', 'current_date_local']) {
        expect(values[key]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('does not recursively expand replacement values', () => {
    expect(expandTemplate('{{chat_id}}', RUNTIME_TEMPLATE_VARIABLES, {
      chat_id: '{{current_date}}', current_date: '2030-01-01', current_date_local: '2029-12-31',
    }, 100)).toBe('{{current_date}}');
  });
});

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

import { describe, expect, it } from 'bun:test';

import { parseInitSlashCommands } from '../claude/slash-command-discovery.js';

describe('parseInitSlashCommands', () => {
  it('tags names present in skills as skills and others as commands', () => {
    const result = parseInitSlashCommands(
      ['clear', 'compact', 'dogfood', 'pm-pr'],
      ['dogfood', 'pm-pr'],
    );
    expect(result).toEqual([
      { name: 'clear', source: 'command' },
      { name: 'compact', source: 'command' },
      { name: 'dogfood', source: 'skill' },
      { name: 'pm-pr', source: 'skill' },
    ]);
  });

  it('sorts commands alphabetically', () => {
    const result = parseInitSlashCommands(['zeta', 'alpha', 'mike'], []);
    expect(result.map((c) => c.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('ignores non-string and missing values', () => {
    expect(parseInitSlashCommands(undefined, undefined)).toEqual([]);
    expect(parseInitSlashCommands([1, 'ok', null, {}], 'nope')).toEqual([
      { name: 'ok', source: 'command' },
    ]);
  });
});

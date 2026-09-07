import { describe, expect, it } from 'bun:test';
import {
  HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
  HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
  dedupeHiddenBashCommandPatterns,
  parseHiddenBashCommandPatterns,
  validateHiddenBashCommandPattern,
} from '../hidden-bash-command-patterns.js';

describe('hidden bash command patterns', () => {
  it('parses valid regex and glob entries without changing their text', () => {
    expect(parseHiddenBashCommandPatterns([
      { pattern: '^git (status|log)', mode: 'regex' },
      { pattern: '  cargo *  ', mode: 'glob' },
    ])).toEqual([
      { pattern: '^git (status|log)', mode: 'regex' },
      { pattern: '  cargo *  ', mode: 'glob' },
    ]);
  });

  it('deduplicates exact entries globally while preserving first occurrence order', () => {
    const patterns = [
      { pattern: 'git *', mode: 'glob' },
      { pattern: '^cargo', mode: 'regex' },
      { pattern: 'git *', mode: 'glob' },
      { pattern: 'git *', mode: 'regex' },
      { pattern: '^cargo', mode: 'regex' },
    ];

    expect(dedupeHiddenBashCommandPatterns(patterns)).toEqual([
      { pattern: 'git *', mode: 'glob' },
      { pattern: '^cargo', mode: 'regex' },
      { pattern: 'git *', mode: 'regex' },
    ]);
    expect(parseHiddenBashCommandPatterns(patterns)).toEqual([
      { pattern: 'git *', mode: 'glob' },
      { pattern: '^cargo', mode: 'regex' },
      { pattern: 'git *', mode: 'regex' },
    ]);
  });

  it('rejects malformed lists and entries', () => {
    const invalidValues = [
      undefined,
      'git *',
      [null],
      [['git *']],
      [{}],
      [{ pattern: 42, mode: 'glob' }],
      [{ pattern: 'git *', mode: 'shell' }],
      [{ pattern: '', mode: 'glob' }],
      [{ pattern: '   ', mode: 'regex' }],
      [{ pattern: '([unclosed', mode: 'regex' }],
    ];

    for (const value of invalidValues) {
      expect(parseHiddenBashCommandPatterns(value)).toBeNull();
    }
  });

  it('enforces raw list and pattern length limits at their boundaries', () => {
    const boundaryPatterns = Array.from(
      { length: HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT },
      (_, index) => ({ pattern: `command-${index}`, mode: 'glob' }),
    );
    expect(parseHiddenBashCommandPatterns(boundaryPatterns)).toHaveLength(
      HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
    );
    expect(parseHiddenBashCommandPatterns([
      { pattern: 'x'.repeat(HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH), mode: 'glob' },
    ])).not.toBeNull();

    expect(parseHiddenBashCommandPatterns([
      ...boundaryPatterns,
      { ...boundaryPatterns[0] },
    ])).toBeNull();
    expect(parseHiddenBashCommandPatterns([
      { pattern: 'x'.repeat(HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH + 1), mode: 'glob' },
    ])).toBeNull();
  });

  it('reports validation failures by cause', () => {
    expect(validateHiddenBashCommandPattern(' ', 'glob')).toBe('empty');
    expect(
      validateHiddenBashCommandPattern(
        'x'.repeat(HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH + 1),
        'glob',
      ),
    ).toBe('too-long');
    expect(validateHiddenBashCommandPattern('([unclosed', 'regex')).toBe('invalid-regex');
    expect(validateHiddenBashCommandPattern('git *', 'glob')).toBe('ok');
  });
});

export const HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES = ['regex', 'glob'] as const;

export const HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT = 200;
export const HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH = 1_000;

export type HiddenBashCommandPatternMode =
  (typeof HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES)[number];

export interface HiddenBashCommandPattern {
  pattern: string;
  mode: HiddenBashCommandPatternMode;
}

export type HiddenBashCommandPatternValidation =
  | 'ok'
  | 'empty'
  | 'too-long'
  | 'invalid-regex';

export function isHiddenBashCommandPatternMode(
  value: unknown,
): value is HiddenBashCommandPatternMode {
  return (
    typeof value === 'string'
    && HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES.includes(value as HiddenBashCommandPatternMode)
  );
}

export function validateHiddenBashCommandPattern(
  pattern: string,
  mode: HiddenBashCommandPatternMode,
): HiddenBashCommandPatternValidation {
  if (pattern.trim().length === 0) return 'empty';
  if (pattern.length > HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH) return 'too-long';
  if (mode === 'regex') {
    try {
      new RegExp(pattern);
    } catch {
      return 'invalid-regex';
    }
  }
  return 'ok';
}

export function dedupeHiddenBashCommandPatterns(
  patterns: readonly HiddenBashCommandPattern[],
): HiddenBashCommandPattern[] {
  const seenByMode: Record<HiddenBashCommandPatternMode, Set<string>> = {
    regex: new Set(),
    glob: new Set(),
  };
  const result: HiddenBashCommandPattern[] = [];
  for (const entry of patterns) {
    const seen = seenByMode[entry.mode];
    if (seen.has(entry.pattern)) continue;
    seen.add(entry.pattern);
    result.push({ pattern: entry.pattern, mode: entry.mode });
  }
  return result;
}

export function parseHiddenBashCommandPatterns(
  value: unknown,
): HiddenBashCommandPattern[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT) return null;

  const parsed: HiddenBashCommandPattern[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { pattern, mode } = entry as Record<string, unknown>;
    if (typeof pattern !== 'string') return null;
    if (!isHiddenBashCommandPatternMode(mode)) return null;
    if (validateHiddenBashCommandPattern(pattern, mode) !== 'ok') return null;
    parsed.push({ pattern, mode });
  }
  return dedupeHiddenBashCommandPatterns(parsed);
}

import { BashToolUseMessage } from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';

export type HiddenBashCommandPatternMode = 'regex' | 'glob';

export const HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES: readonly HiddenBashCommandPatternMode[] = [
	'regex',
	'glob',
];

export interface HiddenBashCommandPattern {
	pattern: string;
	mode: HiddenBashCommandPatternMode;
}

export function isHiddenBashCommandPatternMode(value: unknown): value is HiddenBashCommandPatternMode {
	return (
		typeof value === 'string' &&
		HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES.includes(value as HiddenBashCommandPatternMode)
	);
}

export type HiddenBashCommandPatternValidation = 'ok' | 'empty' | 'invalid-regex';

export type BashCommandMatcher = (command: string) => boolean;

// Globs match the whole command: '*' spans any characters including
// newlines, '?' matches a single character, everything else is literal.
// The u flag makes '?' match one code point so astral characters count
// as a single character.
function globToRegExp(pattern: string): RegExp {
	let source = '^';
	for (const character of pattern) {
		if (character === '*') source += '[\\s\\S]*';
		else if (character === '?') source += '[\\s\\S]';
		else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`${source}$`, 'u');
}

// Regexes match substrings, grep-style; callers anchor explicitly when
// they need whole-command matching.
function compilePattern({ pattern, mode }: HiddenBashCommandPattern): RegExp | null {
	if (pattern.length === 0) return null;
	try {
		return mode === 'regex' ? new RegExp(pattern) : globToRegExp(pattern);
	} catch {
		return null;
	}
}

export function validateHiddenBashCommandPattern(
	pattern: string,
	mode: HiddenBashCommandPatternMode,
): HiddenBashCommandPatternValidation {
	if (pattern.trim().length === 0) return 'empty';
	if (mode === 'regex') {
		try {
			new RegExp(pattern);
		} catch {
			return 'invalid-regex';
		}
	}
	return 'ok';
}

export function normalizeHiddenBashCommandPatterns(value: unknown): HiddenBashCommandPattern[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const patterns: HiddenBashCommandPattern[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) continue;
		const { pattern, mode } = entry as { pattern?: unknown; mode?: unknown };
		if (typeof pattern !== 'string' || pattern.trim().length === 0) continue;
		if (!isHiddenBashCommandPatternMode(mode)) continue;
		const key = `${mode}:${pattern}`;
		if (seen.has(key)) continue;
		seen.add(key);
		patterns.push({ pattern, mode });
	}
	return patterns;
}

// Compiles once per semantic settings change so the returned reference is
// stable for projection inputs that recompute on row churn; null means no
// valid pattern is configured and callers skip command filtering entirely.
export function compileHiddenBashCommandPatterns(
	patterns: readonly HiddenBashCommandPattern[],
): BashCommandMatcher | null {
	const compiled = patterns
		.map(compilePattern)
		.filter((regex): regex is RegExp => regex !== null);
	if (compiled.length === 0) return null;
	return (command) => compiled.some((regex) => regex.test(command));
}

export function isHiddenBashToolUse(
	message: ChatMessage | undefined,
	matchesHiddenBashCommand: BashCommandMatcher,
): boolean {
	return message instanceof BashToolUseMessage && matchesHiddenBashCommand(message.command);
}

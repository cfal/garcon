import { BashToolUseMessage } from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import {
	HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
	HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
	HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES,
	dedupeHiddenBashCommandPatterns,
	isHiddenBashCommandPatternMode,
	validateHiddenBashCommandPattern,
} from '$shared/hidden-bash-command-patterns';
import type {
	HiddenBashCommandPattern,
	HiddenBashCommandPatternMode,
	HiddenBashCommandPatternValidation,
} from '$shared/hidden-bash-command-patterns';

export {
	HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT,
	HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH,
	HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES,
	dedupeHiddenBashCommandPatterns,
	isHiddenBashCommandPatternMode,
	validateHiddenBashCommandPattern,
};
export type {
	HiddenBashCommandPattern,
	HiddenBashCommandPatternMode,
	HiddenBashCommandPatternValidation,
};

export interface HiddenBashCommandPatternPreset {
	id: 'garcon-amp';
	patterns: readonly HiddenBashCommandPattern[];
}

export const HIDDEN_BASH_COMMAND_PATTERN_PRESETS = [
	{
		id: 'garcon-amp',
		patterns: [
			{
				pattern:
					'^/tmp/garcon-amp-[0-9]+/(?:oracle|finder|librarian|reporter)(?:\\s|$)',
				mode: 'regex',
			},
			{
				pattern: '^\\./(?:oracle|finder|librarian|reporter)(?:\\s|$)',
				mode: 'regex',
			},
		],
	},
] as const satisfies readonly HiddenBashCommandPatternPreset[];

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

function hiddenBashCommandPatternsEqual(
	left: readonly HiddenBashCommandPattern[],
	right: readonly HiddenBashCommandPattern[],
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) => entry.mode === right[index].mode && entry.pattern === right[index].pattern,
		)
	);
}

export function createHiddenBashCommandMatcherCache(): (
	patterns: readonly HiddenBashCommandPattern[],
) => BashCommandMatcher | null {
	let previousPatterns: HiddenBashCommandPattern[] | null = null;
	let matcher: BashCommandMatcher | null = null;

	return (patterns) => {
		if (!previousPatterns || !hiddenBashCommandPatternsEqual(previousPatterns, patterns)) {
			previousPatterns = patterns.map((entry) => ({ ...entry }));
			matcher = compileHiddenBashCommandPatterns(patterns);
		}
		return matcher;
	};
}

export function isHiddenBashToolUse(
	message: ChatMessage | undefined,
	matchesHiddenBashCommand: BashCommandMatcher,
): boolean {
	return message instanceof BashToolUseMessage && matchesHiddenBashCommand(message.command);
}

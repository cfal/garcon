import { compileHiddenBashCommandPatterns, type BashCommandMatcher } from '$shared/transcript-display-matcher.js';
export { compileHiddenBashCommandPatterns, type BashCommandMatcher };
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

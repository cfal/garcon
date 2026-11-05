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

// Slash-command trigger detection for the chat composer. A slash command is
// only valid as the leading token of the message (Claude-style), so the menu
// triggers when the entire text before the caret is "/" followed by an
// unbroken command token. Typing whitespace ends the command and closes it.

import type { SlashCommand } from '$shared/slash-commands';
import { hasLeadingSlashCommand } from '$shared/scheduled-prompts';
import { parseScheduleDuration, type ScheduleDurationError } from '$shared/schedule-duration';

// Built-in commands surfaced in the composer menu even when agent discovery
// misses them. Each command is handled by its owning submit or runtime path.
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'compact',
		source: 'command',
		description: 'Summarize the conversation to free up context',
	},
	{
		name: 'fork',
		source: 'command',
		description: 'Fork the conversation into a new chat',
	},
	{
		name: 'in',
		source: 'command',
		description: 'Schedule a prompt in this chat after a delay',
	},
	{
		name: 'rename',
		source: 'command',
		description: 'Rename the current chat',
	},
	{
		name: 'goal',
		source: 'command',
		description: 'Set a Codex goal and start working toward it',
	},
	{
		name: 'steer',
		source: 'command',
		description: 'Send guidance to the active Codex turn immediately',
	},
];

export interface SlashCommandTrigger {
	start: number;
	end: number;
	query: string;
}

export interface SlashCommandReplacement {
	text: string;
	caret: number;
}

const SLASH_TRIGGER_RE = /^\/([a-zA-Z0-9:_-]*)$/;

export function findSlashCommandTrigger(value: string, caret: number): SlashCommandTrigger | null {
	const boundedCaret = Math.max(0, Math.min(caret, value.length));
	const prefix = value.slice(0, boundedCaret);
	const match = prefix.match(SLASH_TRIGGER_RE);
	if (!match) return null;
	return {
		start: 0,
		end: boundedCaret,
		query: match[1] ?? '',
	};
}

// Replaces the trigger range with the selected command plus a trailing space.
// The space ends the command token so the menu closes and the user can type
// arguments.
export function applySlashCommand(
	value: string,
	trigger: SlashCommandTrigger,
	name: string,
): SlashCommandReplacement {
	const token = `/${name} `;
	const after = value.slice(trigger.end);
	const text = `${token}${after}`;
	return {
		text,
		caret: token.length,
	};
}

export interface CompactCommand {
	instructions: string;
}

export type SteerCommandParseResult =
	| { kind: 'not-command' }
	| { kind: 'invalid' }
	| { kind: 'valid'; prompt: string };

const STEER_COMMAND_RE = /^\s*\/steer(?=\s|$)(?:\s+([\s\S]*))?$/i;

export function parseSteerCommand(input: string): SteerCommandParseResult {
	const match = STEER_COMMAND_RE.exec(input);
	if (!match) return { kind: 'not-command' };
	const prompt = (match[1] ?? '').trim();
	if (!prompt) return { kind: 'invalid' };
	return { kind: 'valid', prompt };
}

export function isCodexGoalCommand(input: string): boolean {
	return /^\s*\/goal(?=\s|$)/i.test(input);
}

const COMPACT_COMMAND_RE = /^\s*\/compact(?:\s+([\s\S]*))?$/i;

// Recognizes a submitted `/compact` command, capturing any focus instructions.
// The composer routes a match to the agent's compaction flow instead of sending
// it as an ordinary message.
export function parseCompactCommand(input: string): CompactCommand | null {
	const match = COMPACT_COMMAND_RE.exec(input);
	if (!match) return null;
	return { instructions: (match[1] ?? '').trim() };
}

export interface RenameCommand {
	title: string;
}

const RENAME_COMMAND_RE = /^\s*\/rename(?=\s|$)(?:\s+([\s\S]*))?$/i;

// Recognizes the local rename command so it never reaches an agent or queue.
export function parseRenameCommand(input: string): RenameCommand | null {
	const match = RENAME_COMMAND_RE.exec(input);
	if (!match) return null;
	return { title: (match[1] ?? '').trim() };
}

export type ScheduleInCommandError =
	| ScheduleDurationError
	| 'prompt-required'
	| 'slash-prompt-unsupported';

export type ScheduleInCommandParseResult =
	| { kind: 'not-command' }
	| { kind: 'invalid'; error: ScheduleInCommandError }
	| {
			kind: 'valid';
			duration: string;
			delayMinutes: number;
			prompt: string;
	  };

const IN_COMMAND_RE = /^\s*\/in(?=\s|$)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

export function parseScheduleInCommand(input: string): ScheduleInCommandParseResult {
	const match = IN_COMMAND_RE.exec(input);
	if (!match) return { kind: 'not-command' };
	const durationToken = match[1] ?? '';
	const duration = parseScheduleDuration(durationToken);
	if (!duration.ok) return { kind: 'invalid', error: duration.error };
	const prompt = (match[2] ?? '').trim();
	if (!prompt) return { kind: 'invalid', error: 'prompt-required' };
	if (hasLeadingSlashCommand(prompt)) {
		return { kind: 'invalid', error: 'slash-prompt-unsupported' };
	}
	return {
		kind: 'valid',
		duration: durationToken,
		delayMinutes: duration.minutes,
		prompt,
	};
}

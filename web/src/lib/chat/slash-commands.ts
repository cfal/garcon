// Slash-command trigger detection for the chat composer. A slash command is
// only valid as the leading token of the message (Claude-style), so the menu
// triggers when the entire text before the caret is "/" followed by an
// unbroken command token. Typing whitespace ends the command and closes it.

import type { SlashCommand } from '$shared/slash-commands';

// Client-side built-in commands surfaced in the composer menu regardless of the
// active agent or discovery success. Unlike agent-discovered commands these are
// intercepted on submit (see parseCompactCommand) rather than sent as prose.
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'compact',
		source: 'command',
		description: 'Summarize the conversation to free up context',
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

const COMPACT_COMMAND_RE = /^\s*\/compact(?:\s+([\s\S]*))?$/i;

// Recognizes a submitted `/compact` command, capturing any focus instructions.
// The composer routes a match to the agent's compaction flow instead of sending
// it as an ordinary message.
export function parseCompactCommand(input: string): CompactCommand | null {
	const match = COMPACT_COMMAND_RE.exec(input);
	if (!match) return null;
	return { instructions: (match[1] ?? '').trim() };
}

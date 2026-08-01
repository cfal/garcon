// Slash-command trigger detection for the chat composer. A slash command is
// only valid as the leading token of the message (Claude-style), so the menu
// triggers when the entire text before the caret is "/" followed by an
// unbroken command token. Typing whitespace ends the command and closes it.

import type { SlashCommand } from '$shared/slash-commands';
import { hasLeadingSlashCommand } from '$shared/scheduled-prompts';
import { parseScheduleDuration, type ScheduleDurationError } from '$shared/schedule-duration';
import { SNIPPET_SHORT_NAME_PATTERN } from '$shared/snippets';
import type { ChatOrderBoundary } from '$shared/chat-order-contracts';
import { normalizeTags } from '$shared/tags';

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
		name: 'move',
		source: 'command',
		description: 'Move this chat to the top or bottom of its section in Manual order',
	},
	{
		name: 'tag',
		source: 'command',
		description: 'Add or remove tags on this chat',
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
	{
		name: 's',
		source: 'command',
		description: 'Short alias for /snippet',
	},
	{
		name: 'snippet',
		source: 'command',
		description: 'Expand a saved snippet into the composer',
	},
];

export const SNIPPET_SLASH_COMMAND_NAMES = ['s', 'snippet'] as const;
const SNIPPET_SLASH_COMMAND_NAME_SET: ReadonlySet<string> = new Set(SNIPPET_SLASH_COMMAND_NAMES);

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

export type MoveChatBoundaryCommandParseResult =
	| { kind: 'not-command' }
	| { kind: 'invalid'; error: 'arguments-not-supported' }
	| { kind: 'valid'; boundary: ChatOrderBoundary };

const MOVE_CHAT_BOUNDARY_RE = /^\s*\/move(?=\s|$)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

export function parseMoveChatBoundaryCommand(input: string): MoveChatBoundaryCommandParseResult {
	const match = MOVE_CHAT_BOUNDARY_RE.exec(input);
	if (!match) return { kind: 'not-command' };
	if (/[\r\n]/.test(input)) return { kind: 'invalid', error: 'arguments-not-supported' };
	const boundary = (match[1] ?? '').toLowerCase();
	if ((boundary !== 'top' && boundary !== 'bottom') || (match[2] ?? '').trim()) {
		return { kind: 'invalid', error: 'arguments-not-supported' };
	}
	return {
		kind: 'valid',
		boundary,
	};
}

export type TagCommandParseResult =
	| { kind: 'not-command' }
	| { kind: 'invalid' }
	| { kind: 'valid'; action: 'add' | 'rm'; tags: string[] };

const TAG_COMMAND_RE = /^\s*\/tag(?=\s|$)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i;

export function parseTagCommand(input: string): TagCommandParseResult {
	const match = TAG_COMMAND_RE.exec(input);
	if (!match) return { kind: 'not-command' };
	const action = (match[1] ?? '').toLowerCase();
	if (action !== 'add' && action !== 'rm') return { kind: 'invalid' };
	const tags = normalizeTags((match[2] ?? '').split(/\s+/));
	if (tags.length === 0) return { kind: 'invalid' };
	return { kind: 'valid', action, tags };
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

export type SnippetCommandParseResult =
	| { kind: 'not-command' }
	| { kind: 'invalid'; error: 'short-name-required' | 'invalid-short-name' }
	| { kind: 'valid'; shortName: string; arguments: string };

export function parseSnippetCommand(input: string): SnippetCommandParseResult {
	const command = /^\/(\S+)(?=\s|$)/.exec(input);
	if (!command) return { kind: 'not-command' };
	if (!SNIPPET_SLASH_COMMAND_NAME_SET.has(command[1])) return { kind: 'not-command' };
	const afterCommand = input.slice(command[0].length);
	const nameSeparator = /^\s+/.exec(afterCommand);
	if (!nameSeparator) return { kind: 'invalid', error: 'short-name-required' };
	const afterSeparator = afterCommand.slice(nameSeparator[0].length);
	const name = /^\S+/.exec(afterSeparator);
	const shortName = name?.[0] ?? '';
	if (!shortName) return { kind: 'invalid', error: 'short-name-required' };
	if (!SNIPPET_SHORT_NAME_PATTERN.test(shortName)) {
		return { kind: 'invalid', error: 'invalid-short-name' };
	}
	const remainder = afterSeparator.slice(shortName.length);
	return {
		kind: 'valid',
		shortName,
		arguments: remainder ? remainder.slice(1) : '',
	};
}

// Composer slash-command contract. Slash commands are line-leading tokens (for
// example `/compact`) that trigger a built-in behavior instead of being sent to
// the agent as ordinary prose. This module owns the registry, the composer
// trigger detection that drives the autocomplete menu, and the parsers used to
// recognize a submitted command.

export interface SlashCommand {
	name: string;
	hint: string;
	description: string;
}

// Registry of user-typed slash commands surfaced in the composer menu.
export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'compact',
		hint: '/compact [focus]',
		description: 'Summarize the conversation to free up context',
	},
];

export interface SlashCommandTrigger {
	query: string;
}

// Detects an in-progress slash command at the very start of the composer. The
// menu is only active while the command word is being typed: a leading `/`
// followed by word characters with no whitespace yet. Returns null once the
// user types a space (i.e. begins entering arguments) or the input is not a
// lone slash token.
export function findSlashCommandTrigger(value: string): SlashCommandTrigger | null {
	const match = /^\/([a-zA-Z]*)$/.exec(value);
	if (!match) return null;
	return { query: match[1] ?? '' };
}

// Filters the registry by the in-progress command word, case-insensitive.
export function matchSlashCommands(query: string): SlashCommand[] {
	const lower = query.toLowerCase();
	return SLASH_COMMANDS.filter((command) => command.name.startsWith(lower));
}

// Replaces the input with a fully typed command, leaving a trailing space so
// the user can append arguments (such as a `/compact` focus instruction).
export function applySlashCommand(name: string): string {
	return `/${name} `;
}

export interface CompactCommand {
	instructions: string;
}

const COMPACT_COMMAND_RE = /^\s*\/compact(?:\s+([\s\S]*))?$/i;

// Recognizes a submitted `/compact` command, capturing any focus instructions.
export function parseCompactCommand(input: string): CompactCommand | null {
	const match = COMPACT_COMMAND_RE.exec(input);
	if (!match) return null;
	return { instructions: (match[1] ?? '').trim() };
}

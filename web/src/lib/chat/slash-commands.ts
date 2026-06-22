// Slash-command trigger detection for the chat composer. A slash command is
// only valid as the leading token of the message (Claude-style), so the menu
// triggers when the entire text before the caret is "/" followed by an
// unbroken command token. Typing whitespace ends the command and closes it.

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

export interface HandoffCommand {
	message: string;
}

const HANDOFF_COMMAND_RE = /^\s*\/handoff(?:\s+([\s\S]*))?$/i;

export function parseHandoffCommand(input: string): HandoffCommand | null {
	const match = HANDOFF_COMMAND_RE.exec(input);
	if (!match) return null;
	return { message: (match[1] ?? '').trim() };
}

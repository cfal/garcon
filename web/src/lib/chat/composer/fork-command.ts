export interface ForkCommand {
	message: string;
}

const FORK_COMMAND_RE = /^\s*\/fork(?:\s+([\s\S]*))?$/;

export function parseForkCommand(input: string): ForkCommand | null {
	const match = FORK_COMMAND_RE.exec(input);
	if (!match) return null;
	return { message: (match[1] ?? '').trim() };
}

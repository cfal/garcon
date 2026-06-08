export type FastCommandMode = 'enable' | 'disable' | 'toggle';

export interface FastCommand {
	mode: FastCommandMode;
}

const FAST_COMMAND_RE = /^\s*\/fast(?:\s+(on|off|enable|disable|toggle))?\s*$/i;

export function parseFastCommand(input: string): FastCommand | null {
	const match = FAST_COMMAND_RE.exec(input);
	if (!match) return null;

	const option = match[1]?.toLowerCase();
	if (option === 'off' || option === 'disable') return { mode: 'disable' };
	if (option === 'toggle') return { mode: 'toggle' };
	return { mode: 'enable' };
}

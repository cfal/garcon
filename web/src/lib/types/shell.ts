// Typed shell WebSocket message contracts. Centralizes payload shape
// assumptions so Shell.svelte no longer performs ad hoc raw parsing.

export type ShellSessionPolicy = 'reuse' | 'fresh';

export type ShellServerMessage =
	| { type: 'output'; data: string }
	| { type: 'exit'; exitCode: number; signal?: string }
	| { type: 'error'; message: string };

export type ShellClientMessage =
	| { type: 'input'; data: string }
	| {
			type: 'init';
			projectPath: string | null;
			chatId: string | null;
			cols: number;
			rows: number;
			initialCommand?: string;
			sessionPolicy: ShellSessionPolicy;
		}
	| { type: 'resize'; cols: number; rows: number };

export function parseShellServerMessage(raw: unknown): ShellServerMessage | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	const type = rec.type;
	if (type === 'output' && typeof rec.data === 'string') return { type, data: rec.data };
	if (type === 'exit') return { type: 'exit', exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : 0, signal: typeof rec.signal === 'string' ? rec.signal : undefined };
	if (type === 'error' && typeof rec.message === 'string') return { type, message: rec.message };
	return null;
}

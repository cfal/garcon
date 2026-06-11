export type ShellSessionPolicy = 'reuse' | 'fresh';

export interface ShellInitRequest {
	type: 'init';
	projectPath: string | null;
	chatId: string | null;
	cols: number;
	rows: number;
	sessionPolicy: ShellSessionPolicy;
	initialCommand?: string;
}

export interface ShellInputRequest {
	type: 'input';
	data: string;
}

export interface ShellResizeRequest {
	type: 'resize';
	cols: number;
	rows: number;
}

export type ShellClientMessage = ShellInitRequest | ShellInputRequest | ShellResizeRequest;

export interface ShellOutputMessage {
	type: 'output';
	data: string;
}

export interface ShellExitMessage {
	type: 'exit';
	exitCode: number;
	signal?: string;
}

export interface ShellErrorMessage {
	type: 'error';
	message: string;
}

export type ShellServerMessage = ShellOutputMessage | ShellExitMessage | ShellErrorMessage;

function asRecord(raw: unknown): Record<string, unknown> | null {
	return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
	return positiveInteger(value) ?? fallback;
}

export function parseShellClientMessage(raw: unknown): ShellClientMessage | null {
	const rec = asRecord(raw);
	if (!rec) return null;
	if (rec.type === 'init') {
		return {
			type: 'init',
			projectPath: stringOrNull(rec.projectPath),
			chatId: stringOrNull(rec.chatId),
			cols: positiveIntegerOrDefault(rec.cols, 80),
			rows: positiveIntegerOrDefault(rec.rows, 24),
			sessionPolicy: rec.sessionPolicy === 'fresh' ? 'fresh' : 'reuse',
			...(typeof rec.initialCommand === 'string' ? { initialCommand: rec.initialCommand } : {}),
		};
	}
	if (rec.type === 'input' && typeof rec.data === 'string') {
		return { type: 'input', data: rec.data };
	}
	if (rec.type === 'resize') {
		const cols = positiveInteger(rec.cols);
		const rows = positiveInteger(rec.rows);
		if (cols && rows) return { type: 'resize', cols, rows };
	}
	return null;
}

export function parseShellServerMessage(raw: unknown): ShellServerMessage | null {
	const rec = asRecord(raw);
	if (!rec) return null;
	if (rec.type === 'output' && typeof rec.data === 'string') return { type: 'output', data: rec.data };
	if (rec.type === 'exit') {
		return {
			type: 'exit',
			exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : 0,
			...(typeof rec.signal === 'string' ? { signal: rec.signal } : {}),
		};
	}
	if (rec.type === 'error' && typeof rec.message === 'string') return { type: 'error', message: rec.message };
	return null;
}

export function shellOutput(data: string): ShellOutputMessage {
	return { type: 'output', data };
}

export function shellExit(exitCode: number, signal?: string): ShellExitMessage {
	return { type: 'exit', exitCode, ...(signal ? { signal } : {}) };
}

export function shellError(message: string): ShellErrorMessage {
	return { type: 'error', message };
}

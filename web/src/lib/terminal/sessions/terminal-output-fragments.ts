import type { TerminalStreamServerMessage } from '$shared/terminal';

interface PendingFragments {
	sequence: number;
	count: number;
	parts: string[];
	bytes: number;
	timer: ReturnType<typeof setTimeout>;
}

export function decodeTerminalOutput(value: string): string {
	const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export class TerminalOutputFragments {
	readonly #pending = new Map<string, PendingFragments>();
	constructor(private readonly expired: (terminalId: string) => void) {}

	append(
		message: Extract<TerminalStreamServerMessage, { type: 'terminal-output-fragment' }>,
	): string | null {
		let pending = this.#pending.get(message.terminalId);
		if (!pending) {
			if (message.fragmentIndex !== 0 || message.fragmentCount > 256)
				throw new Error('Invalid terminal fragment');
			pending = {
				sequence: message.sequence,
				count: message.fragmentCount,
				parts: [],
				bytes: 0,
				timer: setTimeout(() => {
					this.delete(message.terminalId);
					this.expired(message.terminalId);
				}, 30_000),
			};
			this.#pending.set(message.terminalId, pending);
		}
		pending.bytes += message.dataBase64.length;
		if (
			message.sequence !== pending.sequence ||
			message.fragmentCount !== pending.count ||
			message.fragmentIndex !== pending.parts.length ||
			pending.bytes > 2 * 1024 * 1024
		) {
			this.delete(message.terminalId);
			throw new Error('Terminal fragment sequence interrupted');
		}
		pending.parts.push(message.dataBase64);
		if (pending.parts.length !== pending.count) return null;
		this.delete(message.terminalId);
		return decodeTerminalOutput(pending.parts.join(''));
	}

	delete(terminalId: string): void {
		const pending = this.#pending.get(terminalId);
		if (pending) clearTimeout(pending.timer);
		this.#pending.delete(terminalId);
	}

	clear(): void {
		for (const id of this.#pending.keys()) this.delete(id);
	}
}

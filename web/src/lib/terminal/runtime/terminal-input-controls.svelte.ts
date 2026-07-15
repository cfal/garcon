export type TerminalModifierKey = 'ctrl' | 'alt';
export type TerminalModifierMode = 'inactive' | 'pending' | 'locked';
export type TerminalToolbarKey = 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right';

interface ActiveModifiers {
	ctrl: boolean;
	alt: boolean;
}

const DOUBLE_TAP_WINDOW_MS = 350;
const KEY_SEQUENCES: Record<TerminalToolbarKey, { base: string; final?: string; code?: number }> = {
	escape: { base: '\x1b', code: 27 },
	tab: { base: '\t', code: 9 },
	up: { base: '\x1b[A', final: 'A' },
	down: { base: '\x1b[B', final: 'B' },
	left: { base: '\x1b[D', final: 'D' },
	right: { base: '\x1b[C', final: 'C' },
};

export class TerminalInputControls {
	ctrlMode = $state<TerminalModifierMode>('inactive');
	altMode = $state<TerminalModifierMode>('inactive');
	#lastTapAt: Record<TerminalModifierKey, number> = { ctrl: 0, alt: 0 };

	get hasActiveModifiers(): boolean {
		return this.ctrlMode !== 'inactive' || this.altMode !== 'inactive';
	}

	getModifierMode(key: TerminalModifierKey): TerminalModifierMode {
		return key === 'ctrl' ? this.ctrlMode : this.altMode;
	}

	toggleModifier(key: TerminalModifierKey): void {
		const mode = this.getModifierMode(key);
		const now = Date.now();
		if (mode === 'locked') {
			this.#setMode(key, 'inactive');
			this.#lastTapAt[key] = 0;
			return;
		}
		if (mode === 'pending') {
			this.#setMode(
				key,
				now - this.#lastTapAt[key] <= DOUBLE_TAP_WINDOW_MS ? 'locked' : 'inactive',
			);
			this.#lastTapAt[key] = 0;
			return;
		}
		this.#setMode(key, 'pending');
		this.#lastTapAt[key] = now;
	}

	transformInput(input: string): string {
		const modifiers = this.#activeModifiers();
		if (!modifiers.ctrl && !modifiers.alt) return input;
		let output = input;
		if (modifiers.ctrl) {
			const control = controlSequence(output);
			if (!control) return input;
			output = control;
		}
		if (modifiers.alt) output = `\x1b${output}`;
		this.#clearPending();
		return output;
	}

	buildToolbarSequence(key: TerminalToolbarKey): string {
		const modifiers = this.#activeModifiers();
		this.#clearPending();
		const config = KEY_SEQUENCES[key];
		if (!modifiers.ctrl && !modifiers.alt) return config.base;
		const parameter = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
		if (config.final) return `\x1b[1;${parameter}${config.final}`;
		if (!modifiers.ctrl && modifiers.alt) return `\x1b${config.base}`;
		return `\x1b[27;${parameter};${config.code}~`;
	}

	reset(): void {
		this.ctrlMode = 'inactive';
		this.altMode = 'inactive';
		this.#lastTapAt = { ctrl: 0, alt: 0 };
	}

	#setMode(key: TerminalModifierKey, mode: TerminalModifierMode): void {
		if (key === 'ctrl') this.ctrlMode = mode;
		else this.altMode = mode;
	}

	#activeModifiers(): ActiveModifiers {
		return { ctrl: this.ctrlMode !== 'inactive', alt: this.altMode !== 'inactive' };
	}

	#clearPending(): void {
		if (this.ctrlMode === 'pending') this.ctrlMode = 'inactive';
		if (this.altMode === 'pending') this.altMode = 'inactive';
	}
}

function controlSequence(input: string): string | null {
	if (input.length !== 1) return null;
	const code = input.charCodeAt(0);
	if (code < 32 || code === 127) return input;
	const lower = input.toLowerCase();
	if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
	const symbols: Record<string, string> = {
		' ': '\x00',
		'@': '\x00',
		'2': '\x00',
		'[': '\x1b',
		'3': '\x1b',
		'\\': '\x1c',
		'4': '\x1c',
		']': '\x1d',
		'5': '\x1d',
		'^': '\x1e',
		'6': '\x1e',
		_: '\x1f',
		'/': '\x1f',
		'?': '\x1f',
		'7': '\x1f',
		'8': '\x7f',
	};
	return symbols[input] ?? null;
}

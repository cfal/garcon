export type ShellModifierKey = 'ctrl' | 'alt';
export type ShellModifierMode = 'inactive' | 'pending' | 'locked';
export type ShellToolbarKey = 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right';

interface ActiveShellModifiers {
	ctrl: boolean;
	alt: boolean;
}

const DOUBLE_TAP_WINDOW_MS = 350;

const SHELL_TOOLBAR_KEY_SEQUENCES: Record<
	ShellToolbarKey,
	{ base: string; final?: string; code?: number }
> = {
	escape: { base: '\x1b', code: 27 },
	tab: { base: '\t', code: 9 },
	up: { base: '\x1b[A', final: 'A' },
	down: { base: '\x1b[B', final: 'B' },
	left: { base: '\x1b[D', final: 'D' },
	right: { base: '\x1b[C', final: 'C' },
};

export class ShellMobileControlsState {
	ctrlMode = $state<ShellModifierMode>('inactive');
	altMode = $state<ShellModifierMode>('inactive');

	private lastTapAt: Record<ShellModifierKey, number> = {
		ctrl: 0,
		alt: 0,
	};

	getModifierMode(key: ShellModifierKey): ShellModifierMode {
		return key === 'ctrl' ? this.ctrlMode : this.altMode;
	}

	get hasActiveModifiers(): boolean {
		return this.ctrlMode !== 'inactive' || this.altMode !== 'inactive';
	}

	toggleModifier(key: ShellModifierKey): void {
		const mode = this.getModifierMode(key);
		const now = Date.now();

		if (mode === 'locked') {
			this.setModifierMode(key, 'inactive');
			this.lastTapAt[key] = 0;
			return;
		}

		if (mode === 'pending') {
			if (now - this.lastTapAt[key] <= DOUBLE_TAP_WINDOW_MS) {
				this.setModifierMode(key, 'locked');
			} else {
				this.setModifierMode(key, 'inactive');
			}
			this.lastTapAt[key] = 0;
			return;
		}

		this.setModifierMode(key, 'pending');
		this.lastTapAt[key] = now;
	}

	transformTerminalInput(input: string): string {
		const modifiers = this.getActiveModifiers();
		if (!modifiers.ctrl && !modifiers.alt) return input;

		const transformed = applyShellModifiers(input, modifiers);
		if (!transformed) return input;

		this.clearPendingModifiers();
		return transformed;
	}

	buildToolbarSequence(key: ShellToolbarKey): string {
		const modifiers = this.getActiveModifiers();
		this.clearPendingModifiers();

		return applyToolbarModifiers(key, modifiers);
	}

	reset(): void {
		this.ctrlMode = 'inactive';
		this.altMode = 'inactive';
		this.lastTapAt.ctrl = 0;
		this.lastTapAt.alt = 0;
	}

	private setModifierMode(key: ShellModifierKey, mode: ShellModifierMode): void {
		if (key === 'ctrl') {
			this.ctrlMode = mode;
			return;
		}
		this.altMode = mode;
	}

	private getActiveModifiers(): ActiveShellModifiers {
		return {
			ctrl: this.ctrlMode !== 'inactive',
			alt: this.altMode !== 'inactive',
		};
	}

	private clearPendingModifiers(): void {
		if (this.ctrlMode === 'pending') this.ctrlMode = 'inactive';
		if (this.altMode === 'pending') this.altMode = 'inactive';
	}
}

function applyToolbarModifiers(key: ShellToolbarKey, modifiers: ActiveShellModifiers): string {
	const config = SHELL_TOOLBAR_KEY_SEQUENCES[key];
	if (!modifiers.ctrl && !modifiers.alt) return config.base;

	const modifierParam = toXtermModifierParameter(modifiers);

	if (config.final) {
		return `\x1b[1;${modifierParam}${config.final}`;
	}

	if (!modifiers.ctrl && modifiers.alt) {
		return `\x1b${config.base}`;
	}

	return `\x1b[27;${modifierParam};${config.code}~`;
}

function applyShellModifiers(input: string, modifiers: ActiveShellModifiers): string | null {
	let output = input;

	if (modifiers.ctrl) {
		const ctrlSequence = toCtrlSequence(output);
		if (!ctrlSequence) return null;
		output = ctrlSequence;
	}

	if (modifiers.alt) {
		output = `\x1b${output}`;
	}

	return output;
}

function toXtermModifierParameter(modifiers: ActiveShellModifiers): number {
	return 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

function toCtrlSequence(input: string): string | null {
	if (input.length !== 1) return null;

	const code = input.charCodeAt(0);
	if (code < 32 || code === 127) return input;

	const lower = input.toLowerCase();
	if (lower >= 'a' && lower <= 'z') {
		return String.fromCharCode(lower.charCodeAt(0) - 96);
	}

	switch (input) {
		case ' ':
		case '@':
		case '2':
			return '\x00';
		case '[':
		case '3':
			return '\x1b';
		case '\\':
		case '4':
			return '\x1c';
		case ']':
		case '5':
			return '\x1d';
		case '^':
		case '6':
			return '\x1e';
		case '_':
		case '/':
		case '?':
		case '7':
			return '\x1f';
		case '8':
			return '\x7f';
		default:
			return null;
	}
}

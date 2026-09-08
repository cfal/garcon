import { Terminal } from '@xterm/xterm';
import {
	terminalThemeFor,
	type TerminalThemePresentation,
} from '$lib/terminal/runtime/terminal-theme.svelte.js';

export async function renderTerminalSample(
	parent: HTMLElement,
	presentation: TerminalThemePresentation,
	content: string,
): Promise<() => void> {
	const terminal = new Terminal({
		cols: 40,
		rows: 2,
		fontSize: 14,
		minimumContrastRatio: 4.5,
		theme: terminalThemeFor(presentation),
	});
	terminal.open(parent);
	await new Promise<void>((resolve) => terminal.write(content, resolve));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	return () => terminal.dispose();
}

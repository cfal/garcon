import { Terminal } from '@xterm/xterm';
import {
	terminalThemeFor,
	type TerminalThemePresentation,
} from '$lib/terminal/runtime/terminal-theme.js';

async function createTerminalSample(
	parent: HTMLElement,
	presentation: TerminalThemePresentation,
	content: string,
): Promise<Terminal> {
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
	return terminal;
}

export async function renderTerminalSample(
	parent: HTMLElement,
	presentation: TerminalThemePresentation,
	content: string,
): Promise<() => void> {
	const terminal = await createTerminalSample(parent, presentation, content);
	return () => terminal.dispose();
}

export async function renderTerminalSelection(
	parent: HTMLElement,
	presentation: TerminalThemePresentation,
): Promise<() => void> {
	const terminal = await createTerminalSample(
		parent,
		presentation,
		'selected output\r\nnormal output',
	);
	terminal.focus();
	terminal.select(0, 0, 15);
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	return () => terminal.dispose();
}
export { readTerminalColors } from '$lib/theme/theme-dom.js';

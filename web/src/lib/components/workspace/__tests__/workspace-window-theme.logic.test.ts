import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync('src/app.css', 'utf8');

function cssBlock(selector: string): string {
	const start = appCss.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`Missing CSS selector: ${selector}`);
	const end = appCss.indexOf('\n}', start);
	if (end < 0) throw new Error(`Unterminated CSS selector: ${selector}`);
	return appCss.slice(start, end);
}

describe('workspace window theme tokens', () => {
	it('exports dedicated title-bar tokens to Tailwind', () => {
		const theme = cssBlock('@theme inline');

		expect(theme).toContain(
			'--color-workspace-window-titlebar: hsl(var(--workspace-window-titlebar));',
		);
		expect(theme).toContain(
			'--color-workspace-window-titlebar-active: hsl(var(--workspace-window-titlebar-active));',
		);
	});

	it('uses sharp light chrome with a softer light focus border', () => {
		const root = cssBlock(':root');

		expect(root).toContain('--workspace-window-titlebar: 0 0% 91%;');
		expect(root).toContain('--workspace-window-titlebar-active: 0 0% 84%;');
		expect(root).toContain('--workspace-window-focus: 0 0% 82%;');
	});

	it('uses almost-black dark chrome with a softer dark focus border', () => {
		const dark = cssBlock('.dark');

		expect(dark).toContain('--workspace-window-titlebar: 0 0% 4%;');
		expect(dark).toContain('--workspace-window-titlebar-active: 0 0% 1%;');
		expect(dark).toContain('--workspace-window-focus: 0 0% 28%;');
	});

	it('animates workspace activity only when reduced motion is not requested', () => {
		expect(appCss).toMatch(
			/@media \(prefers-reduced-motion: no-preference\) \{\s*\.sidebar-processing-indicator,\s*\.workspace-chat-processing-indicator \{\s*animation: sidebar-processing-pulse 1\.6s ease-in-out infinite;/,
		);
	});
});

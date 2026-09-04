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

describe('user message theme tokens', () => {
	it('uses a dark foreground on the light user bubble in dark mode', () => {
		const dark = cssBlock('.dark');

		expect(dark).toContain('--user-bubble: 0 0% 74%;');
		expect(dark).toContain('--user-bubble-foreground: 0 0% 5%;');
	});
});

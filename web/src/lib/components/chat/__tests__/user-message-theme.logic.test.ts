import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const classicDark = readFileSync('src/lib/theme/profiles/classic-dark.css', 'utf8');

describe('user message theme tokens', () => {
	it('uses a dark foreground on the light user bubble in dark mode', () => {
		expect(classicDark).toContain('--user-bubble: 0 0% 74%;');
		expect(classicDark).toContain('--user-bubble-foreground: 0 0% 5%;');
	});
});

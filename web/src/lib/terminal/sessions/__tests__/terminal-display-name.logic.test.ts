import { describe, expect, it } from 'vitest';
import {
	defaultTerminalDisplayName,
	terminalDisplayName,
} from '$lib/terminal/sessions/terminal-display-name.js';

describe('terminal display names', () => {
	it('uses the custom title when present', () => {
		expect(terminalDisplayName({ displaySequence: 4, title: 'Build logs' })).toBe('Build logs');
	});

	it('uses the numbered default when the title is clear', () => {
		expect(terminalDisplayName({ displaySequence: 4, title: null })).toBe('Terminal 4');
		expect(defaultTerminalDisplayName({ displaySequence: 4 })).toBe('Terminal 4');
	});
});

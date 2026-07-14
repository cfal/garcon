import { describe, expect, it } from 'vitest';
import {
	isTerminalLauncherDismissed,
	serializeTerminalLauncherDismissal,
} from '../terminal-launcher-dismissal.js';

describe('terminal launcher dismissal', () => {
	it('matches only a valid dismissal for the current browser-tab client', () => {
		const raw = serializeTerminalLauncherDismissal('client-one');

		expect(isTerminalLauncherDismissed(raw, 'client-one')).toBe(true);
		expect(isTerminalLauncherDismissed(raw, 'client-two')).toBe(false);
		expect(isTerminalLauncherDismissed(raw, null)).toBe(false);
		expect(isTerminalLauncherDismissed('{invalid', 'client-one')).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS } from '../keyboard-shortcut-entries';

describe('keyboard shortcut entries', () => {
	it('documents the schedule-in command syntax', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ command: '/in <duration> <prompt>' }),
			]),
		);
	});
});

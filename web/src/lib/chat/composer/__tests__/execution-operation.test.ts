import { describe, expect, it } from 'vitest';
import { isComposerControllerCommand } from '../execution-operation';

describe('composer execution operation', () => {
	it('keeps controller-only commands independent of execution support on persisted chats', () => {
		const chat = { status: 'running' } as const;
		expect(isComposerControllerCommand(chat, '/clear', null)).toBe(true);
		expect(isComposerControllerCommand(chat, '/rename Synthetic title', 'conversation')).toBe(true);
		expect(isComposerControllerCommand(chat, '/rename Synthetic title', null)).toBe(false);
		expect(isComposerControllerCommand(chat, '/compact', 'conversation')).toBe(false);
		expect(isComposerControllerCommand(chat, 'Synthetic input', 'literal')).toBe(false);
		expect(isComposerControllerCommand({ status: 'draft' }, '/clear', 'conversation')).toBe(false);
		expect(isComposerControllerCommand(null, '/clear', null)).toBe(false);
	});

});

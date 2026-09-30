import { describe, it, expect } from 'vitest';
import {
	composerCapReservation,
	shouldReserveComposerCapSlot,
} from '$lib/chat/composer/composer-cap-layout.js';

describe('composerCapReservation', () => {
	it('keeps the cap slot reserved for project chats even when no cap is visible', () => {
		expect(shouldReserveComposerCapSlot({ hasProjectPath: true, isProcessing: false })).toBe(true);
	});

	it('reserves the cap slot for processing chats without a project path', () => {
		expect(shouldReserveComposerCapSlot({ hasProjectPath: false, isProcessing: true })).toBe(true);
	});

	it('does not reserve the cap slot for idle pathless chats', () => {
		expect(shouldReserveComposerCapSlot({ hasProjectPath: false, isProcessing: false })).toBe(
			false,
		);
	});

	it.each([
		[false, false, false, { feed: false, queue: false, notice: false }],
		[false, true, false, { feed: false, queue: false, notice: false }],
		[false, false, true, { feed: false, queue: false, notice: false }],
		[false, true, true, { feed: false, queue: false, notice: false }],
		[true, false, false, { feed: true, queue: false, notice: false }],
		[true, true, false, { feed: false, queue: true, notice: false }],
		[true, false, true, { feed: false, queue: false, notice: true }],
		[true, true, true, { feed: false, queue: false, notice: true }],
	] as const)('reserves one slot nearest the cap (cap=%s, queue=%s, notice=%s)', (cap, queue, notice, expected) => {
		expect(composerCapReservation(cap, queue, notice)).toEqual(expected);
	});
});

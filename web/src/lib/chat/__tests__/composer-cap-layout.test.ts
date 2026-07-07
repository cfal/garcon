import { describe, it, expect } from 'vitest';
import { composerCapReservation, shouldReserveComposerCapSlot } from '../composer-cap-layout';

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

	it('reserves nothing when no cap is shown', () => {
		expect(composerCapReservation(false, false)).toEqual({ feed: false, queue: false });
		expect(composerCapReservation(false, true)).toEqual({ feed: false, queue: false });
	});

	it('reserves on the feed when a cap is shown without a visible queue', () => {
		expect(composerCapReservation(true, false)).toEqual({ feed: true, queue: false });
	});

	it('reserves on the queue panel when a cap is shown with a visible queue', () => {
		expect(composerCapReservation(true, true)).toEqual({ feed: false, queue: true });
	});
});

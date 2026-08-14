import { describe, expect, it } from 'vitest';
import { HandoffForkConfirmationState } from '../handoff-fork-confirmation.svelte.js';

describe('HandoffForkConfirmationState', () => {
	it('opens while a question is outstanding and resolves with the answer', async () => {
		const confirmation = new HandoffForkConfirmationState();
		expect(confirmation.isOpen).toBe(false);

		const answer = confirmation.ask();
		expect(confirmation.isOpen).toBe(true);
		confirmation.confirm();

		expect(await answer).toBe(true);
		expect(confirmation.isOpen).toBe(false);
	});

	it('treats a cancel as a decline', async () => {
		const confirmation = new HandoffForkConfirmationState();
		const answer = confirmation.ask();
		confirmation.cancel();

		expect(await answer).toBe(false);
		expect(confirmation.isOpen).toBe(false);
	});

	it('declines a superseded question so its caller stops waiting', async () => {
		const confirmation = new HandoffForkConfirmationState();
		const first = confirmation.ask();
		const second = confirmation.ask();
		confirmation.confirm();

		expect(await first).toBe(false);
		expect(await second).toBe(true);
	});
});

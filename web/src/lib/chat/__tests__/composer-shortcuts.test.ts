import { describe, expect, it } from 'vitest';
import { shouldSubmitOnEnter } from '../composer-shortcuts';

describe('shouldSubmitOnEnter', () => {
	it('submits on Enter when sendByShiftEnter is disabled', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
			})
		).toBe(true);
	});

	it('does not submit on Shift+Enter when sendByShiftEnter is disabled', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: true,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
			})
		).toBe(false);
	});

	it('submits on Shift+Enter when sendByShiftEnter is enabled', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: true,
				shiftKey: true,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
			})
		).toBe(true);
	});

	it('does not submit on Enter when sendByShiftEnter is enabled', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: true,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
			})
		).toBe(false);
	});

	it('never submits when Ctrl is pressed', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: false,
				ctrlKey: true,
				metaKey: false,
				isComposing: false,
			})
		).toBe(false);
	});

	it('never submits when Cmd is pressed', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: true,
				shiftKey: true,
				ctrlKey: false,
				metaKey: true,
				isComposing: false,
			})
		).toBe(false);
	});

	it('never submits while composing text', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				isComposing: true,
			})
		).toBe(false);
	});
});

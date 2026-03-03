import { describe, expect, it } from 'vitest';
import { shouldSubmitOnEnter, canSubmitComposer } from '../composer-shortcuts';

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

describe('canSubmitComposer', () => {
	it('allows submission with text only', () => {
		expect(canSubmitComposer(false, 'hello', 0)).toBe(true);
	});

	it('blocks submission with images only', () => {
		expect(canSubmitComposer(false, '', 1)).toBe(false);
	});

	it('allows submission with text and images', () => {
		expect(canSubmitComposer(false, 'hello', 2)).toBe(true);
	});

	it('blocks submission when empty text and no images', () => {
		expect(canSubmitComposer(false, '', 0)).toBe(false);
	});

	it('blocks submission when whitespace-only text and no images', () => {
		expect(canSubmitComposer(false, '   \t\n', 0)).toBe(false);
	});

	it('blocks submission when disabled regardless of content', () => {
		expect(canSubmitComposer(true, 'hello', 0)).toBe(false);
		expect(canSubmitComposer(true, '', 3)).toBe(false);
		expect(canSubmitComposer(true, 'hello', 2)).toBe(false);
	});
});

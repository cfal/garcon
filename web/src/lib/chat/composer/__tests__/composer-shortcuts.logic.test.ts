import { describe, expect, it } from 'vitest';
import {
	shouldSubmitOnEnter,
	resolveComposerEnterAction,
	canSubmitComposer,
} from '$lib/chat/composer/composer-shortcuts.js';

describe('shouldSubmitOnEnter', () => {
	it('submits on Enter when sendByShiftEnter is disabled', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
			}),
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
			}),
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
			}),
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
			}),
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
			}),
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
			}),
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
			}),
		).toBe(false);
	});

	it('never submits on mobile (Enter inserts newline)', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: false,
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
				isMobile: true,
			}),
		).toBe(false);
	});

	it('never submits on mobile even with Shift+Enter', () => {
		expect(
			shouldSubmitOnEnter({
				sendByShiftEnter: true,
				shiftKey: true,
				ctrlKey: false,
				metaKey: false,
				isComposing: false,
				isMobile: true,
			}),
		).toBe(false);
	});
});

describe('resolveComposerEnterAction', () => {
	const resolve = (overrides: Partial<Parameters<typeof resolveComposerEnterAction>[0]> = {}) =>
		resolveComposerEnterAction({
			sendByShiftEnter: false,
			steerWithCtrlEnter: true,
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			isComposing: false,
			...overrides,
		});

	it('preserves the configured Enter and Shift+Enter submission matrix', () => {
		expect(resolve()).toBe('submit');
		expect(resolve({ shiftKey: true })).toBe('newline');
		expect(resolve({ sendByShiftEnter: true })).toBe('newline');
		expect(resolve({ sendByShiftEnter: true, shiftKey: true })).toBe('submit');
	});

	it('prefers steering only for exact enabled Ctrl+Enter', () => {
		expect(resolve({ ctrlKey: true })).toBe('steer-preferred');
		expect(resolve({ ctrlKey: true, steerWithCtrlEnter: false })).toBe('newline');
		expect(resolve({ ctrlKey: true, shiftKey: true })).toBe('newline');
		expect(resolve({ ctrlKey: true, altKey: true })).toBe('newline');
		expect(resolve({ ctrlKey: true, metaKey: true })).toBe('newline');
		expect(resolve({ metaKey: true })).toBe('newline');
	});

	it('preserves newlines during composition and on mobile', () => {
		expect(resolve({ ctrlKey: true, isComposing: true })).toBe('newline');
		expect(resolve({ ctrlKey: true, isMobile: true })).toBe('newline');
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

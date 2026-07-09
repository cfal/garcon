import { describe, expect, it } from 'vitest';

import {
	normalizeCodeFenceLanguage,
	shouldAttemptCodeFenceHighlight,
	shouldWrapCodeFenceLanguage,
} from '../code-language-aliases';

describe('code fence language aliases', () => {
	it('normalizes common aliases used by rendered Markdown fences', () => {
		expect(normalizeCodeFenceLanguage('js')).toBe('javascript');
		expect(normalizeCodeFenceLanguage('md')).toBe('markdown');
		expect(normalizeCodeFenceLanguage('txt')).toBe('plaintext');
		expect(normalizeCodeFenceLanguage('{.py}')).toBe('python');
	});

	it('attempts highlighting only for non-plaintext fences', () => {
		expect(shouldAttemptCodeFenceHighlight('')).toBe(false);
		expect(shouldAttemptCodeFenceHighlight('text')).toBe(false);
		expect(shouldAttemptCodeFenceHighlight('js')).toBe(true);
	});

	it('wraps only prose-like fences', () => {
		expect(shouldWrapCodeFenceLanguage('')).toBe(true);
		expect(shouldWrapCodeFenceLanguage('text')).toBe(true);
		expect(shouldWrapCodeFenceLanguage('md')).toBe(true);
		expect(shouldWrapCodeFenceLanguage('markdown')).toBe(true);
		expect(shouldWrapCodeFenceLanguage('js')).toBe(false);
		expect(shouldWrapCodeFenceLanguage('diff')).toBe(false);
	});
});

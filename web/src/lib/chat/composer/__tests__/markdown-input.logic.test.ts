import { describe, expect, it } from 'vitest';
import { acceptsMarkdownInput } from '../markdown-input.js';

const shell = {
	executionPolicy: 'literal' as const,
	inputFormatByModel: { 'notes-markdown': 'markdown' as const },
};

describe('acceptsMarkdownInput', () => {
	it('accepts conversational input for any model', () => {
		expect(
			acceptsMarkdownInput({ executionPolicy: 'conversation', inputFormatByModel: {} }, 'opus'),
		).toBe(true);
	});
	it('accepts literal input only for a model that declares Markdown', () => {
		expect(acceptsMarkdownInput(shell, 'notes-markdown')).toBe(true);
		expect(acceptsMarkdownInput(shell, 'sh')).toBe(false);
		expect(acceptsMarkdownInput(shell, 'notes')).toBe(false);
	});
	it('rejects input whose agent is not known yet', () => {
		expect(acceptsMarkdownInput(null, 'opus')).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import {
	applySnippetTriggerReplacement,
	DEFAULT_SNIPPET_TRIGGER,
	findSnippetTrigger,
	isValidSnippetTrigger,
	normalizeSnippetTrigger,
	snippetTriggerValidationError,
} from '../snippet-trigger.js';

describe('snippetTriggerValidationError', () => {
	it('accepts punctuation prefixes of two to four characters', () => {
		expect(snippetTriggerValidationError(';;')).toBeNull();
		expect(snippetTriggerValidationError('!!')).toBeNull();
		expect(snippetTriggerValidationError(';.')).toBeNull();
		expect(snippetTriggerValidationError('{{')).toBeNull();
		expect(snippetTriggerValidationError(';;x')).toBeNull();
		expect(snippetTriggerValidationError(';;xy')).toBeNull();
	});

	it('rejects out-of-bounds lengths as format errors', () => {
		expect(snippetTriggerValidationError(';')).toBe('format');
		expect(snippetTriggerValidationError('')).toBe('format');
		expect(snippetTriggerValidationError(';;;;;')).toBe('format');
	});

	it('rejects reserved characters as format errors', () => {
		expect(snippetTriggerValidationError('; ;')).toBe('format');
		expect(snippetTriggerValidationError(';\t')).toBe('format');
		expect(snippetTriggerValidationError(';/')).toBe('format');
		expect(snippetTriggerValidationError('/;')).toBe('format');
		expect(snippetTriggerValidationError(';@')).toBe('format');
		expect(snippetTriggerValidationError(';\u0000')).toBe('format');
	});

	it('rejects short-name-only prefixes as charset errors', () => {
		expect(snippetTriggerValidationError('ab')).toBe('charset');
		expect(snippetTriggerValidationError('a_-1')).toBe('charset');
		expect(snippetTriggerValidationError('AB')).toBe('charset');
	});
});

describe('isValidSnippetTrigger / normalizeSnippetTrigger', () => {
	it('agrees with the validation error helper', () => {
		expect(isValidSnippetTrigger(';;')).toBe(true);
		expect(isValidSnippetTrigger('ab')).toBe(false);
	});

	it('coerces unusable values to the default', () => {
		expect(normalizeSnippetTrigger(undefined)).toBe(DEFAULT_SNIPPET_TRIGGER);
		expect(normalizeSnippetTrigger(42)).toBe(DEFAULT_SNIPPET_TRIGGER);
		expect(normalizeSnippetTrigger(';')).toBe(DEFAULT_SNIPPET_TRIGGER);
		expect(normalizeSnippetTrigger('ab')).toBe(DEFAULT_SNIPPET_TRIGGER);
		expect(normalizeSnippetTrigger('!!')).toBe('!!');
	});
});

describe('findSnippetTrigger', () => {
	it('matches the prefix at the start of the text', () => {
		expect(findSnippetTrigger(';;', 2, ';;')).toEqual({ start: 0, end: 2, query: '' });
		expect(findSnippetTrigger(';;rev', 5, ';;')).toEqual({ start: 0, end: 5, query: 'rev' });
	});

	it('matches after whitespace mid-message and excludes it from the span', () => {
		expect(findSnippetTrigger('Please ;;rev', 12, ';;')).toEqual({
			start: 7,
			end: 12,
			query: 'rev',
		});
		expect(findSnippetTrigger('line one\n;;x', 12, ';;')).toEqual({
			start: 9,
			end: 12,
			query: 'x',
		});
	});

	it('requires a word boundary before the prefix', () => {
		expect(findSnippetTrigger('foo;;', 5, ';;')).toBeNull();
		expect(findSnippetTrigger('a;;rev', 6, ';;')).toBeNull();
		expect(findSnippetTrigger(';;;', 3, ';;')).toBeNull();
	});

	it('captures short-name characters into the query', () => {
		expect(findSnippetTrigger(';;my-name_2', 11, ';;')).toEqual({
			start: 0,
			end: 11,
			query: 'my-name_2',
		});
	});

	it('stops matching once the query is broken by other characters', () => {
		expect(findSnippetTrigger(';;rev ', 6, ';;')).toBeNull();
		expect(findSnippetTrigger(';;rev.x', 7, ';;')).toBeNull();
		expect(findSnippetTrigger(';;Rev', 5, ';;')).toBeNull();
	});

	it('bounds the caret and rejects a caret inside a short name', () => {
		expect(findSnippetTrigger(';;rev', 0, ';;')).toBeNull();
		expect(findSnippetTrigger(';;rev tail', 2, ';;')).toBeNull();
		expect(findSnippetTrigger(';;rev tail', 5, ';;')).toEqual({
			start: 0,
			end: 5,
			query: 'rev',
		});
		expect(findSnippetTrigger(';;', 99, ';;')).toEqual({ start: 0, end: 2, query: '' });
		expect(findSnippetTrigger('a ;; b', 4, ';;')).toEqual({ start: 2, end: 4, query: '' });
	});

	it('honors the configured prefix', () => {
		expect(findSnippetTrigger('!!rev', 5, '!!')).toEqual({ start: 0, end: 5, query: 'rev' });
		expect(findSnippetTrigger('{{rev', 5, '{{')).toEqual({ start: 0, end: 5, query: 'rev' });
		expect(findSnippetTrigger(';;rev', 5, '!!')).toBeNull();
	});

	it('returns null for an invalid configured prefix', () => {
		expect(findSnippetTrigger(';;rev', 5, 'ab')).toBeNull();
		expect(findSnippetTrigger(';;rev', 5, '')).toBeNull();
		expect(findSnippetTrigger(';;rev', 5, undefined)).toBeNull();
	});
});

describe('applySnippetTriggerReplacement', () => {
	it('replaces the trigger span mid-message and lands the caret after', () => {
		const trigger = findSnippetTrigger('Please ;;rev now', 12, ';;');
		expect(trigger).not.toBeNull();
		if (!trigger) return;
		expect(applySnippetTriggerReplacement('Please ;;rev now', trigger, 'EXPANDED')).toEqual({
			text: 'Please EXPANDED now',
			caret: 'Please EXPANDED'.length,
		});
	});

	it('replaces at the start and end of the text', () => {
		expect(applySnippetTriggerReplacement(';;', { start: 0, end: 2 }, 'X')).toEqual({
			text: 'X',
			caret: 1,
		});
		expect(applySnippetTriggerReplacement('head ;;', { start: 5, end: 7 }, 'TAIL')).toEqual({
			text: 'head TAIL',
			caret: 9,
		});
	});

	it('adds no trailing separator', () => {
		const replacement = applySnippetTriggerReplacement(';;word', { start: 0, end: 6 }, 'code();');
		expect(replacement.text).toBe('code();');
	});
});

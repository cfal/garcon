import { describe, expect, it } from 'vitest';

import {
	parseChatSearch,
	serializeChatFilter,
	addTagToQuery,
	removeTagFromQuery,
	queryHasTag,
	emptyFilterSpec,
} from '../sidebar-search';

describe('parseChatSearch', () => {
	it('returns empty spec for empty string', () => {
		const spec = parseChatSearch('');
		expect(spec).toEqual(emptyFilterSpec());
	});

	it('parses tag:ops to tags: ["ops"]', () => {
		const spec = parseChatSearch('tag:ops');
		expect(spec.tags).toEqual(['ops']);
		expect(spec.textTokens).toEqual([]);
	});

	it('parses multiple tags', () => {
		const spec = parseChatSearch('tag:ops tag:bugs');
		expect(spec.tags).toEqual(['ops', 'bugs']);
	});

	it('parses provider, model, and text tokens', () => {
		const spec = parseChatSearch('provider:claude model:sonnet hello');
		expect(spec.providers).toEqual(['claude']);
		expect(spec.models).toEqual(['sonnet']);
		expect(spec.textTokens).toEqual(['hello']);
	});

	it('parses quoted strings as a single text token', () => {
		const spec = parseChatSearch('"hello world"');
		expect(spec.textTokens).toEqual(['hello world']);
	});

	it('parses mixed tag, quoted text, and provider', () => {
		const spec = parseChatSearch('tag:ops "some text" provider:claude');
		expect(spec.tags).toEqual(['ops']);
		expect(spec.textTokens).toEqual(['some text']);
		expect(spec.providers).toEqual(['claude']);
	});
});

describe('serializeChatFilter', () => {
	it('round-trips with parseChatSearch for simple cases', () => {
		const query = 'tag:ops provider:claude hello';
		const spec = parseChatSearch(query);
		const serialized = serializeChatFilter(spec);
		const reparsed = parseChatSearch(serialized);
		expect(reparsed).toEqual(spec);
	});

	it('quotes text tokens that contain spaces', () => {
		const spec = { ...emptyFilterSpec(), textTokens: ['hello world'] };
		const serialized = serializeChatFilter(spec);
		expect(serialized).toBe('"hello world"');
	});

	it('returns empty string for empty spec', () => {
		expect(serializeChatFilter(emptyFilterSpec())).toBe('');
	});
});

describe('addTagToQuery', () => {
	it('adds tag to empty query', () => {
		expect(addTagToQuery('', 'ops')).toBe('tag:ops');
	});

	it('adds tag to existing query', () => {
		expect(addTagToQuery('hello', 'ops')).toBe('hello tag:ops');
	});

	it('does not duplicate existing tag', () => {
		expect(addTagToQuery('tag:ops', 'ops')).toBe('tag:ops');
	});

	it('detects duplicates case-insensitively', () => {
		expect(addTagToQuery('tag:Ops', 'ops')).toBe('tag:Ops');
	});
});

describe('removeTagFromQuery', () => {
	it('removes existing tag', () => {
		expect(removeTagFromQuery('tag:ops', 'ops')).toBe('');
	});

	it('leaves other tokens intact', () => {
		expect(removeTagFromQuery('tag:ops hello tag:bugs', 'ops')).toBe('hello tag:bugs');
	});

	it('is a no-op if tag not present', () => {
		expect(removeTagFromQuery('tag:bugs hello', 'ops')).toBe('tag:bugs hello');
	});

	it('handles regex special characters in tag names', () => {
		// Tag names with special regex chars like dots/brackets are escaped properly
		expect(removeTagFromQuery('tag:v1.0 hello', 'v1.0')).toBe('hello');
	});
});

describe('queryHasTag', () => {
	it('returns true for present tag', () => {
		expect(queryHasTag('tag:ops hello', 'ops')).toBe(true);
	});

	it('returns false for absent tag', () => {
		expect(queryHasTag('tag:bugs hello', 'ops')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(queryHasTag('tag:Ops', 'ops')).toBe(true);
	});
});

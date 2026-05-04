import { describe, expect, it } from 'vitest';

import {
	parseChatSearch,
	serializeChatFilter,
	addTagToQuery,
	removeTagFromQuery,
	queryHasTag,
	emptyFilterSpec,
	matchesChatFilter,
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

	it('parses status:active', () => {
		const spec = parseChatSearch('status:active');
		expect(spec).toEqual({
			textTokens: [],
			tags: [],
			providers: [],
			models: [],
			status: 'active',
			project: null,
		});
	});

	it('parses status:unread', () => {
		const spec = parseChatSearch('status:unread');
		expect(spec).toEqual({
			textTokens: [],
			tags: [],
			providers: [],
			models: [],
			status: 'unread',
			project: null,
		});
	});

	it('parses mixed status and tag filters', () => {
		const spec = parseChatSearch('status:unread tag:ops');
		expect(spec.status).toBe('unread');
		expect(spec.tags).toEqual(['ops']);
	});

	it('ignores unknown status values', () => {
		const spec = parseChatSearch('status:bogus hello');
		expect(spec.status).toBeUndefined();
		expect(spec.textTokens).toEqual(['hello']);
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

	it('serializes status filter', () => {
		const spec = { ...emptyFilterSpec(), status: 'active' as const };
		expect(serializeChatFilter(spec)).toBe('status:active');
	});

	it('round-trips status with tags', () => {
		const query = 'status:unread tag:ops';
		const spec = parseChatSearch(query);
		const serialized = serializeChatFilter(spec);
		const reparsed = parseChatSearch(serialized);
		expect(reparsed).toEqual(spec);
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

describe('parseChatSearch project filter', () => {
	it('parses project:my-app', () => {
		const spec = parseChatSearch('project:my-app');
		expect(spec.project).toBe('my-app');
		expect(spec.textTokens).toEqual([]);
	});

	it('parses project with mixed filters', () => {
		const spec = parseChatSearch('tag:ops project:garcon hello');
		expect(spec.project).toBe('garcon');
		expect(spec.tags).toEqual(['ops']);
		expect(spec.textTokens).toEqual(['hello']);
	});

	it('sets sentinel on multiple project: filters', () => {
		const spec = parseChatSearch('project:a project:b');
		expect(spec.project).toBeDefined();
		expect(spec.project).not.toBeNull();
		// Sentinel value — no real path can contain it
		expect(spec.project).toContain('\0MULTI\0');
	});

	it('is case-insensitive for operator but preserves value casing (lowercased)', () => {
		const spec = parseChatSearch('Project:MyApp');
		expect(spec.project).toBe('myapp');
	});

	it('ignores empty project: value', () => {
		const spec = parseChatSearch('project:');
		expect(spec.project).toBeNull();
	});
});

describe('serializeChatFilter project', () => {
	it('serializes project filter', () => {
		const spec = { ...emptyFilterSpec(), project: 'my-app' };
		expect(serializeChatFilter(spec)).toBe('project:my-app');
	});

	it('round-trips project with other filters', () => {
		const query = 'tag:ops project:garcon hello';
		const spec = parseChatSearch(query);
		const serialized = serializeChatFilter(spec);
		const reparsed = parseChatSearch(serialized);
		expect(reparsed).toEqual(spec);
	});
});

describe('matchesChatFilter project', () => {
	const chat = {
		title: 'Test',
		projectPath: '/workspace/garcon-monorepo',
		provider: 'claude',
		model: 'sonnet' as const,
		tags: [],
		isProcessing: false,
		isUnread: false,
	};

	it('matches when projectPath contains the value', () => {
		const spec = { ...emptyFilterSpec(), project: 'garcon' };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches the end of a path (suffix)', () => {
		const spec = { ...emptyFilterSpec(), project: 'garcon-monorepo' };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches the beginning of a path (prefix)', () => {
		const spec = { ...emptyFilterSpec(), project: '/workspace' };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('does not match when projectPath does not contain the value', () => {
		const spec = { ...emptyFilterSpec(), project: 'other-project' };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});

	it('does not match when multiple project: sent sentinel', () => {
		const spec = { ...emptyFilterSpec(), project: '\0MULTI\0' };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});

	it('is case-insensitive', () => {
		const spec = { ...emptyFilterSpec(), project: 'GARCON' };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches when project is null (no filter)', () => {
		const spec = { ...emptyFilterSpec(), project: null };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});
});

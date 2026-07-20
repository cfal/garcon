import { describe, expect, it } from 'vitest';

import {
	parseChatSearch,
	serializeChatFilter,
	addTagToQuery,
	removeTagFromQuery,
	queryHasTag,
	emptyFilterSpec,
	matchesChatFilter,
} from '$lib/sidebar/search/sidebar-search.js';

describe('parseChatSearch', () => {
	it('returns empty spec for empty string', () => {
		const spec = parseChatSearch('');
		expect(spec).toEqual(emptyFilterSpec());
	});

	it('parses tag:ops to tags: ["ops"]', () => {
		const spec = parseChatSearch('tag:ops');
		expect(spec.tags).toEqual([['ops']]);
		expect(spec.textTokens).toEqual([]);
	});

	it('parses multiple tags', () => {
		const spec = parseChatSearch('tag:ops tag:bugs');
		expect(spec.tags).toEqual([['ops'], ['bugs']]);
	});

	it('parses agent, model, and text tokens', () => {
		const spec = parseChatSearch('agent:claude model:sonnet hello');
		expect(spec.agents).toEqual(['claude']);
		expect(spec.models).toEqual(['sonnet']);
		expect(spec.textTokens).toEqual(['hello']);
	});

	it('parses quoted strings as a single text token', () => {
		const spec = parseChatSearch('"hello world"');
		expect(spec.textTokens).toEqual(['hello world']);
	});

	it('parses mixed tag, quoted text, and agent', () => {
		const spec = parseChatSearch('tag:ops "some text" agent:claude');
		expect(spec.tags).toEqual([['ops']]);
		expect(spec.textTokens).toEqual(['some text']);
		expect(spec.agents).toEqual(['claude']);
	});

	it('parses status:active', () => {
		const spec = parseChatSearch('status:active');
		expect(spec).toEqual({
			textTokens: [],
			tags: [],
			agents: [],
			models: [],
			status: 'active',
			project: [],
		});
	});

	it('parses status:unread', () => {
		const spec = parseChatSearch('status:unread');
		expect(spec).toEqual({
			textTokens: [],
			tags: [],
			agents: [],
			models: [],
			status: 'unread',
			project: [],
		});
	});

	it('parses mixed status and tag filters', () => {
		const spec = parseChatSearch('status:unread tag:ops');
		expect(spec.status).toBe('unread');
		expect(spec.tags).toEqual([['ops']]);
	});

	it('ignores unknown status values', () => {
		const spec = parseChatSearch('status:bogus hello');
		expect(spec.status).toBeUndefined();
		expect(spec.textTokens).toEqual(['hello']);
	});

	it('parses tag:a|b as an OR group', () => {
		const spec = parseChatSearch('tag:a|b');
		expect(spec.tags).toEqual([['a', 'b']]);
		expect(spec.textTokens).toEqual([]);
	});

	it('parses mixed OR groups and separate tags', () => {
		const spec = parseChatSearch('tag:a|b tag:c');
		expect(spec.tags).toEqual([['a', 'b'], ['c']]);
	});

	it('parses agent:a|b as OR values', () => {
		const spec = parseChatSearch('agent:claude|chatgpt');
		expect(spec.agents).toEqual(['claude', 'chatgpt']);
	});

	it('parses model:a|b as OR values', () => {
		const spec = parseChatSearch('model:sonnet|opus');
		expect(spec.models).toEqual(['sonnet', 'opus']);
	});

	it('ignores empty parts in pipe values', () => {
		const spec = parseChatSearch('tag:a||b');
		expect(spec.tags).toEqual([['a', 'b']]);
		const spec2 = parseChatSearch('tag:|a|');
		expect(spec2.tags).toEqual([['a']]);
	});
});

describe('serializeChatFilter', () => {
	it('round-trips with parseChatSearch for simple cases', () => {
		const query = 'tag:ops agent:claude hello';
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

	it('serializes OR groups with pipe syntax', () => {
		const spec = { ...emptyFilterSpec(), tags: [['a', 'b']] };
		expect(serializeChatFilter(spec)).toContain('tag:a|b');
	});

	it('round-trips OR tag groups', () => {
		const query = 'tag:ops|bugs tag:dev';
		const spec = parseChatSearch(query);
		const serialized = serializeChatFilter(spec);
		const reparsed = parseChatSearch(serialized);
		expect(reparsed).toEqual(spec);
	});

	it('round-trips pipe-separated agents', () => {
		const query = 'agent:claude|chatgpt';
		const spec = parseChatSearch(query);
		const serialized = serializeChatFilter(spec);
		const reparsed = parseChatSearch(serialized);
		expect(reparsed).toEqual(spec);
	});

	it('serializes project with pipe syntax', () => {
		const spec = { ...emptyFilterSpec(), project: ['my-app', 'garcon'] };
		expect(serializeChatFilter(spec)).toContain('project:my-app|garcon');
	});

	it('round-trips project pipe OR', () => {
		const query = 'project:a|b hello';
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

	it('finds tag inside OR group', () => {
		expect(queryHasTag('tag:ops|bugs', 'bugs')).toBe(true);
	});
});

describe('parseChatSearch project filter', () => {
	it('parses project:my-app', () => {
		const spec = parseChatSearch('project:my-app');
		expect(spec.project).toEqual(['my-app']);
		expect(spec.textTokens).toEqual([]);
	});

	it('parses project with mixed filters', () => {
		const spec = parseChatSearch('tag:ops project:garcon hello');
		expect(spec.project).toEqual(['garcon']);
		expect(spec.tags).toEqual([['ops']]);
		expect(spec.textTokens).toEqual(['hello']);
	});

	it('parses multiple project: as OR (combined via | or space)', () => {
		const spec = parseChatSearch('project:a|b');
		expect(spec.project).toEqual(['a', 'b']);
	});

	it('is case-insensitive for operator but preserves value casing (lowercased)', () => {
		const spec = parseChatSearch('Project:MyApp');
		expect(spec.project).toEqual(['myapp']);
	});

	it('ignores empty project: value', () => {
		const spec = parseChatSearch('project:');
		expect(spec.project).toEqual([]);
	});

	it('parses project:a|b via pipe', () => {
		const spec = parseChatSearch('project:a|b');
		expect(spec.project).toEqual(['a', 'b']);
	});
});

describe('serializeChatFilter project', () => {
	it('serializes project filter', () => {
		const spec = { ...emptyFilterSpec(), project: ['my-app'] };
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
		agentId: 'claude',
		model: 'sonnet' as const,
		tags: [],
		isProcessing: false,
		isUnread: false,
	};

	it('matches when projectPath contains the value', () => {
		const spec = { ...emptyFilterSpec(), project: ['garcon'] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches the end of a path (suffix)', () => {
		const spec = { ...emptyFilterSpec(), project: ['garcon-monorepo'] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches the beginning of a path (prefix)', () => {
		const spec = { ...emptyFilterSpec(), project: ['/workspace'] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('does not match when projectPath does not contain the value', () => {
		const spec = { ...emptyFilterSpec(), project: ['other-project'] };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});

	it('is case-insensitive', () => {
		const spec = { ...emptyFilterSpec(), project: ['garcon'] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches when project is empty array (no filter)', () => {
		const spec = { ...emptyFilterSpec(), project: [] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('matches any value in project OR group', () => {
		const spec = { ...emptyFilterSpec(), project: ['nope', 'garcon', 'other'] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('does not match when no project values match', () => {
		const spec = { ...emptyFilterSpec(), project: ['nope', 'other'] };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});
});

describe('matchesChatFilter OR groups', () => {
	const chat = {
		title: 'Test',
		projectPath: '/workspace/test',
		agentId: 'claude',
		model: 'sonnet' as const,
		tags: ['ops', 'dev'] as string[],
		isProcessing: false,
		isUnread: false,
	};

	it('matches when OR group has any matching tag', () => {
		const spec = { ...emptyFilterSpec(), tags: [['ops', 'bugs']] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('does not match when OR group has no matching tag', () => {
		const spec = { ...emptyFilterSpec(), tags: [['bugs', 'docs']] };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});

	it('ANDs multiple OR tag groups', () => {
		const spec = { ...emptyFilterSpec(), tags: [['ops', 'x'], ['dev']] };
		expect(matchesChatFilter(chat, spec)).toBe(true);
	});

	it('fails AND when one OR group does not match', () => {
		const spec = { ...emptyFilterSpec(), tags: [['ops'], ['bugs']] };
		expect(matchesChatFilter(chat, spec)).toBe(false);
	});
});

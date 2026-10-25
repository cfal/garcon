import { describe, expect, it } from 'vitest';
import { searchSnippets } from '../search-snippets.js';

describe('searchSnippets', () => {
	const snippets = [
		{ shortName: 'body', template: 'Review this' },
		{ shortName: 'pre_review', template: '' },
		{ shortName: 'review_api', template: '' },
		{ shortName: 'review', template: 'Review this' },
		{ shortName: 'review_tests', template: '' },
	];
	const search = (query: string) => searchSnippets(snippets, query, (item) => item.template);

	it('ranks exact, prefix, contained names, and text matches without duplicates', () => {
		expect(search('  ReViEw  ').map((item) => item.shortName)).toEqual([
			'review',
			'review_api',
			'review_tests',
			'pre_review',
			'body',
		]);
	});

	it('preserves catalog order for blank searches and leaves the catalog unchanged', () => {
		expect(search('   ')).toEqual(snippets);
		expect(search('missing')).toEqual([]);
		expect(snippets.map((item) => item.shortName)).toEqual([
			'body',
			'pre_review',
			'review_api',
			'review',
			'review_tests',
		]);
	});
});

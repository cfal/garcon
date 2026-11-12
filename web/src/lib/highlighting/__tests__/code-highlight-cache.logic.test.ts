import { describe, expect, it } from 'vitest';
import { CodeHighlightCache } from '../code-highlight-cache';
import { plainCodeSegments } from '../code-highlight-types';

describe('CodeHighlightCache', () => {
	it('uses exact keys and evicts least recently used entries', () => {
		const cache = new CodeHighlightCache(10_000, 2);
		const first = plainCodeSegments('a');
		cache.set('js\0a', first);
		cache.set('ts\0a', plainCodeSegments('a'));
		expect(cache.get('js\0a')).toBe(first);
		cache.set('js\0b', plainCodeSegments('b'));
		expect(cache.get('ts\0a')).toBeUndefined();
		expect(cache.get('js\0a')).toBe(first);
	});

	it('bounds retained source and segment bytes independently of entry count', () => {
		const cache = new CodeHighlightCache(150, 32);
		for (const key of ['a', 'b', 'c']) cache.set(key, plainCodeSegments(key));
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBeDefined();
		expect(cache.get('c')).toBeDefined();
		cache.set('oversized', plainCodeSegments('x'.repeat(1000)));
		expect(cache.get('oversized')).toBeUndefined();
		expect(cache.get('b')).toBeDefined();
	});

	it('accounts for replacement without leaking the previous charge', () => {
		const cache = new CodeHighlightCache(150, 32);
		for (let index = 0; index < 10; index++) cache.set('a', plainCodeSegments('a'));
		cache.set('b', plainCodeSegments('b'));
		expect(cache.get('a')).toBeDefined();
	});
});

import { describe, expect, it } from 'vitest';
import { GitProjectInvalidationStore } from '../git-project-invalidation.svelte.js';

describe('node-qualified Git invalidation', () => {
	it('keeps one revision per host without invalidating other hosts', () => {
		const store = new GitProjectInvalidationStore();
		const version = store.markChanged('remote');
		expect(store.version('remote')).toBe(version);
		expect(store.version('local')).toBe(0);
		const next = store.markChanged('remote');
		expect(next).toBeGreaterThan(version);
		expect(store.version('remote')).toBe(next);
		expect(store.version('local')).toBe(0);
	});

	it('prunes removed nodes without reusing an invalidation revision', () => {
		const store = new GitProjectInvalidationStore();
		const removed = store.markChanged('removed');
		const local = store.markChanged('local');
		store.pruneNodes(new Set(['local']));
		expect(store.version('removed')).toBe(0);
		expect(store.version('local')).toBe(local);
		expect(store.markChanged('removed')).toBeGreaterThan(local);
		expect(store.version('removed')).toBeGreaterThan(removed);
	});
});

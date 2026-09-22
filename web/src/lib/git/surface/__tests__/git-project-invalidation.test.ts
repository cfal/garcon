import { describe, expect, it } from 'vitest';
import { GitProjectInvalidationStore } from '../git-project-invalidation.svelte.js';

describe('node-qualified Git invalidation', () => {
	it('invalidates containing views only on the captured node', () => {
		const store = new GitProjectInvalidationStore();
		const version = store.markChanged('remote', '/repo/src');
		expect(store.version('remote', '/repo')).toBe(version);
		expect(store.version('remote', '/repo/src/module')).toBe(version);
		expect(store.version('remote', '/repo-other')).toBe(0);
		expect(store.version('local', '/repo')).toBe(0);
	});

	it('prunes removed nodes without reusing an invalidation revision', () => {
		const store = new GitProjectInvalidationStore();
		const removed = store.markChanged('removed', '/repo');
		store.markChanged('local', '/repo');
		store.pruneNodes(new Set(['local']));
		expect(store.version('removed', '/repo')).toBe(0);
		expect(store.markChanged('removed', '/repo')).toBeGreaterThan(removed);
	});
});

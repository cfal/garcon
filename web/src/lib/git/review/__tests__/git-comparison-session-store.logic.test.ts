import { describe, expect, it } from 'vitest';
import {
	GitComparisonSessionStore,
	type GitComparisonSessionIdentity,
} from '$lib/git/review/git-comparison-session-store.js';
import type { GitComparisonSpecification } from '$lib/git/review/git-comparison.svelte.js';

const revision: GitComparisonSpecification = {
	fromRevision: 'origin/main',
	toKind: 'revision',
	toRevision: 'HEAD',
	mode: 'direct',
};

const workingTree: GitComparisonSpecification = {
	fromRevision: 'release',
	toKind: 'working-tree',
	mode: 'direct',
};

function identity(chatId: string, targetIdentity = 'target-a'): GitComparisonSessionIdentity {
	return { chatId, targetIdentity };
}

describe('GitComparisonSessionStore', () => {
	it('keeps chats and physical targets independent', () => {
		const store = new GitComparisonSessionStore();
		store.remember(identity('chat-a'), revision);
		store.remember(identity('chat-b'), workingTree);
		store.remember(identity('chat-a', 'target-b'), workingTree);

		expect(store.recall(identity('chat-a'))).toEqual(revision);
		expect(store.recall(identity('chat-b'))).toEqual(workingTree);
		expect(store.recall(identity('chat-a', 'target-b'))).toEqual(workingTree);
	});

	it('returns copies rather than mutable retained objects', () => {
		const store = new GitComparisonSessionStore();
		store.remember(identity('chat-a'), revision);
		const recalled = store.recall(identity('chat-a'));
		if (!recalled) throw new Error('Expected a remembered comparison.');
		recalled.fromRevision = 'mutated';

		expect(store.recall(identity('chat-a'))).toEqual(revision);
	});

	it('retains a copy rather than the caller mutable object', () => {
		const store = new GitComparisonSessionStore();
		const specification = { ...revision };
		store.remember(identity('chat-a'), specification);
		specification.fromRevision = 'mutated';

		expect(store.recall(identity('chat-a'))).toEqual(revision);
	});

	it('evicts the least recently used entry and touches reads', () => {
		const store = new GitComparisonSessionStore(2);
		store.remember(identity('chat-a'), revision);
		store.remember(identity('chat-b'), revision);
		expect(store.recall(identity('chat-a'))).toEqual(revision);

		store.remember(identity('chat-c'), revision);

		expect(store.recall(identity('chat-a'))).toEqual(revision);
		expect(store.recall(identity('chat-b'))).toBeNull();
		expect(store.recall(identity('chat-c'))).toEqual(revision);
	});

	it('replaces an entry and keeps the replacement most recent', () => {
		const store = new GitComparisonSessionStore(2);
		store.remember(identity('chat-a'), revision);
		store.remember(identity('chat-b'), revision);
		store.remember(identity('chat-a'), workingTree);
		store.remember(identity('chat-c'), revision);

		expect(store.recall(identity('chat-a'))).toEqual(workingTree);
		expect(store.recall(identity('chat-b'))).toBeNull();
		expect(store.recall(identity('chat-c'))).toEqual(revision);
	});

	it('clears all client memory at root teardown', () => {
		const store = new GitComparisonSessionStore();
		store.remember(identity('chat-a'), revision);
		store.remember(identity('chat-b'), workingTree);

		store.clear();

		expect(store.recall(identity('chat-a'))).toBeNull();
		expect(store.recall(identity('chat-b'))).toBeNull();
	});
});

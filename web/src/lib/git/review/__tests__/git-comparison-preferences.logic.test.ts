import { describe, expect, it } from 'vitest';
import {
	GIT_COMPARISON_PREFERENCE_LIMIT,
	LocalGitComparisonPreferences,
	type GitComparisonPreferencePersistence,
} from '$lib/git/review/git-comparison-preferences.js';
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

function createPersistence(initialValue: string | null = null) {
	let value = initialValue;
	const persistence = {
		read: () => value,
		write: (nextValue: string) => {
			value = nextValue;
		},
	} satisfies GitComparisonPreferencePersistence;
	return {
		persistence,
		get value() {
			return value;
		},
		set value(nextValue: string | null) {
			value = nextValue;
		},
	};
}

describe('LocalGitComparisonPreferences', () => {
	it('returns no range when storage is empty', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(preferences.recall('chat-a')).toBeNull();
	});

	it('persists ranges across preference service recreation', () => {
		const storage = createPersistence();
		new LocalGitComparisonPreferences(storage.persistence).remember('chat-a', revision);

		const reloaded = new LocalGitComparisonPreferences(storage.persistence);

		expect(reloaded.recall('chat-a')).toEqual(revision);
		expect(JSON.parse(storage.value ?? '{}')).toMatchObject({
			version: 1,
			entries: [{ chatId: 'chat-a', specification: revision }],
		});
	});

	it('keeps one independent range per chat', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.remember('chat-a', revision);
		preferences.remember('chat-b', workingTree);

		expect(preferences.recall('chat-a')).toEqual(revision);
		expect(preferences.recall('chat-b')).toEqual(workingTree);
	});

	it('replaces a chat range and keeps one persisted entry', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.remember('chat-a', revision);
		preferences.remember('chat-a', workingTree);

		expect(preferences.recall('chat-a')).toEqual(workingTree);
		expect(JSON.parse(storage.value ?? '{}').entries).toHaveLength(1);
	});

	it('evicts the least recently used entry above twenty and touches reads', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		for (let index = 0; index < GIT_COMPARISON_PREFERENCE_LIMIT; index += 1) {
			preferences.remember(`chat-${index}`, revision);
		}
		expect(preferences.recall('chat-0')).toEqual(revision);

		preferences.remember(`chat-${GIT_COMPARISON_PREFERENCE_LIMIT}`, workingTree);

		expect(preferences.recall('chat-0')).toEqual(revision);
		expect(preferences.recall('chat-1')).toBeNull();
		expect(preferences.recall(`chat-${GIT_COMPARISON_PREFERENCE_LIMIT}`)).toEqual(workingTree);
		expect(JSON.parse(storage.value ?? '{}').entries).toHaveLength(GIT_COMPARISON_PREFERENCE_LIMIT);
	});

	it('returns fresh specification objects', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.remember('chat-a', revision);
		const recalled = preferences.recall('chat-a');
		if (!recalled) throw new Error('Expected a persisted comparison preference.');
		recalled.fromRevision = 'mutated';

		expect(preferences.recall('chat-a')).toEqual(revision);
	});

	it('restores direct working-tree and merge-base revision specifications', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		const mergeBase: GitComparisonSpecification = {
			fromRevision: 'origin/main',
			toKind: 'revision',
			toRevision: 'feature',
			mode: 'merge-base',
		};
		preferences.remember('chat-working', workingTree);
		preferences.remember('chat-merge-base', mergeBase);

		const reloaded = new LocalGitComparisonPreferences(storage.persistence);
		expect(reloaded.recall('chat-working')).toEqual(workingTree);
		expect(reloaded.recall('chat-merge-base')).toEqual(mergeBase);
	});

	it('filters malformed entries, duplicate chats, and entries above the limit', () => {
		const overflow = Array.from({ length: GIT_COMPARISON_PREFERENCE_LIMIT + 5 }, (_, index) => ({
			chatId: `overflow-${index}`,
			specification: revision,
		}));
		const storage = createPersistence(
			JSON.stringify({
				version: 1,
				entries: [
					{ chatId: '', specification: revision },
					{ chatId: 'chat-a', specification: revision },
					{ chatId: 'chat-a', specification: workingTree },
					{ chatId: 'invalid-mode', specification: { ...workingTree, mode: 'merge-base' } },
					{ chatId: 'blank-ref', specification: { ...revision, fromRevision: ' ' } },
					...overflow,
				],
			}),
		);
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(preferences.recall('chat-a')).toEqual(revision);
		expect(preferences.recall('invalid-mode')).toBeNull();
		expect(preferences.recall('blank-ref')).toBeNull();
		expect(preferences.recall('overflow-18')).toEqual(revision);
		expect(preferences.recall('overflow-19')).toBeNull();
	});

	it('ignores corrupt JSON, unknown versions, and invalid record shapes', () => {
		const storage = createPersistence('{broken');
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		expect(preferences.recall('chat-a')).toBeNull();

		storage.value = JSON.stringify({ version: 2, entries: [{ chatId: 'chat-a' }] });
		expect(preferences.recall('chat-a')).toBeNull();

		storage.value = JSON.stringify({ version: 1, entries: 'not-an-array' });
		expect(preferences.recall('chat-a')).toBeNull();
	});

	it('recovers from corrupt storage on the next successful write', () => {
		const storage = createPersistence('{broken');
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.remember('chat-a', revision);

		expect(new LocalGitComparisonPreferences(storage.persistence).recall('chat-a')).toEqual(
			revision,
		);
	});

	it('keeps comparison behavior available when persistence throws', () => {
		const readFailure = new LocalGitComparisonPreferences({
			read: () => {
				throw new Error('blocked');
			},
			write: () => undefined,
		});
		const writeFailure = new LocalGitComparisonPreferences({
			read: () => null,
			write: () => {
				throw new Error('quota');
			},
		});

		expect(readFailure.recall('chat-a')).toBeNull();
		expect(() => readFailure.remember('chat-a', revision)).not.toThrow();
		expect(() => writeFailure.remember('chat-a', revision)).not.toThrow();
	});

	it('ignores empty chat identifiers', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.remember(' ', revision);

		expect(preferences.recall(' ')).toBeNull();
		expect(storage.value).toBeNull();
	});
});

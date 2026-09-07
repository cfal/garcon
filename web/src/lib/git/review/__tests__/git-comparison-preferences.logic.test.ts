import { describe, expect, it } from 'vitest';
import {
	GIT_COMPARISON_CHAT_PREFERENCE_LIMIT,
	GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT,
	LocalGitComparisonPreferences,
	type GitComparisonPreferences,
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

const mergeBase: GitComparisonSpecification = {
	fromRevision: 'origin/main',
	toKind: 'revision',
	toRevision: 'feature',
	mode: 'merge-base',
};

function createPersistence(initialValue: string | null = null) {
	let value = initialValue;
	let writeCount = 0;
	const persistence = {
		read: () => value,
		write: (nextValue: string) => {
			value = nextValue;
			writeCount += 1;
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
		get writeCount() {
			return writeCount;
		},
	};
}

function recall(
	preferences: GitComparisonPreferences,
	chatId: string,
	projectPath = '/project',
): GitComparisonSpecification | null {
	return preferences.recall({ chatId, projectPath });
}

function storedRecord(storage: ReturnType<typeof createPersistence>): {
	version?: unknown;
	entries?: Array<{ chatId?: unknown; specification?: unknown }>;
	projectEntries?: Array<{ projectPath?: unknown; specification?: unknown }>;
} {
	return JSON.parse(storage.value ?? '{}');
}

describe('LocalGitComparisonPreferences', () => {
	it('returns no range when storage is empty', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(recall(preferences, 'chat-a')).toBeNull();
	});

	it('persists ranges across preference service recreation', () => {
		const storage = createPersistence();
		new LocalGitComparisonPreferences(storage.persistence).rememberChat('chat-a', revision);

		const reloaded = new LocalGitComparisonPreferences(storage.persistence);

		expect(recall(reloaded, 'chat-a')).toEqual(revision);
		expect(storedRecord(storage)).toMatchObject({
			version: 2,
			entries: [{ chatId: 'chat-a', specification: revision }],
			projectEntries: [],
		});
	});

	it('keeps one independent range per chat', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberChat('chat-a', revision);
		preferences.rememberChat('chat-b', workingTree);

		expect(recall(preferences, 'chat-a')).toEqual(revision);
		expect(recall(preferences, 'chat-b')).toEqual(workingTree);
	});

	it('replaces a chat range and keeps one persisted entry', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberChat('chat-a', revision);
		preferences.rememberChat('chat-a', workingTree);

		expect(recall(preferences, 'chat-a')).toEqual(workingTree);
		expect(storedRecord(storage).entries).toHaveLength(1);
	});

	it('evicts the least recently used chat above the limit and touches reads', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		for (let index = 0; index < GIT_COMPARISON_CHAT_PREFERENCE_LIMIT; index += 1) {
			preferences.rememberChat(`chat-${index}`, revision);
		}
		expect(recall(preferences, 'chat-0')).toEqual(revision);

		preferences.rememberChat(`chat-${GIT_COMPARISON_CHAT_PREFERENCE_LIMIT}`, workingTree);

		expect(recall(preferences, 'chat-0')).toEqual(revision);
		expect(recall(preferences, 'chat-1')).toBeNull();
		expect(recall(preferences, `chat-${GIT_COMPARISON_CHAT_PREFERENCE_LIMIT}`)).toEqual(
			workingTree,
		);
		expect(storedRecord(storage).entries).toHaveLength(GIT_COMPARISON_CHAT_PREFERENCE_LIMIT);
	});

	it('resolves chat, exact project, nearest ancestor, and farther ancestor in order', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberUserSelection({ chatId: 'seed-root', projectPath: '/repo' }, revision);
		preferences.rememberUserSelection(
			{ chatId: 'seed-nearest', projectPath: '/repo/.worktrees' },
			workingTree,
		);
		preferences.rememberUserSelection(
			{ chatId: 'seed-exact', projectPath: '/repo/.worktrees/abc' },
			mergeBase,
		);
		preferences.rememberChat('chat-specific', revision);

		expect(recall(preferences, 'chat-specific', '/repo/.worktrees/abc')).toEqual(revision);
		expect(recall(preferences, 'new-exact', '/repo/.worktrees/abc')).toEqual(mergeBase);
		expect(recall(preferences, 'new-nearest', '/repo/.worktrees/def')).toEqual(workingTree);
		expect(recall(preferences, 'new-farther', '/repo/packages/app')).toEqual(revision);
		expect(recall(preferences, 'unrelated', '/other')).toBeNull();
	});

	it('chooses the nearest project path regardless of LRU order', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberUserSelection(
			{ chatId: 'seed-nearest', projectPath: '/repo/packages' },
			workingTree,
		);
		preferences.rememberUserSelection({ chatId: 'seed-root', projectPath: '/repo' }, revision);

		expect(recall(preferences, 'new-chat', '/repo/packages/app')).toEqual(workingTree);
	});

	it('normalizes project keys for writes and inherited lookups', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberUserSelection(
			{ chatId: 'seed-unix', projectPath: ' /repo//.worktrees/ ' },
			revision,
		);
		preferences.rememberUserSelection(
			{ chatId: 'seed-windows', projectPath: 'C:\\workspace\\repo\\' },
			workingTree,
		);

		expect(recall(preferences, 'unix-child', '/repo/.worktrees/abc')).toEqual(revision);
		expect(recall(preferences, 'windows-child', 'c:/workspace/repo/src')).toEqual(workingTree);
		expect(storedRecord(storage).projectEntries?.map((entry) => entry.projectPath)).toEqual([
			'c:/workspace/repo',
			'/repo/.worktrees',
		]);
	});

	it('writes an explicit selection to both maps atomically', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.rememberUserSelection(
			{ chatId: 'chat-a', projectPath: '/repo/.worktrees/abc' },
			revision,
		);

		expect(storage.writeCount).toBe(1);
		expect(storedRecord(storage)).toMatchObject({
			entries: [{ chatId: 'chat-a', specification: revision }],
			projectEntries: [{ projectPath: '/repo/.worktrees/abc', specification: revision }],
		});
	});

	it('keeps chat and project LRU recency independent', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberUserSelection({ chatId: 'chat-a', projectPath: '/repo/a' }, revision);
		preferences.rememberUserSelection({ chatId: 'chat-b', projectPath: '/repo/b' }, workingTree);

		expect(recall(preferences, 'chat-a', '/repo/b')).toEqual(revision);
		expect(storedRecord(storage).entries?.map((entry) => entry.chatId)).toEqual([
			'chat-a',
			'chat-b',
		]);
		expect(storedRecord(storage).projectEntries?.map((entry) => entry.projectPath)).toEqual([
			'/repo/b',
			'/repo/a',
		]);

		expect(recall(preferences, 'missing', '/repo/a')).toEqual(revision);
		expect(storedRecord(storage).entries?.map((entry) => entry.chatId)).toEqual([
			'chat-a',
			'chat-b',
		]);
		expect(storedRecord(storage).projectEntries?.map((entry) => entry.projectPath)).toEqual([
			'/repo/a',
			'/repo/b',
		]);
	});

	it('evicts the least recently used project above the limit and touches inherited reads', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		for (let index = 0; index < GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT; index += 1) {
			preferences.rememberUserSelection(
				{ chatId: `seed-${index}`, projectPath: `/repo-${index}` },
				revision,
			);
		}
		expect(recall(preferences, 'touch', '/repo-0/child')).toEqual(revision);

		preferences.rememberUserSelection(
			{ chatId: 'seed-overflow', projectPath: '/repo-overflow' },
			workingTree,
		);

		expect(recall(preferences, 'kept', '/repo-0/child')).toEqual(revision);
		expect(recall(preferences, 'evicted', '/repo-1/child')).toBeNull();
		expect(recall(preferences, 'newest', '/repo-overflow')).toEqual(workingTree);
		expect(storedRecord(storage).projectEntries).toHaveLength(
			GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT,
		);
	});

	it('returns fresh specification objects from both preference maps', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberUserSelection({ chatId: 'chat-a', projectPath: '/repo' }, revision);
		const recalledChat = recall(preferences, 'chat-a');
		const recalledProject = recall(preferences, 'new-chat', '/repo');
		if (!recalledChat || !recalledProject) {
			throw new Error('Expected persisted comparison preferences.');
		}
		recalledChat.fromRevision = 'mutated-chat';
		recalledProject.fromRevision = 'mutated-project';

		expect(recall(preferences, 'chat-a')).toEqual(revision);
		expect(recall(preferences, 'new-chat', '/repo')).toEqual(revision);
	});

	it('restores direct working-tree and merge-base revision specifications', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		preferences.rememberChat('chat-working', workingTree);
		preferences.rememberUserSelection(
			{ chatId: 'chat-merge-base', projectPath: '/merge-base' },
			mergeBase,
		);

		const reloaded = new LocalGitComparisonPreferences(storage.persistence);
		expect(recall(reloaded, 'chat-working')).toEqual(workingTree);
		expect(recall(reloaded, 'chat-merge-base')).toEqual(mergeBase);
		expect(recall(reloaded, 'new-chat', '/merge-base')).toEqual(mergeBase);
	});

	it('loads version one chat preferences and upgrades them on write', () => {
		const storage = createPersistence(
			JSON.stringify({
				version: 1,
				entries: [{ chatId: 'chat-a', specification: revision }],
			}),
		);
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(recall(preferences, 'chat-a')).toEqual(revision);
		expect(recall(preferences, 'new-chat', '/repo')).toBeNull();
		preferences.rememberChat('chat-b', workingTree);

		expect(storedRecord(storage)).toMatchObject({
			version: 2,
			entries: [
				{ chatId: 'chat-b', specification: workingTree },
				{ chatId: 'chat-a', specification: revision },
			],
			projectEntries: [],
		});
	});

	it('filters malformed, duplicate, and over-limit chat entries', () => {
		const overflow = Array.from(
			{ length: GIT_COMPARISON_CHAT_PREFERENCE_LIMIT + 5 },
			(_, index) => ({
				chatId: `overflow-${index}`,
				specification: revision,
			}),
		);
		const storage = createPersistence(
			JSON.stringify({
				version: 2,
				entries: [
					{ chatId: '', specification: revision },
					{ chatId: 'chat-a', specification: revision },
					{ chatId: 'chat-a', specification: workingTree },
					{ chatId: 'invalid-mode', specification: { ...workingTree, mode: 'merge-base' } },
					{ chatId: 'blank-ref', specification: { ...revision, fromRevision: ' ' } },
					...overflow,
				],
				projectEntries: [],
			}),
		);
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(recall(preferences, 'chat-a')).toEqual(revision);
		expect(recall(preferences, 'invalid-mode')).toBeNull();
		expect(recall(preferences, 'blank-ref')).toBeNull();
		expect(recall(preferences, 'overflow-18')).toEqual(revision);
		expect(recall(preferences, 'overflow-19')).toBeNull();
	});

	it('filters malformed and normalized duplicate project entries', () => {
		const storage = createPersistence(
			JSON.stringify({
				version: 2,
				entries: [],
				projectEntries: [
					{ projectPath: '', specification: revision },
					{ projectPath: 'relative/path', specification: revision },
					{ projectPath: '/repo/', specification: revision },
					{ projectPath: '/repo', specification: workingTree },
					{ projectPath: '/invalid', specification: { ...workingTree, mode: 'merge-base' } },
				],
			}),
		);
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		expect(recall(preferences, 'new-chat', '/repo/src')).toEqual(revision);
		expect(recall(preferences, 'invalid', '/invalid')).toBeNull();
	});

	it('ignores invalid project paths while preserving the chat selection', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.rememberUserSelection(
			{ chatId: 'chat-a', projectPath: 'relative/project' },
			revision,
		);

		expect(recall(preferences, 'chat-a', 'relative/project')).toEqual(revision);
		expect(recall(preferences, 'new-chat', 'relative/project')).toBeNull();
		expect(storedRecord(storage).projectEntries).toEqual([]);
	});

	it('ignores corrupt JSON, unknown versions, and invalid record shapes', () => {
		const storage = createPersistence('{broken');
		const preferences = new LocalGitComparisonPreferences(storage.persistence);
		expect(recall(preferences, 'chat-a')).toBeNull();

		storage.value = JSON.stringify({ version: 3, entries: [{ chatId: 'chat-a' }] });
		expect(recall(preferences, 'chat-a')).toBeNull();

		storage.value = JSON.stringify({ version: 2, entries: 'not-an-array' });
		expect(recall(preferences, 'chat-a')).toBeNull();
	});

	it('recovers from corrupt storage on the next successful write', () => {
		const storage = createPersistence('{broken');
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.rememberUserSelection({ chatId: 'chat-a', projectPath: '/repo' }, revision);

		const reloaded = new LocalGitComparisonPreferences(storage.persistence);
		expect(recall(reloaded, 'chat-a')).toEqual(revision);
		expect(recall(reloaded, 'new-chat', '/repo')).toEqual(revision);
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

		expect(recall(readFailure, 'chat-a')).toBeNull();
		expect(() => readFailure.rememberChat('chat-a', revision)).not.toThrow();
		expect(() =>
			writeFailure.rememberUserSelection({ chatId: 'chat-a', projectPath: '/repo' }, revision),
		).not.toThrow();
	});

	it('ignores empty chat identifiers', () => {
		const storage = createPersistence();
		const preferences = new LocalGitComparisonPreferences(storage.persistence);

		preferences.rememberChat(' ', revision);
		preferences.rememberUserSelection({ chatId: ' ', projectPath: '/repo' }, revision);

		expect(recall(preferences, ' ')).toBeNull();
		expect(storage.value).toBeNull();
	});
});

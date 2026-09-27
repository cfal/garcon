import { describe, expect, it } from 'vitest';
import {
	createFileNavigationRepository,
	createMemoryFileNavigationRepository,
	FILE_RECENT_LIMIT,
	navigationKey,
	type FileRecentLocationV1,
} from '../file-navigation-repository.js';

function recent(
	key: string,
	userNamespace = 'user',
	deploymentId = 'deployment',
): FileRecentLocationV1 {
	return {
		schemaVersion: 1,
		userNamespace,
		deploymentId,
		key,
		executorId: 'local',
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: key,
		displayPath: key,
		revision: 'v1:initial',
		line: 1,
		column: 1,
		viewPreference: 'source',
		timestamp: 1,
	};
}

describe('file navigation repository', () => {
	it('retries a transient IndexedDB open failure', async () => {
		let attempts = 0;
		const indexedDb = {
			open() {
				attempts += 1;
				throw new Error('open failed');
			},
		} satisfies Pick<IDBFactory, 'open'>;
		const repository = createFileNavigationRepository(indexedDb);
		await expect(repository.getRecents('user', 'deployment')).rejects.toThrow('open failed');
		await expect(repository.getRecents('user', 'deployment')).rejects.toThrow('open failed');
		expect(attempts).toBe(2);
	});

	it('isolates recents and navigation by user and deployment', async () => {
		const repository = createMemoryFileNavigationRepository();
		for (const [user, deployment] of [
			['a', 'one'],
			['b', 'one'],
			['a', 'two'],
		]) {
			const entry = recent('file.txt', user, deployment);
			await repository.putRecent(entry);
			await repository.putNavigation({
				schemaVersion: 1,
				userNamespace: user,
				deploymentId: deployment,
				key: navigationKey(user, deployment),
				entries: [entry],
				index: 0,
				updatedAt: 1,
			});
		}
		expect(await repository.getRecents('a', 'one')).toEqual([recent('file.txt', 'a', 'one')]);
		expect((await repository.getNavigation('a', 'two'))?.entries).toEqual([
			recent('file.txt', 'a', 'two'),
		]);
		expect(await repository.getNavigation('b', 'two')).toBeNull();
	});

	it('bounds each partition without evicting other users', async () => {
		const repository = createMemoryFileNavigationRepository();
		await repository.putRecent(recent('keep', 'other'));
		for (let i = 0; i <= FILE_RECENT_LIMIT; i++) {
			await repository.putRecent({ ...recent(String(i)), timestamp: i });
		}
		const entries = await repository.getRecents('user', 'deployment');
		expect(entries).toHaveLength(FILE_RECENT_LIMIT);
		expect(entries.some((entry) => entry.key === '0')).toBe(false);
		expect(await repository.getRecents('other', 'deployment')).toHaveLength(1);
	});
});

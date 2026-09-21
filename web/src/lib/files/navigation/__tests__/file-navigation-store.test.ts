import { describe, expect, it } from 'vitest';
import {
	FileNavigationStore,
	type FileLocation,
} from '$lib/files/navigation/file-navigation-store.svelte.js';
import { createMemoryFileDraftRepository } from '$lib/files/persistence/file-draft-repository.js';
import { fileIdentityKey } from '$lib/files/documents/file-identity.js';

const scope = { deploymentId: 'deployment', userNamespace: 'user' };

function location(index: number): FileLocation {
	return {
		key: String(index),
		canonicalFileRootPath: '/workspace',
		normalizedRelativePath: `src/${index}.ts`,
		displayPath: `src/${index}.ts`,
		revision: null,
		line: index + 1,
		column: 1,
		viewPreference: 'source',
		timestamp: index,
	};
}

describe('FileNavigationStore', () => {
	it('disables unavailable and pending history directions', () => {
		const store = new FileNavigationStore(createMemoryFileDraftRepository(), scope);
		expect(store.canGoBack).toBe(false);
		expect(store.canGoForward).toBe(false);
		store.record(location(0));
		expect(store.canGoBack).toBe(false);
		store.record(location(1));
		expect(store.canGoBack).toBe(true);
		store.back();
		expect(store.canGoBack).toBe(false);
		expect(store.canGoForward).toBe(false);
		store.completeNavigation(false);
		expect(store.canGoBack).toBe(true);
		expect(store.canGoForward).toBe(false);
		store.back();
		store.record(location(0));
		expect(store.canGoBack).toBe(false);
		expect(store.canGoForward).toBe(true);
		store.forward();
		expect(store.canGoForward).toBe(false);
		store.completeNavigation(true);
		expect(store.canGoBack).toBe(true);
	});

	it('keeps the newest locations when count pruning applies', () => {
		const store = new FileNavigationStore(createMemoryFileDraftRepository(), scope);
		for (let index = 0; index <= 200; index += 1) store.record(location(index));

		expect(store.back()?.key).toBe('199');
		store.completeNavigation(true);
		expect(store.forward()?.key).toBe('200');
	});

	it('preserves the forward branch while navigating history', () => {
		const store = new FileNavigationStore(createMemoryFileDraftRepository(), scope);
		store.record(location(0));
		store.record(location(1));
		store.record(location(2));

		const previous = store.back();
		if (previous) store.record(previous);

		expect(store.forward()?.key).toBe('2');
	});

	it('restores history after a navigation target fails to open', () => {
		const store = new FileNavigationStore(createMemoryFileDraftRepository(), scope);
		store.record(location(0));
		store.record(location(1));

		expect(store.back()?.key).toBe('0');
		store.completeNavigation(false);
		store.record(location(2));

		expect(store.back()?.key).toBe('1');
	});

	it('retains image view preferences in recents', async () => {
		const repository = createMemoryFileDraftRepository();
		const store = new FileNavigationStore(repository, scope);
		store.record({ ...location(0), viewPreference: 'image' });
		await Promise.resolve();

		const restored = new FileNavigationStore(repository, scope);
		await restored.restore();

		expect(restored.recents[0]?.viewPreference).toBe('image');
	});

	it('restores recents and back-forward history from browser storage', async () => {
		const repository = createMemoryFileDraftRepository();
		const first = new FileNavigationStore(repository, scope);
		first.record(location(0));
		first.record(location(1));
		await Promise.resolve();

		const restored = new FileNavigationStore(repository, scope);
		await restored.restore();

		expect(restored.recents.map((entry) => entry.key)).toEqual([
			JSON.stringify(['local', '/workspace', 'src/1.ts']),
			JSON.stringify(['local', '/workspace', 'src/0.ts']),
		]);
		expect(restored.back()?.key).toBe(JSON.stringify(['local', '/workspace', 'src/0.ts']));
	});

	it.each([false, true])(
		'deduplicates Local recents by identity, newest legacy: %s',
		async (newestLegacy) => {
			const repository = createMemoryFileDraftRepository();
			const local = location(0);
			const remoteNodeId = '22222222-2222-4222-8222-222222222222';
			const legacy = { ...local, key: JSON.stringify(['/workspace', 'src/0.ts']) };
			const current = { ...local, nodeId: 'local', key: fileIdentityKey('/workspace', 'src/0.ts') };
			for (const [index, entry] of (newestLegacy
				? [current, legacy]
				: [legacy, current]
			).entries()) {
				await repository.putRecent({
					...scope,
					...entry,
					schemaVersion: 1,
					timestamp: index + 1,
					line: index === 1 ? 7 : 1,
					viewPreference: index === 1 ? 'preview' : 'source',
				});
			}
			await repository.putRecent({
				...scope,
				...local,
				schemaVersion: 1,
				nodeId: remoteNodeId,
				key: fileIdentityKey('/workspace', 'src/0.ts', remoteNodeId),
				timestamp: 3,
			});

			const restored = new FileNavigationStore(repository, scope);
			await restored.restore();

			expect(restored.recents).toHaveLength(2);
			expect(restored.recents[0]).toMatchObject({ nodeId: remoteNodeId, timestamp: 3 });
			expect(restored.recents[1]).toMatchObject({
				key: current.key,
				nodeId: 'local',
				line: 7,
				viewPreference: 'preview',
				timestamp: 2,
			});
		},
	);
});

import { describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';

describe('WorkspaceTransitionArbiter', () => {
	it('publishes concurrent intents in FIFO order against the latest snapshot', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const first = arbiter.commit([
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);
		const second = arbiter.commit([
			{ type: 'move-to-host', surfaceId: 'singleton:git', destination: 'sidebar' },
		]);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(layout.revision).toBe(2);
		expect(layout.snapshot.sidebar.activeId).toBe('singleton:git');
		expect(layout.snapshot.main.activeId).toBe('singleton:chat');
	});

	it('continues draining after an invalid intent fails', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const invalid = arbiter.commit([{ type: 'focus-host', host: 'sidebar', surfaceId: 'missing' }]);
		const valid = arbiter.commit([{ type: 'set-sidebar-open', open: true }]);

		await expect(invalid).resolves.toBe(false);
		await expect(valid).resolves.toBe(true);
		expect(layout.snapshot.sidebarOpen).toBe(true);
		expect(layout.revision).toBe(1);
	});

	it('runs publication hooks immediately around the one snapshot publish', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const order: string[] = [];
		const originalPublish = layout.publish.bind(layout);
		layout.publish = ((revision, snapshot) => {
			order.push('layout');
			return originalPublish(revision, snapshot);
		}) as typeof layout.publish;

		await arbiter.commit([{ type: 'set-sidebar-open', open: true }], {
			beforePublish: () => order.push('domain'),
		});

		expect(order).toEqual(['domain', 'layout']);
	});

	it('replans a guaranteed removal after a compare-and-publish miss', async () => {
		const layout = createWorkspaceLayoutStore();
		let attempts = 0;
		const commitPort = {
			publish(revision: number, snapshot: typeof layout.snapshot) {
				attempts += 1;
				if (attempts === 1) return false;
				return layout.publish(revision, snapshot);
			},
		};
		const arbiter = new WorkspaceTransitionArbiter(layout, commitPort);

		await expect(
			arbiter.commit(
				[{ type: 'remove-surface', surfaceId: 'singleton:git' }],
				{},
				{ retryPublishFailure: true },
			),
		).resolves.toBe(true);

		expect(attempts).toBe(2);
		expect(layout.surface('singleton:git')).toBeNull();
	});
});

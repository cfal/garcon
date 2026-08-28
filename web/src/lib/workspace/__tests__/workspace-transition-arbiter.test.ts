import { describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore } from '../workspace-layout.svelte';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';
import { paneNodeById } from '../pane-tree';
import type { PaneId } from '../surface-types';

function paneTabs(snapshot: ReturnType<typeof createWorkspaceLayoutStore>['snapshot']) {
	return paneNodeById(snapshot.desktopRoot, 'pane-main' as PaneId)!.tabs;
}

describe('WorkspaceTransitionArbiter', () => {
	it('publishes concurrent intents in FIFO order against the latest snapshot', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const first = arbiter.commit([
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		const second = arbiter.commit([
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:git',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(layout.revision).toBe(2);
		expect(paneTabs(layout.snapshot).activeId).toBe('singleton:chat');
		expect(
			paneNodeById(layout.snapshot.desktopRoot, 'pane-2' as PaneId)?.tabs.activeId,
		).toBe('singleton:git');
	});

	it('continues draining after an invalid intent fails', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const invalid = arbiter.commit([
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:missing' },
		]);
		const valid = arbiter.commit([
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);

		await expect(invalid).rejects.toThrow('Surface is not in pane');
		await expect(valid).resolves.toBe(true);
		expect(paneTabs(layout.snapshot).activeId).toBe('singleton:git');
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

		await arbiter.commit(
			[{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' }],
			{
				beforePublish: () => order.push('domain'),
			},
		);

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

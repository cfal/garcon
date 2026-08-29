import { describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore } from '../workspace-layout.svelte';
import { WorkspaceTransitionArbiter } from '../workspace-transition-arbiter';
import { windowNodeById } from '../window-tree';
import type { WorkspaceWindowId } from '../surface-types';

function windowTabs(snapshot: ReturnType<typeof createWorkspaceLayoutStore>['snapshot']) {
	return windowNodeById(snapshot.desktopRoot, 'window-main' as WorkspaceWindowId)!.tabs;
}

describe('WorkspaceTransitionArbiter', () => {
	it('publishes concurrent intents in FIFO order against the latest snapshot', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const first = arbiter.commit([
			{
				type: 'register-surface',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				windowId: 'window-main',
			},
		]);
		const second = arbiter.commit([
			{
				type: 'move-tab-to-new-window',
				surfaceId: 'singleton:git',
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-2',
				partitionId: 'partition-1',
			},
		]);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(layout.revision).toBe(2);
		expect(windowTabs(layout.snapshot).activeId).toBe('chat-view:window-main');
		expect(
			windowNodeById(layout.snapshot.desktopRoot, 'window-2' as WorkspaceWindowId)?.tabs.activeId,
		).toBe('singleton:git');
	});

	it('continues draining after an invalid intent fails', async () => {
		const layout = createWorkspaceLayoutStore();
		const arbiter = new WorkspaceTransitionArbiter(layout, layout);
		const invalid = arbiter.commit([
			{ type: 'activate-window-tab', windowId: 'window-main', surfaceId: 'singleton:missing' },
		]);
		const valid = arbiter.commit([
			{
				type: 'register-surface',
				surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
				windowId: 'window-main',
			},
			{ type: 'activate-window-tab', windowId: 'window-main', surfaceId: 'singleton:git' },
		]);

		await expect(invalid).rejects.toThrow('Surface is not in workspace window');
		await expect(valid).resolves.toBe(true);
		expect(windowTabs(layout.snapshot).activeId).toBe('singleton:git');
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
			[
				{
					type: 'register-surface',
					surface: { id: 'singleton:git', type: 'singleton', kind: 'git' },
					windowId: 'window-main',
				},
			],
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

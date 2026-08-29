import { describe, expect, it, vi } from 'vitest';
import {
	GitViewLauncher,
	type GitViewSurfacePort,
	type GitViewWorkspacePort,
} from '$lib/git/surface/git-view-launcher.svelte.js';

function harness(options: {
	existing?: readonly string[];
	open?: (kind: 'git-history' | 'git-compare', windowId: 'window-main') => Promise<void>;
	mobile?: (kind: 'git-history' | 'git-compare') => Promise<void>;
}) {
	const existing = new Set(options.existing ?? []);
	const workspace = {
		layout: {
			surface: (surfaceId: string) => (existing.has(surfaceId) ? { id: surfaceId } : null),
		},
		openSingletonAsTab: vi.fn(async (kind, windowId) => {
			await options.open?.(kind as 'git-history' | 'git-compare', windowId as 'window-main');
		}),
		focusMobileSingleton: vi.fn(async (kind) => {
			await options.mobile?.(kind as 'git-history' | 'git-compare');
		}),
	} satisfies GitViewWorkspacePort;
	const surfaces = {
		disposeSurface: vi.fn(),
	} satisfies GitViewSurfacePort;
	return {
		launcher: new GitViewLauncher(workspace, surfaces),
		workspace,
		surfaces,
	};
}

describe('GitViewLauncher', () => {
	it('opens desktop History as a tab in the origin window', async () => {
		const { launcher, workspace } = harness({});
		await launcher.openHistory({ presentation: 'window-main' });
		expect(workspace.openSingletonAsTab).toHaveBeenCalledWith('git-history', 'window-main');
	});

	it('opens mobile Compare without constructing contextual launch state', async () => {
		const { launcher, workspace } = harness({});
		await launcher.openCompare({ presentation: 'mobile' });
		expect(workspace.focusMobileSingleton).toHaveBeenCalledWith('git-compare');
	});

	it('disposes a new controller only when registration leaves no descriptor', async () => {
		const { launcher, surfaces } = harness({
			open: async () => {
				throw new Error('registration failed');
			},
		});

		await expect(launcher.openCompare({ presentation: 'window-main' })).rejects.toThrow(
			'registration failed',
		);
		expect(surfaces.disposeSurface).toHaveBeenCalledWith('git-compare');
	});

	it('retains a controller when registration published before focus settling failed', async () => {
		const existing = new Set<string>();
		const workspace = {
			layout: {
				surface: (surfaceId: string) => (existing.has(surfaceId) ? { id: surfaceId } : null),
			},
			openSingletonAsTab: vi.fn(async () => {
				existing.add('singleton:git-compare');
				throw new Error('frame failed');
			}),
			focusMobileSingleton: vi.fn(async () => undefined),
		} satisfies GitViewWorkspacePort;
		const surfaces = {
			disposeSurface: vi.fn(),
		} satisfies GitViewSurfacePort;
		const launcher = new GitViewLauncher(workspace, surfaces);

		await expect(launcher.openCompare({ presentation: 'window-main' })).rejects.toThrow(
			'frame failed',
		);
		expect(surfaces.disposeSurface).not.toHaveBeenCalled();
	});

	it('does not dispose an existing surface after focus failure', async () => {
		const { launcher, surfaces } = harness({
			existing: ['singleton:git-compare'],
			open: async () => {
				throw new Error('focus failed');
			},
		});

		await expect(launcher.openCompare({ presentation: 'window-main' })).rejects.toThrow(
			'focus failed',
		);
		expect(surfaces.disposeSurface).not.toHaveBeenCalled();
	});
});

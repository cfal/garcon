import { describe, expect, it, vi } from 'vitest';
import {
	GitViewLauncher,
	type GitViewSurfacePort,
	type GitViewWorkspacePort,
} from '$lib/git/surface/git-view-launcher.svelte.js';
import type { GitCompareLaunchIntent } from '$lib/git/review/git-compare-surface.svelte.js';
import type { GitTarget } from '$lib/git/targets/git-target.js';

function target(): GitTarget {
	return {
		projectPath: '/repo/worktree',
		repoRoot: '/repo',
		worktreePath: '/repo/worktree',
		label: 'worktree',
		branch: 'feature',
		source: 'worktree',
	};
}

function harness(options: {
	existing?: readonly string[];
	open?: (kind: 'git-history' | 'git-compare', host: 'main' | 'sidebar') => Promise<void>;
	mobile?: (kind: 'git-history' | 'git-compare') => Promise<void>;
}) {
	const existing = new Set(options.existing ?? []);
	const events: string[] = [];
	const prepareLaunch = vi.fn((intent: GitCompareLaunchIntent) => {
		events.push(
			`compare:prepare:${intent.source?.target.projectPath ?? 'none'}:${
				intent.comparison?.fromRevision ?? 'default'
			}`,
		);
		return 7;
	});
	const cancelPreparedLaunch = vi.fn();
	const compare = { prepareLaunch, cancelPreparedLaunch };
	const workspace = {
		layout: {
			surface: (surfaceId: string) =>
				existing.has(surfaceId) ? { id: surfaceId } : null,
		},
		openSingleton: vi.fn(async (kind, host) => {
			events.push(`workspace:open:${kind}:${host}`);
			await options.open?.(kind as 'git-history' | 'git-compare', host);
		}),
		focusMobileSingleton: vi.fn(async (kind) => {
			events.push(`workspace:mobile:${kind}`);
			await options.mobile?.(kind as 'git-history' | 'git-compare');
		}),
	} satisfies GitViewWorkspacePort;
	const surfaces = {
		gitCompare: vi.fn(() => compare),
		disposeSurface: vi.fn(),
	} satisfies GitViewSurfacePort;
	return {
		launcher: new GitViewLauncher(workspace, surfaces),
		workspace,
		surfaces,
		events,
		prepareLaunch,
		cancelPreparedLaunch,
	};
}

describe('GitViewLauncher', () => {
	it('opens desktop History in the requested host', async () => {
		const { launcher, workspace } = harness({});
		await launcher.openHistory({ presentation: 'sidebar' });
		expect(workspace.openSingleton).toHaveBeenCalledWith('git-history', 'sidebar');
	});

	it('opens mobile Compare without preparing an empty launch', async () => {
		const { launcher, workspace, prepareLaunch } = harness({});
		await launcher.openCompare({ presentation: 'mobile' });
		expect(workspace.focusMobileSingleton).toHaveBeenCalledWith('git-compare');
		expect(prepareLaunch).not.toHaveBeenCalled();
	});

	it('prepares contextual Compare before workspace focus', async () => {
		const { launcher, events } = harness({
			existing: ['singleton:git-compare'],
		});
		await launcher.openCompare(
			{
				presentation: 'sidebar',
				source: {
					effectiveProjectKey: 'chat',
					target: target(),
				},
			},
			{
				fromRevision: 'parent',
				toKind: 'revision',
				toRevision: 'commit',
			},
		);

		expect(events).toEqual([
			'compare:prepare:/repo/worktree:parent',
			'workspace:open:git-compare:sidebar',
		]);
	});

	it('disposes a new controller only when registration leaves no descriptor', async () => {
		const { launcher, surfaces } = harness({
			open: async () => {
				throw new Error('registration failed');
			},
		});

		await expect(launcher.openCompare({ presentation: 'main' })).rejects.toThrow(
			'registration failed',
		);
		expect(surfaces.disposeSurface).toHaveBeenCalledWith('git-compare');
	});

	it('retains a controller when registration published before focus settling failed', async () => {
		const existing = new Set<string>();
		const compare = {
			prepareLaunch: vi.fn(() => 3),
			cancelPreparedLaunch: vi.fn(),
		};
		const workspace = {
			layout: {
				surface: (surfaceId: string) =>
					existing.has(surfaceId) ? { id: surfaceId } : null,
			},
			openSingleton: vi.fn(async () => {
				existing.add('singleton:git-compare');
				throw new Error('frame failed');
			}),
			focusMobileSingleton: vi.fn(async () => undefined),
		} satisfies GitViewWorkspacePort;
		const surfaces = {
			gitCompare: vi.fn(() => compare),
			disposeSurface: vi.fn(),
		} satisfies GitViewSurfacePort;
		const launcher = new GitViewLauncher(workspace, surfaces);

		await expect(
			launcher.openCompare(
				{ presentation: 'main' },
				{ fromRevision: 'HEAD', toKind: 'working-tree' },
			),
		).rejects.toThrow('frame failed');
		expect(compare.cancelPreparedLaunch).toHaveBeenCalledWith(3);
		expect(surfaces.disposeSurface).not.toHaveBeenCalled();
	});

	it('does not dispose an existing surface after focus failure', async () => {
		const { launcher, surfaces, cancelPreparedLaunch } = harness({
			existing: ['singleton:git-compare'],
			open: async () => {
				throw new Error('focus failed');
			},
		});

		await expect(
			launcher.openCompare(
				{ presentation: 'main' },
				{ fromRevision: 'HEAD', toKind: 'working-tree' },
			),
		).rejects.toThrow('focus failed');
		expect(cancelPreparedLaunch).toHaveBeenCalledWith(7);
		expect(surfaces.disposeSurface).not.toHaveBeenCalled();
	});
});

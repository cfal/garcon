import { describe, expect, it, vi } from 'vitest';
import {
	GitViewLauncher,
	type GitViewSurfacePort,
	type GitViewWorkspacePort,
} from '$lib/git/surface/git-view-launcher.js';

function harness(options: {
	existing?: readonly string[];
	open?: GitViewWorkspacePort['openSingletonAsTab'];
	mobile?: GitViewWorkspacePort['focusMobileSingleton'];
}) {
	const existing = new Set(options.existing ?? []);
	const workspace = {
		layout: {
			surface: (surfaceId: string) => (existing.has(surfaceId) ? { id: surfaceId } : null),
		},
		openSingletonAsTab: vi.fn<GitViewWorkspacePort['openSingletonAsTab']>(
			async (kind, windowId) => {
				await options.open?.(kind, windowId);
			},
		),
		focusMobileSingleton: vi.fn<GitViewWorkspacePort['focusMobileSingleton']>(async (kind) => {
			await options.mobile?.(kind);
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
	describe.each([
		{ method: 'openHistory', kind: 'git-history' },
		{ method: 'openCompare', kind: 'git-compare' },
	] as const)('$method', ({ method, kind }) => {
		it.each(['window-main', 'mobile'] as const)('opens in the %s origin', async (presentation) => {
			const { launcher, workspace, surfaces } = harness({});
			await launcher[method]({ presentation });
			if (presentation === 'mobile') {
				expect(workspace.focusMobileSingleton).toHaveBeenCalledExactlyOnceWith(kind);
				expect(workspace.openSingletonAsTab).not.toHaveBeenCalled();
			} else {
				expect(workspace.openSingletonAsTab).toHaveBeenCalledExactlyOnceWith(kind, presentation);
				expect(workspace.focusMobileSingleton).not.toHaveBeenCalled();
			}
			expect(surfaces.disposeSurface).not.toHaveBeenCalled();
		});

		it('disposes an unregistered controller when mobile focus fails', async () => {
			const error = new Error('mobile focus failed');
			const { launcher, surfaces } = harness({
				mobile: async () => {
					throw error;
				},
			});
			await expect(launcher[method]({ presentation: 'mobile' })).rejects.toBe(error);
			expect(surfaces.disposeSurface).toHaveBeenCalledExactlyOnceWith(kind);
		});
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

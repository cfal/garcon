import { expect, it, vi } from 'vitest';
import { resolveProjectPath } from '../workspace-project-path-resolution.js';
import type { ProjectResolutionLease } from '../project-resolution-store.svelte.js';

it('captures project executor/path across chat changes during validation', async () => {
	const target = {
		kind: 'chat' as const,
		executorId: 'remote',
		chatId: 'synthetic-chat',
		projectPath: '/remote/project',
	};
	const resolving = Promise.withResolvers<void>();
	const release = vi.fn();
	const lease = {
		target,
		snapshot: { kind: 'available' as const, effectiveProjectKey: '/remote/project' },
		resolve: () => resolving.promise,
		retry: async () => {},
		release,
	} satisfies ProjectResolutionLease;
	const workspaceContext = { currentTarget: target };
	const retain = vi.fn(() => lease);
	const result = resolveProjectPath({ workspaceContext, projectResolution: { retain } });
	workspaceContext.currentTarget = { ...target, executorId: 'local', projectPath: '/local/project' };
	resolving.resolve();
	expect(await result).toEqual({ executorId: 'remote', projectPath: '/remote/project' });
	expect(release).toHaveBeenCalledOnce();
});

it('uses the destination base rather than inspecting or copying another host path', async () => {
	const retain = vi.fn((): ProjectResolutionLease => {
		throw new Error('Must not inspect foreign path');
	});
	const deps = {
		workspaceContext: {
			currentTarget: {
				kind: 'chat' as const,
				executorId: 'local',
				chatId: 'synthetic-chat',
				projectPath: '/local/project',
			},
		},
		projectResolution: { retain },
	};
	expect(await resolveProjectPath(deps, 'remote')).toEqual({ executorId: 'remote', projectPath: null });
	expect(retain).not.toHaveBeenCalled();
	expect(await resolveProjectPath({ ...deps, workspaceContext: { currentTarget: null } })).toEqual({
		executorId: 'local',
		projectPath: null,
	});
});

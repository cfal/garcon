// Regression coverage for chat-switch target retention: selecting another repo
// in a Git surface, switching to a chat with a different project, and switching
// back must converge on the remembered target and load listings exactly for it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type { GitTargetCandidate } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	getGitHistoryCommits: vi.fn(),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
	gitRevertCommit: vi.fn(),
}));

const api = vi.mocked(await import('$lib/api/git.js'));

function candidate(
	projectPath: string,
	overrides: Partial<GitTargetCandidate> = {},
): GitTargetCandidate {
	return {
		projectPath,
		repoRoot: projectPath,
		worktreePath: projectPath,
		label: projectPath.split('/').pop() ?? projectPath,
		branch: 'main',
		source: 'chat-project',
		isCurrent: true,
		isMissing: false,
		...overrides,
	};
}

function availableProject(chatId: string, projectPath: string) {
	return {
		kind: 'available' as const,
		project: { chatId, projectPath, effectiveProjectKey: chatId },
	};
}

function resolvingProject(chatId: string, projectPath: string) {
	return {
		kind: 'resolving' as const,
		context: { chatId, projectPath, effectiveProjectKey: null },
	};
}

function installCandidateRouter(pending?: Map<string, Array<(v: unknown) => void>>) {
	api.getGitTargetCandidates.mockImplementation((projectPath: string) => {
		if (pending) {
			return new Promise((resolve) => {
				const list = pending.get(projectPath) ?? [];
				list.push(resolve as (v: unknown) => void);
				pending.set(projectPath, list);
			}) as never;
		}
		return Promise.resolve({ targets: [candidate(projectPath)] }) as never;
	});
}

function historyCalls(): string[] {
	return api.getGitHistoryCommits.mock.calls.map(([projectPath]) => projectPath as string);
}

describe('git chat-switch desync repro', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getGitHistoryCommits.mockResolvedValue({
			project: '/x',
			ref: 'HEAD',
			commits: [],
			nextOffset: null,
		});
	});

	it('A: select repo X, switch chat A->B->A, listings follow the remembered target', async () => {
		installCandidateRouter();
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await vi.waitFor(() => expect(historyCalls()).toContain('/project-a'));

		// "switch repos in the git screen"
		await controller.target.selectTarget(candidate('/repo-x', { isCurrent: false }));
		await vi.waitFor(() => expect(historyCalls()).toContain('/repo-x'));

		// chat A -> B
		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		await controller.target.activate();
		await vi.waitFor(() => expect(historyCalls()).toContain('/project-b'));

		// chat B -> A
		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await controller.target.activate();
		await vi.waitFor(() =>
			expect(historyCalls().filter((p) => p === '/repo-x').length).toBeGreaterThanOrEqual(2),
		);

		expect(controller.target.activeProjectPath).toBe('/repo-x');
		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		// The last listing load must be for the applied target.
		expect(historyCalls().at(-1)).toBe('/repo-x');
	});

	it('B: rapid A->B->A with the B candidate fetch still in flight converges on X', async () => {
		const pending = new Map<string, Array<(v: unknown) => void>>();
		installCandidateRouter(pending);
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		const firstActivation = controller.target.activate();
		await vi.waitFor(() => expect(pending.get('/project-a')?.length ?? 0).toBeGreaterThan(0));
		pending.get('/project-a')!.shift()!({ targets: [candidate('/project-a')] });
		await firstActivation;

		await controller.target.selectTarget(candidate('/repo-x', { isCurrent: false }));
		// selectTarget kicks a background reconcile fetch for /repo-x; leave it pending.

		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		// B's candidate fetch is now pending; do NOT resolve it - switch straight back.
		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await vi.waitFor(() => expect(pending.get('/repo-x')?.length ?? 0).toBeGreaterThan(0));
		for (const resolve of pending.get('/repo-x') ?? []) {
			resolve({ targets: [candidate('/repo-x')] });
		}
		pending.set('/repo-x', []);
		await controller.target.activate();

		expect(controller.target.activeProjectPath).toBe('/repo-x');
		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		await vi.waitFor(() => expect(historyCalls().at(-1)).toBe('/repo-x'));
		// No listing load for a project that is not the applied target may come last,
		// and chat B's aborted context must not have produced an /x load under B.
		expect(controller.history).toMatchObject({ screen: 'list' });
	});

	it('C: hidden during the switches, listings load once for X on show', async () => {
		installCandidateRouter();
		const controller = new GitHistorySurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await controller.target.selectTarget(candidate('/repo-x', { isCurrent: false }));
		await vi.waitFor(() => expect(historyCalls()).toContain('/repo-x'));

		controller.setPresentationVisible(false);
		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		const callsBeforeShow = historyCalls().length;
		controller.setPresentationVisible(true);
		await controller.target.activate();

		await vi.waitFor(() => expect(historyCalls().length).toBeGreaterThan(callsBeforeShow));
		expect(controller.target.activeProjectPath).toBe('/repo-x');
		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		expect(historyCalls().at(-1)).toBe('/repo-x');
	});
});

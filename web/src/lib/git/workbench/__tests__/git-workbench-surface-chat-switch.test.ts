// Regression coverage for chat switches over retained Git targets: listings,
// active tab, and the review document must stay coherent with the applied
// target, including when two chat identities share one physical repository.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import type {
	GitReviewDocumentSummary,
	GitTargetCandidate,
	GitTreeNode,
	GitWorkbenchSnapshotResponse,
} from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({
	getGitTargetCandidates: vi.fn(),
	getGitRefs: vi.fn().mockResolvedValue({ refs: [] }),
	getGitWorkbenchSnapshot: vi.fn(),
	getGitWorkingTreeFingerprint: vi.fn().mockResolvedValue({
		status: 'ready',
		project: '/project',
		fingerprintVersion: 1,
		fingerprint: 'v1:baseline',
		changedPathCount: 0,
	}),
	getGitReviewFileBodies: vi.fn().mockResolvedValue({ status: 'ready', files: {} }),
	getGitStatus: vi.fn().mockResolvedValue({
		branch: 'main',
		hasCommits: true,
		modified: [],
		added: [],
		deleted: [],
		untracked: [],
	}),
	getRemoteStatus: vi.fn().mockResolvedValue({ hasRemote: false, branch: 'main' }),
	getGitRemotes: vi.fn().mockResolvedValue({ remotes: [] }),
	getGitWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
	gitCheckoutRef: vi.fn().mockResolvedValue({ success: true }),
	gitCreateBranch: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('$lib/api/git-comparison.js', () => ({
	getGitComparisonSnapshot: vi.fn(),
	getGitComparisonFileBodies: vi.fn().mockResolvedValue({ status: 'ready', files: {} }),
	getGitComparisonFreshness: vi.fn().mockResolvedValue({ status: 'ready', changedEndpoints: [] }),
}));

vi.stubGlobal('localStorage', {
	getItem: () => null,
	setItem: () => {},
	removeItem: () => {},
});

const api = vi.mocked(await import('$lib/api/git.js'));
const comparisonApi = vi.mocked(await import('$lib/api/git-comparison.js'));

const LIMITS = {
	maxSummaryFiles: 10_000,
	maxBodyBatchFiles: 24,
	maxLoadedRows: 100_000,
	maxLoadedPatchBytes: 10_000_000,
	maxFileRows: 50_000,
	maxFilePatchBytes: 5_000_000,
	maxLineBytes: 20_000,
	maxContextLines: 50,
	bodyConcurrency: 4,
};

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

function fileNode(path: string): GitTreeNode {
	return { path, name: path, kind: 'file', staged: false, hasUnstaged: true };
}

function summaryFor(project: string, paths: string[]): GitReviewDocumentSummary {
	return {
		documentId: `doc:${project}`,
		project,
		mode: 'working',
		context: 5,
		files: paths.map((path) => ({
			path,
			indexStatus: ' ' as const,
			workTreeStatus: 'M' as const,
			category: 'normal' as const,
			additions: 1,
			deletions: 0,
			estimatedRows: 2,
			bodyState: 'unloaded' as const,
			bodyFingerprint: `fp:${path}`,
			isGenerated: false,
			isBinary: false,
			isTooLarge: false,
		})),
		limits: LIMITS,
	};
}

function snapshotFor(project: string, paths: string[]): GitWorkbenchSnapshotResponse {
	return {
		status: 'ready',
		project,
		target: {
			projectPath: project,
			repoRoot: project,
			worktreePath: project,
			label: project.split('/').pop() ?? project,
			branch: 'main',
			source: 'chat-project',
		},
		tree: { root: paths.map(fileNode), hasCommits: true, statsState: 'loaded' },
		reviewSummary: summaryFor(project, paths),
		selectedFile: paths[0] ?? null,
		firstBodyCandidates: [],
		snapshotId: `doc:${project}`,
		workbenchFingerprint: `v1:${project}`,
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
		context: { chatId, projectPath },
	};
}

function installRouters(): void {
	api.getGitTargetCandidates.mockImplementation((projectPath: string) =>
		Promise.resolve({ targets: [candidate(projectPath)] }),
	);
	api.getGitWorkbenchSnapshot.mockImplementation((projectPath: string) =>
		Promise.resolve(snapshotFor(projectPath, [`${projectPath.slice(1)}.ts`])),
	);
	comparisonApi.getGitComparisonSnapshot.mockImplementation((projectPath: string) =>
		Promise.resolve({
			status: 'ready',
			project: projectPath,
			repoRoot: projectPath,
			documentId: `cmp:${projectPath}`,
			mode: 'direct',
			from: {
				kind: 'revision',
				label: 'HEAD',
				requestedRevision: 'HEAD',
				revision: 'HEAD',
				hash: 'abc123',
				shortHash: 'abc123',
			},
			to: {
				kind: 'working-tree',
				label: 'Working tree',
				fingerprint: 'wt:1',
				shortFingerprint: 'wt:1',
			},
			effectiveFromHash: 'abc123',
			files: [],
			limits: LIMITS,
			firstBodyCandidates: [],
		} as never),
	);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 8; i += 1) {
		await Promise.resolve();
	}
}

describe('workbench surface chat-switch repro', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installRouters();
	});

	it('W1: select repo X, A->B->A keeps listings and review doc on X', async () => {
		const controller = new GitWorkbenchSurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await settle();

		await controller.target.selectTarget(candidate('/repo-x', { isCurrent: false }));
		await settle();
		expect(controller.workbench.projectPath).toBe('/repo-x');

		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		await controller.target.activate();
		await settle();
		expect(controller.workbench.projectPath).toBe('/project-b');
		expect(controller.workbench.review.summary?.project).toBe('/project-b');

		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await controller.target.activate();
		await settle();

		expect(controller.target.activeProjectPath).toBe('/repo-x');
		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		expect(controller.workbench.projectPath).toBe('/repo-x');
		expect(controller.workbench.review.summary?.project).toBe('/repo-x');
		expect(controller.workbench.files.filePaths).toContain('repo-x.ts');
		expect(controller.workbench.files.filePaths).not.toContain('project-b.ts');
	});

	it('W2: selecting chat B\'s repo in chat A, then visiting B and returning, stays coherent', async () => {
		const controller = new GitWorkbenchSurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await settle();

		// In chat A, point the workbench at chat B's repo.
		await controller.target.selectTarget(candidate('/project-b', { isCurrent: false }));
		await settle();
		expect(controller.workbench.projectPath).toBe('/project-b');

		// Visit chat B; same physical repo path, different chat identity.
		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		await controller.target.activate();
		await settle();
		expect(controller.workbench.projectPath).toBe('/project-b');
		// Work in B on the staged tab with an open comment composer.
		controller.workbench.setActiveTab('staged');
		await settle();
		controller.workbench.drafts.openCommentComposer('project-b.ts', 'after', 1);
		expect(controller.workbench.drafts.commentComposer.open).toBe(true);

		// Return to chat A (remembered target is /project-b as well).
		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await controller.target.activate();
		await settle();

		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		expect(controller.workbench.projectPath).toBe('/project-b');
		// The loaded review document must correspond to the active tab: the last
		// snapshot request's tab must equal the current activeTab.
		const lastSnapshotCall = api.getGitWorkbenchSnapshot.mock.calls.at(-1);
		expect(lastSnapshotCall?.[1]).toBe(controller.workbench.files.activeTab);
		// Chat B's open composer must not leak into chat A's surface identity.
		expect(controller.workbench.drafts.commentComposer.open).toBe(false);
		// Comment composer must be functional: open it and confirm the state sticks.
		controller.workbench.drafts.openCommentComposer('project-b.ts', 'after', 1);
		expect(controller.workbench.drafts.commentComposer.open).toBe(true);
	});
});

describe('compare surface chat-switch repro', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installRouters();
	});

	it('C1: A->B->A reloads Compare for the remembered target and keeps comments openable', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await settle();
		expect(controller.comparison.snapshot?.repoRoot).toBe('/project-a');

		await controller.target.selectTarget(candidate('/repo-x', { isCurrent: false }));
		await settle();
		expect(controller.comparison.snapshot?.repoRoot).toBe('/repo-x');

		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		await controller.target.activate();
		await settle();
		expect(controller.comparison.snapshot?.repoRoot).toBe('/project-b');

		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await controller.target.activate();
		await settle();

		expect(controller.target.appliedIdentity).toBe(controller.target.identity);
		expect(controller.comparison.snapshot?.repoRoot).toBe('/repo-x');
		controller.comparison.document.openCommentComposer('any.ts', 'after', 1);
		expect(controller.comparison.document.commentComposer.open).toBe(true);
	});

	it('C2: a failed default compare is retried after the next chat switch back', async () => {
		const controller = new GitCompareSurfaceController(createGitSurfaceTestDeps());
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		controller.setPresentationVisible(true);
		await controller.target.activate();
		await settle();

		comparisonApi.getGitComparisonSnapshot.mockRejectedValueOnce(new Error('boom'));
		controller.setProjectState(resolvingProject('chat-b', '/project-b'));
		controller.setProjectState(availableProject('chat-b', '/project-b'));
		await controller.target.activate();
		await settle();
		expect(controller.comparison.error).toContain('boom');

		controller.setProjectState(resolvingProject('chat-a', '/project-a'));
		controller.setProjectState(availableProject('chat-a', '/project-a'));
		await controller.target.activate();
		await settle();

		expect(controller.comparison.snapshot?.repoRoot).toBe('/project-a');
		controller.comparison.document.openCommentComposer('any.ts', 'after', 1);
		expect(controller.comparison.document.commentComposer.open).toBe(true);
	});
});

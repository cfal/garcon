import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getGitStatus,
	getGitDiff,
	gitCommit,
	gitCheckout,
	gitCreateBranch,
	getBranches,
	getRemoteStatus,
	gitFetch,
	gitPull,
	gitPush,
	getGitRemotes,
	gitDiscard,
	gitDeleteUntracked,
	getGitWorkbenchSnapshot,
	getGitWorkbenchFingerprint,
	getGitQuickSummary,
	getGitReviewFileBodies,
	getGitHistoryCommits,
	getGitCommitSnapshot,
	getGitCommitFileBodies,
	getGitConflictDetails,
	getGitTargetCandidates,
	gitStageSelection,
	gitStageHunk,
	gitStageFile,
	gitCommitIndex,
	generateCommitMessage,
	getGitWorktrees,
	gitCreateWorktree,
	gitRemoveWorktree,
	gitRevertCommit,
} from '../git';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('git API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getGitStatus calls GET /api/v1/git/status with project param', async () => {
		const payload = {
			branch: 'main',
			hasCommits: true,
			modified: ['a.txt'],
			added: [],
			deleted: [],
			untracked: [],
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitStatus('/project');

		expect(result.branch).toBe('main');
		expect(result.modified).toEqual(['a.txt']);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/status');
		expect(url).toContain('project=%2Fproject');
	});

	it('getGitDiff calls GET with project and file params', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ diff: '+ line' }));

		const result = await getGitDiff('/project', 'a.txt');

		expect(result.diff).toBe('+ line');
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('file=a.txt');
	});

	it('gitCommit sends POST with project, message, files', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		const result = await gitCommit('/project', 'fix bug', ['a.txt', 'b.txt']);

		expect(result.success).toBe(true);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/commit');
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body);
		expect(body.project).toBe('/project');
		expect(body.message).toBe('fix bug');
		expect(body.files).toEqual(['a.txt', 'b.txt']);
	});

	it('gitCheckout sends POST with project and branch', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitCheckout('/project', 'feature');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.project).toBe('/project');
		expect(body.branch).toBe('feature');
	});

	it('gitCreateBranch sends POST with project and branch', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitCreateBranch('/project', 'new-branch');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.branch).toBe('new-branch');
	});

	it('getBranches calls GET with project param', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ branches: ['main', 'dev'] }));

		const result = await getBranches('/project');

		expect(result.branches).toEqual(['main', 'dev']);
	});

	it('getRemoteStatus calls GET with project param', async () => {
		const payload = {
			hasRemote: true,
			hasUpstream: true,
			branch: 'main',
			remoteName: 'origin',
			ahead: 1,
			behind: 0,
			isUpToDate: false,
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteStatus('/project');

		expect(result.hasRemote).toBe(true);
		expect(result.ahead).toBe(1);
	});

	it('gitFetch sends POST with project', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitFetch('/project');

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/fetch');
		expect(opts.method).toBe('POST');
	});

	it('gitPull sends POST with project', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitPull('/project');

		expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/git/pull');
	});

	it('gitPush sends POST with project, remote, and remoteBranch', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitPush('/project', 'origin', 'feature');

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/push');
		const body = JSON.parse(opts.body);
		expect(body.project).toBe('/project');
		expect(body.remote).toBe('origin');
		expect(body.remoteBranch).toBe('feature');
	});

	it('getGitRemotes calls GET with project param', async () => {
		const payload = { remotes: [{ name: 'origin', url: 'git@github.com:user/repo.git' }] };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitRemotes('/project');

		expect(result.remotes).toHaveLength(1);
		expect(result.remotes[0].name).toBe('origin');
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/remotes');
		expect(url).toContain('project=%2Fproject');
	});

	it('gitDiscard sends POST with project and file', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitDiscard('/project', 'a.txt');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.file).toBe('a.txt');
	});

	it('gitDeleteUntracked sends POST with project and file', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitDeleteUntracked('/project', 'temp.txt');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.file).toBe('temp.txt');
	});

	it('propagates ApiError on server error', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ error: 'Not a git repo' }, 400));

		await expect(getGitStatus('/bad')).rejects.toMatchObject({
			message: 'Not a git repo',
		});
	});

	// Workbench contract tests

	it('getGitWorkbenchSnapshot posts the first-paint workbench request', async () => {
		const payload = {
			status: 'ready',
			project: '/project',
			target: {
				projectPath: '/project',
				repoRoot: '/project',
				worktreePath: '/project',
				label: 'project',
				branch: 'main',
				source: 'chat-project',
			},
			tree: { root: [], hasCommits: true, statsState: 'loaded' },
			reviewSummary: {
				documentId: 'doc',
				project: '/project',
				mode: 'working',
				context: 5,
				files: [],
				limits: {},
			},
			selectedFile: null,
			firstBodyCandidates: [],
			snapshotId: 'doc',
			workbenchFingerprint: 'v1:baseline',
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitWorkbenchSnapshot('/project', 'unstaged', 5, {
			selectedFile: 'a.ts',
			bodyCandidateCount: 4,
		});

		expect(result.status).toBe('ready');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/workbench/snapshot');
		expect(opts.method).toBe('POST');
		expect(opts.selectedFile).toBeUndefined();
		expect(opts.bodyCandidateCount).toBeUndefined();
		const body = JSON.parse(opts.body);
		expect(body).toEqual({
			project: '/project',
			mode: 'working',
			context: 5,
			selectedFile: 'a.ts',
			bodyCandidateCount: 4,
		});
	});

	it('getGitWorkbenchSnapshot maps staged tab to staged mode', async () => {
		fetchMock.mockResolvedValue(jsonResponse({
			status: 'not-git-repository',
			project: '/project',
			target: null,
			tree: null,
			reviewSummary: null,
			selectedFile: null,
			firstBodyCandidates: [],
			message: 'Git is not initialized in this directory.',
		}));

		await getGitWorkbenchSnapshot('/project', 'staged', 3);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.mode).toBe('staged');
		expect(body.context).toBe(3);
		expect(body.selectedFile).toBeNull();
		expect(body.bodyCandidateCount).toBe(8);
	});

	it('getGitWorkbenchFingerprint posts the current workbench fingerprint request', async () => {
		fetchMock.mockResolvedValue(jsonResponse({
			status: 'ready',
			project: '/project',
			fingerprintVersion: 1,
			fingerprint: 'v1:current',
			changedPathCount: 2,
		}));

		const result = await getGitWorkbenchFingerprint('/project');

		expect(result.status).toBe('ready');
		if (result.status === 'ready') {
			expect(result.fingerprint).toBe('v1:current');
			expect(result.changedPathCount).toBe(2);
		}
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/workbench/fingerprint');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ project: '/project' });
	});

	it('getGitQuickSummary posts the quick summary request', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				status: 'ready',
				project: '/project',
				repoRoot: '/project',
				branch: 'main',
				hasCommits: true,
				changedFiles: 2,
				trackedChangedFiles: 1,
				untrackedFiles: 1,
				stagedFiles: 1,
				unstagedFiles: 1,
				additions: 4,
				deletions: 1,
				fingerprintVersion: 1,
				fingerprint: 'v1:quick',
			}),
		);

		const result = await getGitQuickSummary('/project');

		expect(result.status).toBe('ready');
		if (result.status === 'ready') {
			expect(result.branch).toBe('main');
			expect(result.changedFiles).toBe(2);
		}
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/quick-summary');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({ project: '/project' });
	});

	it('getGitConflictDetails returns bounded conflict content metadata', async () => {
		const payload = {
			path: 'a.txt',
			base: { content: 'base', truncated: false, byteLength: 4, lineCount: 1 },
			ours: {
				content: null,
				truncated: true,
				byteLength: 300_000,
				lineCount: 0,
				limitReason: 'content-too-large',
			},
			theirs: { content: 'theirs', truncated: false, byteLength: 6, lineCount: 1 },
			working: { content: 'working', truncated: false, byteLength: 7, lineCount: 1 },
			truncated: true,
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitConflictDetails('/project', 'a.txt');

		expect(result.ours.content).toBeNull();
		expect(result.ours.limitReason).toBe('content-too-large');
		expect(result.truncated).toBe(true);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/conflict-details');
		expect(url).toContain('file=a.txt');
	});

	it('gitStageSelection sends POST with selection payload', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		const result = await gitStageSelection('/project', 'a.ts', 'stage', [1, 2, 3], 5);

		expect(result.success).toBe(true);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/stage-selection');
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body);
		expect(body.file).toBe('a.ts');
		expect(body.mode).toBe('stage');
		expect(body.selection.lineIndices).toEqual([1, 2, 3]);
		expect(body.contextLines).toBe(5);
	});

	it('gitStageHunk sends POST with hunkIndex', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		const result = await gitStageHunk('/project', 'a.ts', 'stage', 0, 5);

		expect(result.success).toBe(true);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.hunkIndex).toBe(0);
	});

	it('getGitWorktrees calls GET with project', async () => {
		const payload = {
			worktrees: [
				{
					name: 'main',
					path: '/repo',
					branch: 'main',
					isCurrent: true,
					isMain: true,
					isPathMissing: false,
				},
			],
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));
		const controller = new AbortController();

		const result = await getGitWorktrees('/project', { signal: controller.signal });

		expect(result.worktrees).toHaveLength(1);
		expect(result.worktrees[0].name).toBe('main');
		const [, opts] = fetchMock.mock.calls[0];
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});

	it('gitCreateWorktree sends POST with worktreePath and options', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitCreateWorktree('/project', '/tmp/wt', { branch: 'feat', baseRef: 'main' });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.worktreePath).toBe('/tmp/wt');
		expect(body.branch).toBe('feat');
		expect(body.baseRef).toBe('main');
	});

	it('gitRemoveWorktree sends POST with worktreePath and force', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitRemoveWorktree('/project', '/tmp/wt', true);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.worktreePath).toBe('/tmp/wt');
		expect(body.force).toBe(true);
	});

	it('gitRevertCommit sends POST with commit hash', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitRevertCommit('/project', 'abcdef123');

		const [url] = fetchMock.mock.calls[0];
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(url).toBe('/api/v1/git/revert-commit');
		expect(body.commit).toBe('abcdef123');
	});

	it('gitCommitIndex sends POST with project and message', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, output: 'commit abc123' }));

		const result = await gitCommitIndex('/project', 'feat: add login');

		expect(result.success).toBe(true);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/commit-index');
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body);
		expect(body.project).toBe('/project');
		expect(body.message).toBe('feat: add login');
	});

	it('generateCommitMessage posts only project and files', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				message: 'src/app: feat: add login',
				directoryPrefix: 'src/app',
			}),
		);

		const result = await generateCommitMessage('/project', ['src/app/login.ts']);

		expect(result.message).toBe('src/app: feat: add login');
		expect(result.directoryPrefix).toBe('src/app');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/generate-commit-message');
		expect(opts.method).toBe('POST');
		expect(JSON.parse(opts.body)).toEqual({
			project: '/project',
			files: ['src/app/login.ts'],
		});
	});

	it('gitStageFile sends POST with project, file, and mode', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		const result = await gitStageFile('/project', 'new-file.ts', 'stage');

		expect(result.success).toBe(true);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/stage-file');
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body);
		expect(body.project).toBe('/project');
		expect(body.file).toBe('new-file.ts');
		expect(body.mode).toBe('stage');
	});

	it('getGitReviewFileBodies posts document-scoped file body requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ documentId: 'doc', files: {}, errors: {} }));

		await getGitReviewFileBodies('/project', 'doc', ['a.ts', 'b.ts'], 'staged', 3);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/review-document/files');
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body);
		expect(body).toEqual({
			project: '/project',
			documentId: 'doc',
			files: ['a.ts', 'b.ts'],
			mode: 'staged',
			context: 3,
		});
	});

	it('getGitHistoryCommits posts paginated history requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({
			project: '/project',
			ref: 'main',
			commits: [],
			nextOffset: null,
		}));
		const controller = new AbortController();

		const result = await getGitHistoryCommits('/project', {
			ref: 'main',
			limit: 25,
			offset: 50,
			signal: controller.signal,
		});

		expect(result.ref).toBe('main');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/history/commits');
		expect(opts.method).toBe('POST');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(opts.body)).toEqual({
			project: '/project',
			ref: 'main',
			limit: 25,
			offset: 50,
		});
	});

	it('getGitCommitSnapshot posts commit details requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({
			status: 'not-found',
			project: '/project',
			commit: 'abc',
			message: 'Commit was not found in this repository.',
		}));
		const controller = new AbortController();

		const result = await getGitCommitSnapshot('/project', 'abc', {
			parent: 'parent',
			context: 7,
			bodyCandidateCount: 3,
			signal: controller.signal,
		});

		expect(result.status).toBe('not-found');
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/history/commit/snapshot');
		expect(opts.method).toBe('POST');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(opts.body)).toEqual({
			project: '/project',
			commit: 'abc',
			parent: 'parent',
			context: 7,
			bodyCandidateCount: 3,
		});
	});

	it('getGitCommitFileBodies posts commit file body requests', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ documentId: 'doc', files: {}, errors: {} }));
		const controller = new AbortController();

		await getGitCommitFileBodies('/project', 'doc', 'abc', ['a.ts'], {
			parent: null,
			context: 4,
			signal: controller.signal,
		});

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/git/history/commit/files');
		expect(opts.method).toBe('POST');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(opts.body)).toEqual({
			project: '/project',
			documentId: 'doc',
			commit: 'abc',
			parent: null,
			context: 4,
			files: ['a.ts'],
		});
	});

	it('getGitTargetCandidates calls GET with encoded project', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ targets: [] }));
		const controller = new AbortController();

		const result = await getGitTargetCandidates('/repo with space', { signal: controller.signal });

		expect(result.targets).toEqual([]);
		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/targets');
		expect(url).toContain('project=%2Frepo%20with%20space');
		expect(opts.signal).toBeInstanceOf(AbortSignal);
	});
});

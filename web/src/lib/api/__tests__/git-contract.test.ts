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
	getGitFileReviewData,
	getGitChangesTree,
	gitStageSelection,
	gitStageHunk,
	gitStageFile,
	gitCommitIndex,
	getGitWorktrees,
	gitCreateWorktree,
	gitRemoveWorktree,
	gitRevertLastCommit,
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
			branch: 'main', hasCommits: true,
			modified: ['a.txt'], added: [], deleted: [], untracked: [],
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
			hasRemote: true, hasUpstream: true, branch: 'main',
			remoteName: 'origin', ahead: 1, behind: 0, isUpToDate: false,
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

	// Workbench V2 contract tests

	it('getGitFileReviewData calls GET with file/mode/context for unstaged tab', async () => {
		const payload = {
			path: 'a.ts', isBinary: false,
			truncated: false, contentBefore: '', contentAfter: '',
			diffOps: [], hunks: [],
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitFileReviewData('/project', 'a.ts', 'unstaged', 5);

		expect(result.path).toBe('a.ts');
		expect(result.diffOps).toEqual([]);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/file-review-data');
		expect(url).toContain('file=a.ts');
		expect(url).toContain('mode=working');
		expect(url).toContain('context=5');
	});

	it('getGitChangesTree calls GET with project', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ root: [] }));

		const result = await getGitChangesTree('/project');

		expect(result.root).toEqual([]);
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('/api/v1/git/changes-tree');
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
		const payload = { worktrees: [{ name: 'main', path: '/repo', branch: 'main', isCurrent: true, isMain: true, isPathMissing: false }] };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitWorktrees('/project');

		expect(result.worktrees).toHaveLength(1);
		expect(result.worktrees[0].name).toBe('main');
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

	it('gitRevertLastCommit sends POST with strategy', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));

		await gitRevertLastCommit('/project', 'reset-soft');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.strategy).toBe('reset-soft');
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

	it('getGitChangesTree returns hasCommits field', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ root: [], hasCommits: true }));

		const result = await getGitChangesTree('/project');

		expect(result.hasCommits).toBe(true);
		expect(result.root).toEqual([]);
	});

	it('getGitFileReviewData sends mode=staged for staged tab', async () => {
		const payload = {
			path: 'a.ts', isBinary: false,
			truncated: false, contentBefore: 'old', contentAfter: 'new',
			diffOps: [], hunks: [],
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getGitFileReviewData('/project', 'a.ts', 'staged', 3);

		expect(result.contentBefore).toBe('old');
		expect(result.contentAfter).toBe('new');
		const [url] = fetchMock.mock.calls[0];
		expect(url).toContain('mode=staged');
		expect(url).toContain('context=3');
	});
});

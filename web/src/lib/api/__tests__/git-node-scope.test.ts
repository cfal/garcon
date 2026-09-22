import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getGitStatus, gitCommitIndex, gitStageHunk } from '../git.js';
import { getGitReviewDocumentFileBodies } from '../git-review-documents.js';
import { getPullRequest } from '../pull-requests.js';

const target = { nodeId: 'remote-node', projectPath: '/project' };
const scope = { nodeId: target.nodeId, instanceId: 'instance-a' };
const document = { ...scope, documentId: 'document-a' };
const fetchMock = vi.fn<typeof fetch>();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Git node response boundaries', () => {
	it('rejects a Local response to an explicit remote read', async () => {
		fetchMock.mockResolvedValue(response({ ...scope, nodeId: 'local' }));
		await expect(getGitStatus(target)).rejects.toMatchObject({ errorCode: 'GIT_INVALID_RESULT' });
		expect(fetchMock.mock.calls[0][0]).toContain('nodeId=remote-node');
	});

	it.each([
		{ ...scope, nodeId: 'local', success: true },
		{ ...scope },
		{ ...scope, success: 'yes' },
	])('does not confirm malformed or retargeted mutations: %j', async (value) => {
		fetchMock.mockResolvedValue(response(value));
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('classifies a lost HTTP reply as uncertain without retrying', async () => {
		fetchMock.mockRejectedValue(new TypeError('Connection lost'));
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('preserves typed rejection before dispatch', async () => {
		fetchMock.mockResolvedValue(
			response(
				{
					success: false,
					error: 'Offline',
					errorCode: 'EXECUTION_NODE_UNAVAILABLE',
					retryable: false,
				},
				503,
			),
		);
		await expect(gitCommitIndex(target, 'synthetic commit')).rejects.toMatchObject({
			errorCode: 'EXECUTION_NODE_UNAVAILABLE',
		});
	});

	it('submits the exact captured partial-staging proof', async () => {
		fetchMock.mockResolvedValue(response({ ...scope, success: true }));
		const proof = { document, bodyFingerprint: 'fingerprint', patchDigest: 'a'.repeat(64) };
		await gitStageHunk(target, 'file.ts', 'stage', 0, 5, proof);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			nodeId: target.nodeId,
			project: '/project',
			...proof,
			hunkIndex: 0,
			contextLines: 5,
		});
	});

	it('rejects review bodies from a replacement serving instance', async () => {
		fetchMock.mockResolvedValue(
			response({
				...scope,
				instanceId: 'instance-b',
				status: 'ready',
				documentId: document.documentId,
				files: {},
				errors: {},
			}),
		);
		await expect(
			getGitReviewDocumentFileBodies(target, document, ['file.ts'], 'visible'),
		).rejects.toMatchObject({ errorCode: 'GIT_STALE_DOCUMENT' });
	});

	it('qualifies PR rendering identities by node, instance, and project', async () => {
		const payload = { ...scope, number: 1, updatedAt: '2026-01-01', fileBodies: {} };
		fetchMock.mockImplementation(async () => response(payload));
		const first = await getPullRequest(target, 1);
		const second = await getPullRequest({ ...target, projectPath: '/other' }, 1);
		expect(first.documentId).not.toBe(second.documentId);
		expect(first.documentId).toContain('remote-node');
	});
});

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { GIT_REVIEW_DOCUMENT_LIMITS } from '../../git/types.js';

class MalformedJsonError extends Error {}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock((request) => request.json()),
  MalformedJsonError,
}));

const { createGitComparisonRoutes } = await import('../git-comparisons.js');

const snapshotCalls = [];
const bodyCalls = [];
const git = {
  getComparisonSnapshot: mock(async (options) => {
    snapshotCalls.push(options);
    return {
      status: 'not-found',
      project: options.projectPath,
      endpoint: 'from',
      revision: options.from.revision,
      message: 'Missing revision.',
    };
  }),
  getComparisonFileBodies: mock(async (options) => {
    bodyCalls.push(options);
    return {
      status: 'stale',
      documentId: options.documentId,
      expectedFingerprint: options.to.fingerprint,
      actualFingerprint: 'changed',
      message: 'Working Tree changed.',
    };
  }),
  toHttpError: (error) => Response.json({ error: String(error) }, { status: 500 }),
};
const routes = createGitComparisonRoutes(git);
const snapshotHandler = routes['/api/v1/git/comparisons/snapshot'].POST;
const filesHandler = routes['/api/v1/git/comparisons/files'].POST;

function request(path, body, signal) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

describe('Git comparison route contracts', () => {
  beforeEach(() => {
    snapshotCalls.length = 0;
    bodyCalls.length = 0;
    git.getComparisonSnapshot.mockClear();
    git.getComparisonFileBodies.mockClear();
  });

	it('forwards a typed snapshot request and its abort signal', async () => {
		const controller = new AbortController();
		const inputRequest = request('/api/v1/git/comparisons/snapshot', {
			project: '/project',
      from: { kind: 'revision', revision: 'main' },
      to: { kind: 'working-tree' },
      mode: 'direct',
      context: 7,
      bodyCandidateCount: 4,
		}, controller.signal);
		const response = await snapshotHandler(inputRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'not-found', endpoint: 'from' });
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toMatchObject({
      projectPath: '/project',
      from: { kind: 'revision', revision: 'main' },
      to: { kind: 'working-tree' },
      mode: 'direct',
      context: 7,
      bodyCandidateCount: 4,
    });
		expect(snapshotCalls[0].signal).toBe(inputRequest.signal);
  });

  it.each([
    [{ kind: 'working-tree' }, { kind: 'revision', revision: 'main' }],
    [{ kind: 'revision', revision: '' }, { kind: 'revision', revision: 'main' }],
    [{ kind: 'revision', revision: 'main' }, { kind: 'unknown' }],
  ])('rejects malformed endpoint discriminants', async (from, to) => {
    const response = await snapshotHandler(request('/api/v1/git/comparisons/snapshot', {
      project: '/project',
      from,
      to,
      mode: 'direct',
    }));

    expect(response.status).toBe(400);
    expect(git.getComparisonSnapshot).not.toHaveBeenCalled();
  });

  it('rejects merge-base mode with a Working Tree target', async () => {
    const response = await snapshotHandler(request('/api/v1/git/comparisons/snapshot', {
      project: '/project',
      from: { kind: 'revision', revision: 'main' },
      to: { kind: 'working-tree' },
      mode: 'merge-base',
    }));

    expect(response.status).toBe(400);
    expect(git.getComparisonSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'empty batch'],
    [[{ path: 'bad\0path' }], 'NUL path'],
    [Array.from({ length: GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles + 1 }, (_, index) => ({ path: `file-${index}` })), 'oversized batch'],
  ])('rejects an invalid body request: %s', async (files) => {
    const response = await filesHandler(request('/api/v1/git/comparisons/files', {
      project: '/project',
      documentId: 'document',
      effectiveFromHash: 'a'.repeat(40),
      to: { kind: 'working-tree', fingerprint: 'fingerprint' },
      context: 5,
      files,
    }));

    expect(response.status).toBe(400);
    expect(git.getComparisonFileBodies).not.toHaveBeenCalled();
  });

	it('serializes typed body statuses and forwards the abort signal', async () => {
		const controller = new AbortController();
		const inputRequest = request('/api/v1/git/comparisons/files', {
      project: '/project',
      documentId: 'document',
      effectiveFromHash: 'a'.repeat(40),
      to: { kind: 'working-tree', fingerprint: 'fingerprint' },
      context: 5,
      files: [{ path: 'a.ts', originalPath: 'old-a.ts' }],
		}, controller.signal);
		const response = await filesHandler(inputRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'stale', actualFingerprint: 'changed' });
    expect(bodyCalls[0]).toMatchObject({
      documentId: 'document',
      files: [{ path: 'a.ts', originalPath: 'old-a.ts' }],
    });
		expect(bodyCalls[0].signal).toBe(inputRequest.signal);
  });
});

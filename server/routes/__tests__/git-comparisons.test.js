import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { GIT_REVIEW_DOCUMENT_LIMITS } from '../../git/types.js';

class MalformedJsonError extends Error {}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock((request) => request.json()),
  MalformedJsonError,
}));

const { createGitComparisonRoutes } = await import('../git-comparisons.js');

const snapshotCalls = [];
const freshnessCalls = [];
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
  getComparisonFreshness: mock(async (options) => {
    freshnessCalls.push(options);
    return {
      status: 'ready',
      project: options.projectPath,
      changedEndpoints: ['to'],
      fromHash: options.from.hash,
      to: options.to.kind === 'revision'
        ? { kind: 'revision', hash: 'c'.repeat(40) }
        : { kind: 'working-tree', fingerprint: 'changed' },
    };
  }),
  toHttpError: (error) => Response.json({ error: String(error) }, { status: 500 }),
};
const routes = createGitComparisonRoutes(git);
const snapshotHandler = routes['/api/v1/git/comparisons/snapshot'].POST;
const freshnessHandler = routes['/api/v1/git/comparisons/freshness'].POST;

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
    freshnessCalls.length = 0;
    git.getComparisonSnapshot.mockClear();
    git.getComparisonFreshness.mockClear();
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
    [{ context: -1 }, 'negative context'],
    [{ context: GIT_REVIEW_DOCUMENT_LIMITS.maxContextLines + 1 }, 'excessive context'],
    [{ bodyCandidateCount: 0 }, 'empty eager batch'],
    [
      { bodyCandidateCount: GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles + 1 },
      'excessive eager batch',
    ],
  ])('rejects invalid snapshot limits: %s', async (limits) => {
    const response = await snapshotHandler(request('/api/v1/git/comparisons/snapshot', {
      project: '/project',
      from: { kind: 'revision', revision: 'main' },
      to: { kind: 'working-tree' },
      mode: 'direct',
      ...limits,
    }));

    expect(response.status).toBe(400);
    expect(git.getComparisonSnapshot).not.toHaveBeenCalled();
  });

  it('forwards frozen revision identities to the freshness operation', async () => {
    const controller = new AbortController();
    const inputRequest = request('/api/v1/git/comparisons/freshness', {
      project: '/project',
      from: { kind: 'revision', revision: 'origin/main', hash: 'a'.repeat(40) },
      to: { kind: 'revision', revision: 'HEAD', hash: 'b'.repeat(40) },
    }, controller.signal);
    const response = await freshnessHandler(inputRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ready',
      changedEndpoints: ['to'],
    });
    expect(freshnessCalls[0]).toMatchObject({
      projectPath: '/project',
      from: { kind: 'revision', revision: 'origin/main', hash: 'a'.repeat(40) },
      to: { kind: 'revision', revision: 'HEAD', hash: 'b'.repeat(40) },
    });
    expect(freshnessCalls[0].signal).toBe(inputRequest.signal);
  });

  it.each([
    [
      { kind: 'revision', revision: 'main', hash: 'short' },
      { kind: 'working-tree', fingerprint: 'fp' },
    ],
    [
      { kind: 'revision', revision: '', hash: 'a'.repeat(40) },
      { kind: 'working-tree', fingerprint: 'fp' },
    ],
    [
      { kind: 'revision', revision: 'main', hash: 'a'.repeat(40) },
      { kind: 'revision', revision: 'HEAD', hash: 'bad' },
    ],
    [
      { kind: 'revision', revision: 'main', hash: 'a'.repeat(40) },
      { kind: 'working-tree', fingerprint: '' },
    ],
  ])('rejects malformed comparison freshness identities', async (from, to) => {
    const response = await freshnessHandler(request('/api/v1/git/comparisons/freshness', {
      project: '/project',
      from,
      to,
    }));

    expect(response.status).toBe(400);
    expect(git.getComparisonFreshness).not.toHaveBeenCalled();
  });

});

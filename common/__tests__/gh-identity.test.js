import { expect, test } from 'bun:test';
import { ghRepositoryIdentity, sameGhRepository } from '../gh-identity.js';
import { validateGhRequest } from '../git-request-validation.js';
import { validateGhResult } from '../git-result-validation.js';

const repository = { host: 'github.example.invalid', nameWithOwner: 'acme/app' };
const actor = { id: 'actor-a', login: 'viewer' };

test('repository identity includes the host and agrees with the canonical URL', () => {
  expect(ghRepositoryIdentity({ nameWithOwner: 'Acme/App', url: 'https://GitHub.example.invalid/Acme/App/' })).toEqual(repository);
  expect(sameGhRepository(repository, { ...repository, nameWithOwner: 'Acme/App' })).toBe(true);
  expect(sameGhRepository(repository, { ...repository, host: 'another.example.invalid' })).toBe(false);
  for (const url of ['https://github.example.invalid/other/app', 'https://viewer@github.example.invalid/acme/app', 'http://github.example.invalid/acme/app']) {
    expect(ghRepositoryIdentity({ nameWithOwner: 'acme/app', url })).toBeNull();
  }
});

test('GitHub operations require explicit destination and mutation actor identities', () => {
  const requests = [
    ['getPullRequest', { projectPath: '/work/app', repository, number: 7 }],
    ['getPullRequestReviewTarget', { projectPath: '/work/app', repository, number: 7, marker: 'garcon-review ' }],
    ['createPullRequestComment', { projectPath: '/work/app', repository, actor, expected: { state: "open", headRefOid: "a".repeat(40) }, number: 7, body: 'Review' }],
    ['minimizePullRequestComment', { projectPath: '/work/app', repository, actor, commentId: 'comment' }],
  ];
  for (const [method, request] of requests) {
    expect(() => validateGhRequest(method, request)).not.toThrow();
    expect(() => validateGhRequest(method, { ...request, repository: undefined })).toThrow();
    expect(() => validateGhRequest(method, { ...request, repository: { host: '--invalid', nameWithOwner: 'acme/app' } })).toThrow();
    if ('actor' in request) {
      expect(() => validateGhRequest(method, { ...request, actor: { login: 'viewer' } })).toThrow();
    }
  }
  expect(() => validateGhRequest('listPullRequests', { projectPath: '/work/app' })).not.toThrow();
  expect(() => validateGhRequest('listPullRequests', { projectPath: '/work/app', repository })).not.toThrow();
});

test('reconciliation responses preserve viewer and comment author identities', () => {
  const scope = { executorId: 'local', instanceId: 'instance' };
  const comment = { id: 'comment', url: '', marker: 'marker', isMinimized: false, author: actor };
  const target = { ...scope, repository, viewer: actor, number: 7, state: 'open', headRefOid: 'a'.repeat(40), markedComments: [comment] };
  expect(() => validateGhResult('getPullRequestReviewTarget', target, scope)).not.toThrow();
  for (const invalid of [
    { ...target, viewer: { login: 'viewer' } },
    { ...target, repository: { nameWithOwner: 'acme/app' } },
    { ...target, markedComments: [{ ...comment, author: undefined }] },
  ]) expect(() => validateGhResult('getPullRequestReviewTarget', invalid, scope)).toThrow();
});

test('comment creation requires the reviewed open head before mutation admission', () => {
  const request = { projectPath: '/work/app', repository, actor, number: 7, body: 'Review' };
  for (const headRefOid of ['a'.repeat(40), 'b'.repeat(64)]) {
    expect(() => validateGhRequest('createPullRequestComment', { ...request, expected: { state: 'open', headRefOid } })).not.toThrow();
  }
  for (const expected of [undefined, { state: 'closed', headRefOid: 'a'.repeat(40) }, { state: 'open', headRefOid: 'a'.repeat(41) },
    { state: 'open', headRefOid: 'main' }, { state: 'open', headRefOid: 'a'.repeat(40), extra: true }]) {
    expect(() => validateGhRequest('createPullRequestComment', { ...request, expected })).toThrow();
  }
});

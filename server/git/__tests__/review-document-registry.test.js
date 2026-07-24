import { describe, expect, it } from 'bun:test';
import { GitReviewDocumentRegistry } from '../review-document-registry.js';

function reviewFile(path, bodyFingerprint = `fingerprint:${path}`) {
  return {
    path,
    change: { kind: 'tree-diff', status: 'modified', rawStatus: 'M' },
    category: 'normal',
    additions: 1,
    deletions: 1,
    estimatedRows: 3,
    bodyState: 'unloaded',
    bodyFingerprint,
    isBinary: false,
    isTooLarge: false,
  };
}

function registration(files = [reviewFile('src/file.ts')]) {
  return {
    sourceCacheKey: 'comparison:/repo:base:target:3',
    projectPath: '/repo',
    repoRoot: '/repo',
    context: 3,
    source: {
      kind: 'comparison-revisions',
      effectiveFromHash: 'base',
      toHash: 'target',
    },
    files,
  };
}

function patchBody(path = 'src/file.ts') {
  return {
    path,
    bodyFingerprint: `fingerprint:${path}`,
    bodyState: 'loaded',
    category: 'normal',
    isBinary: false,
    isTooLarge: false,
    renderedRowCount: 2,
    patchBytes: 20,
    patch: '@@ -1 +1 @@\n-old\n+new\n',
  };
}

describe('GitReviewDocumentRegistry', () => {
  it('reuses identical content and supersedes changed content', () => {
    const registry = new GitReviewDocumentRegistry();
    const first = registry.register(registration());
    const same = registry.register(registration());
    const firstLease = registry.acquire('/repo', first.id);

    expect(same.id).toBe(first.id);
    expect(same.generation).toBe(1);

    const changed = registry.register(
      registration([reviewFile('src/file.ts', 'fingerprint:changed')]),
    );
    expect(changed.id).not.toBe(first.id);
    expect(changed.generation).toBe(2);

    firstLease?.setBodies([patchBody()]);
    expect(firstLease?.getBody('src/file.ts')).toBeNull();
    firstLease?.release();
    expect(registry.acquire('/repo', first.id)).toBeNull();
  });

  it('keeps a leased document alive through expiry', () => {
    let now = 0;
    const registry = new GitReviewDocumentRegistry({
      now: () => now,
      idleTtlMs: 10,
    });
    const document = registry.register(registration());
    const lease = registry.acquire('/repo', document.id);

    now = 20;
    const secondLease = registry.acquire('/repo', document.id);
    expect(secondLease).not.toBeNull();
    secondLease?.release();
    lease?.release();
    now = 40;
    expect(registry.acquire('/repo', document.id)).toBeNull();
  });

  it('isolates projects and caches compact bodies', () => {
    const registry = new GitReviewDocumentRegistry();
    const document = registry.register(registration());

    expect(registry.acquire('/other', document.id)).toBeNull();

    const lease = registry.acquire('/repo', document.id);
    lease?.setBodies([patchBody()]);
    expect(lease?.getBody('src/file.ts')).toEqual(patchBody());
    lease?.release();
  });
});

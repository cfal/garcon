import { describe, expect, it } from 'bun:test';
import { GitDomainError } from '../git-domain-error.js';
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

function registration(
  files = [reviewFile('src/file.ts')],
  sourceCacheKey = 'comparison:/repo:base:target:3',
) {
  return {
    sourceCacheKey,
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
    patchDigest: '282a2db76b7b6a37366d552d1d46808d923519b79e25291603bb4556d8960e4e',
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
  it('copies immutable summaries and fences their repository, source, context and lifetime', () => {
    let now = 0;
    const registry = new GitReviewDocumentRegistry({ now: () => now, idleTtlMs: 10 });
    const input = registration();
    const document = registry.register(input);
    const files = [{ ...reviewFile('src/file.ts'), status: 'modified', rawStatus: 'M', isGenerated: false }];
    registry.rememberComparisonSummary(document.id, files, 5);
    files[0].additions = 999;
    const cached = registry.findComparisonSummary(input);
    expect(cached).toMatchObject({ documentId: document.id, totalFilesKnown: 5, files: [{ additions: 1 }] });
    cached.files[0].additions = 100;
    expect(registry.findComparisonSummary(input).files[0].additions).toBe(1);
    for (const changed of [
      { projectPath: '/other' }, { repoRoot: '/other' }, { context: 4 },
      { source: { ...input.source, toHash: 'new-target' } },
      { source: { kind: 'comparison-working-tree', effectiveFromHash: 'base', fingerprint: 'working' } },
    ]) expect(registry.findComparisonSummary({ ...input, ...changed })).toBeNull();
    expect(new GitReviewDocumentRegistry().findComparisonSummary(input)).toBeNull();
    now = 20;
    expect(registry.findComparisonSummary(input)).toBeNull();
    expect(registry.acquire('/repo', document.id)).toBeNull();
  });

  it('evicts summary payloads without evicting documents or bodies', () => {
    const files = [{ ...reviewFile('src/file.ts'), status: 'modified', rawStatus: 'M', isGenerated: false }];
    const bytes = Buffer.byteLength(JSON.stringify({ files, totalFilesKnown: 1 }));
    let now = 0;
    const registry = new GitReviewDocumentRegistry({ maxSummaryBytes: bytes, now: () => now });
    const first = registry.register(registration(undefined, 'first'));
    registry.rememberComparisonSummary(first.id, files, 1);
    const lease = registry.acquire('/repo', first.id);
    lease.setBodies([patchBody()]);
    now++;
    const second = registry.register(registration(undefined, 'second'));
    registry.rememberComparisonSummary(second.id, files, 1);
    expect(registry.findComparisonSummary(registration(undefined, 'first'))).toBeNull();
    expect(registry.findComparisonSummary(registration(undefined, 'second'))).not.toBeNull();
    expect(lease.getBody('src/file.ts')).toEqual(patchBody());
    lease.release();
    registry.register(registration([reviewFile('src/file.ts', 'changed')], 'second'));
    expect(registry.findComparisonSummary(registration(undefined, 'second'))).toBeNull();
  });

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

  it('keeps identical documents independently acquirable across project paths', () => {
    const registry = new GitReviewDocumentRegistry();
    const first = registry.register(registration());
    const second = registry.register({
      ...registration(),
      projectPath: '/repo/subdirectory',
    });

    expect(second.id).not.toBe(first.id);
    const firstLease = registry.acquire('/repo', first.id);
    const secondLease = registry.acquire('/repo/subdirectory', second.id);
    expect(firstLease).not.toBeNull();
    expect(secondLease).not.toBeNull();
    firstLease?.release();
    secondLease?.release();
  });

  it('rejects bodies that do not belong to the leased document', () => {
    const registry = new GitReviewDocumentRegistry();
    const document = registry.register(registration());
    const lease = registry.acquire('/repo', document.id);

    expect(() => lease?.setBodies([patchBody('other.ts')])).toThrow(
      'Refusing to cache an invalid review body',
    );
    expect(() =>
      lease?.setBodies([{ ...patchBody(), bodyFingerprint: 'wrong' }]),
    ).toThrow('Refusing to cache an invalid review body');
    expect(() =>
      lease?.setBodies([patchBody(), patchBody('other.ts')]),
    ).toThrow('Refusing to cache an invalid review body');
    expect(lease?.getBody('src/file.ts')).toBeNull();
    lease?.release();
  });

  it('evicts the least recently used idle document', () => {
    let now = 0;
    const registry = new GitReviewDocumentRegistry({
      maxIdleDocuments: 2,
      now: () => now,
    });
    const first = registry.register(registration(undefined, 'source:first'));
    now += 1;
    const second = registry.register(registration(undefined, 'source:second'));
    now += 1;
    const secondLease = registry.acquire('/repo', second.id);
    secondLease?.release();
    now += 1;
    const third = registry.register(registration(undefined, 'source:third'));

    expect(registry.acquire('/repo', first.id)).toBeNull();
    const retainedSecond = registry.acquire('/repo', second.id);
    const retainedThird = registry.acquire('/repo', third.id);
    expect(retainedSecond).not.toBeNull();
    expect(retainedThird).not.toBeNull();
    retainedSecond?.release();
    retainedThird?.release();
  });

  it('does not evict a leased document to admit beyond the hard limit', () => {
    const registry = new GitReviewDocumentRegistry({
      maxIdleDocuments: 1,
      maxTotalDocuments: 1,
    });
    const first = registry.register(registration(undefined, 'source:first'));
    const lease = registry.acquire('/repo', first.id);

    try {
      registry.register(registration(undefined, 'source:second'));
      throw new Error('Expected registry admission to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(GitDomainError);
      expect(error).toMatchObject({
        code: 'SERVICE_BUSY',
        message: expect.stringContaining('Too many active Git review documents'),
      });
    }
    lease?.release();
  });

  it('drops older idle bodies when the cache byte budget is exceeded', () => {
    const registry = new GitReviewDocumentRegistry({ maxBodyBytes: 20 });
    const first = registry.register(registration(undefined, 'source:first'));
    const firstLease = registry.acquire('/repo', first.id);
    firstLease?.setBodies([patchBody()]);
    firstLease?.release();

    const second = registry.register(registration(undefined, 'source:second'));
    const secondLease = registry.acquire('/repo', second.id);
    secondLease?.setBodies([patchBody()]);

    const reloadedFirst = registry.acquire('/repo', first.id);
    expect(reloadedFirst?.getBody('src/file.ts')).toBeNull();
    expect(secondLease?.getBody('src/file.ts')).toEqual(patchBody());
    reloadedFirst?.release();
    secondLease?.release();
  });
});

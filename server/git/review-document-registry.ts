import { randomUUID } from 'crypto';
import type {
  GitCommitFileStatus,
  GitFileReviewCategory,
  GitReviewBodyState,
  GitReviewFilePatchBody,
  GitReviewLimitReason,
  GitReviewMode,
} from './types.js';
import type { GitWorkingPathToken } from './working-path-token.js';

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_IDLE_DOCUMENTS = 32;
const DEFAULT_MAX_TOTAL_DOCUMENTS = 64;
const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;

export type GitReviewDocumentSource =
  | {
      kind: 'workbench';
      mode: GitReviewMode;
      stagedBaseHash: string;
    }
  | {
      kind: 'commit';
      baseHash: string;
      targetHash: string;
    }
  | {
      kind: 'comparison-revisions';
      effectiveFromHash: string;
      toHash: string;
    }
  | {
      kind: 'comparison-working-tree';
      effectiveFromHash: string;
      fingerprint: string;
    };

export interface RegisteredGitReviewFile {
  path: string;
  originalPath?: string;
  change:
    | { kind: 'workbench'; indexStatus: string; workTreeStatus: string }
    | { kind: 'tree-diff'; status: GitCommitFileStatus; rawStatus: string };
  category: GitFileReviewCategory;
  additions: number;
  deletions: number;
  estimatedRows: number;
  bodyState: GitReviewBodyState;
  bodyFingerprint: string;
  isBinary: boolean;
  isTooLarge: boolean;
  limitReason?: GitReviewLimitReason;
  limitMessage?: string;
}

export interface RegisteredGitReviewDocument {
  id: string;
  generation: number;
  sourceCacheKey: string;
  projectPath: string;
  repoRoot: string;
  context: number;
  source: GitReviewDocumentSource;
  filesByPath: ReadonlyMap<string, RegisteredGitReviewFile>;
  workingPathTokens: ReadonlyMap<string, GitWorkingPathToken>;
  createdAt: number;
  lastAccessedAt: number;
}

interface MutableRegisteredGitReviewDocument extends RegisteredGitReviewDocument {
  leaseCount: number;
  superseded: boolean;
  bodies: Map<string, GitReviewFilePatchBody>;
  bodyBytes: number;
}

export interface RegisterGitReviewDocumentInput {
  sourceCacheKey: string;
  projectPath: string;
  repoRoot: string;
  context: number;
  source: GitReviewDocumentSource;
  files: RegisteredGitReviewFile[];
  workingPathTokens?: ReadonlyMap<string, GitWorkingPathToken>;
}

export interface GitReviewDocumentLease {
  document: RegisteredGitReviewDocument;
  getBody(path: string): GitReviewFilePatchBody | null;
  setBodies(bodies: Iterable<GitReviewFilePatchBody>): void;
  release(): void;
}

interface GitReviewDocumentRegistryOptions {
  now?: () => number;
  idleTtlMs?: number;
  maxIdleDocuments?: number;
  maxTotalDocuments?: number;
  maxBodyBytes?: number;
}

function contentKey(input: RegisterGitReviewDocumentInput): string {
  return [
    input.sourceCacheKey,
    input.context,
    ...input.files.map((file) => `${file.path}\0${file.bodyFingerprint}`),
  ].join('\x1f');
}

export class GitReviewDocumentRegistry {
  private readonly documents = new Map<string, MutableRegisteredGitReviewDocument>();
  private readonly latestBySource = new Map<string, string>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private readonly maxIdleDocuments: number;
  private readonly maxTotalDocuments: number;
  private readonly maxBodyBytes: number;
  private totalBodyBytes = 0;

  constructor(options: GitReviewDocumentRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxIdleDocuments = options.maxIdleDocuments ?? DEFAULT_MAX_IDLE_DOCUMENTS;
    this.maxTotalDocuments = options.maxTotalDocuments ?? DEFAULT_MAX_TOTAL_DOCUMENTS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  register(input: RegisterGitReviewDocumentInput): RegisteredGitReviewDocument {
    this.prune();
    const previousId = this.latestBySource.get(input.sourceCacheKey);
    const previous = previousId ? this.documents.get(previousId) : undefined;
    const nextContentKey = contentKey(input);
    if (previous && !previous.superseded && contentKey({
      sourceCacheKey: previous.sourceCacheKey,
      projectPath: previous.projectPath,
      repoRoot: previous.repoRoot,
      context: previous.context,
      source: previous.source,
      files: Array.from(previous.filesByPath.values()),
      workingPathTokens: previous.workingPathTokens,
    }) === nextContentKey) {
      previous.lastAccessedAt = this.now();
      return previous;
    }

    if (this.documents.size >= this.maxTotalDocuments) {
      this.evictIdle(this.documents.size - this.maxTotalDocuments + 1);
    }
    if (this.documents.size >= this.maxTotalDocuments) {
      throw new Error('Too many active Git review documents. Try again shortly.');
    }

    if (previous) previous.superseded = true;
    const now = this.now();
    const document: MutableRegisteredGitReviewDocument = {
      id: randomUUID(),
      generation: (previous?.generation ?? 0) + 1,
      sourceCacheKey: input.sourceCacheKey,
      projectPath: input.projectPath,
      repoRoot: input.repoRoot,
      context: input.context,
      source: input.source,
      filesByPath: new Map(input.files.map((file) => [file.path, file])),
      workingPathTokens: new Map(input.workingPathTokens),
      createdAt: now,
      lastAccessedAt: now,
      leaseCount: 0,
      superseded: false,
      bodies: new Map(),
      bodyBytes: 0,
    };
    this.documents.set(document.id, document);
    this.latestBySource.set(document.sourceCacheKey, document.id);
    this.prune();
    return document;
  }

  acquire(projectPath: string, documentId: string): GitReviewDocumentLease | null {
    this.prune();
    const document = this.documents.get(documentId);
    if (!document || document.projectPath !== projectPath) return null;
    document.leaseCount += 1;
    document.lastAccessedAt = this.now();
    let released = false;
    return {
      document,
      getBody: (path) => document.bodies.get(path) ?? null,
      setBodies: (bodies) => {
        if (!this.documents.has(document.id) || document.superseded) return;
        for (const body of bodies) {
          const previous = document.bodies.get(body.path);
          if (previous) {
            document.bodyBytes -= previous.patchBytes;
            this.totalBodyBytes -= previous.patchBytes;
          }
          document.bodies.delete(body.path);
          document.bodies.set(body.path, body);
          document.bodyBytes += body.patchBytes;
          this.totalBodyBytes += body.patchBytes;
        }
        this.pruneBodies();
      },
      release: () => {
        if (released) return;
        released = true;
        document.leaseCount = Math.max(0, document.leaseCount - 1);
        document.lastAccessedAt = this.now();
        this.prune();
      },
    };
  }

  private prune(): void {
    const expiry = this.now() - this.idleTtlMs;
    for (const document of this.documents.values()) {
      if (document.leaseCount === 0 && (document.superseded || document.lastAccessedAt < expiry)) {
        this.deleteDocument(document);
      }
    }
    const idleCount = Array.from(this.documents.values()).filter(
      (document) => document.leaseCount === 0,
    ).length;
    if (idleCount > this.maxIdleDocuments) {
      this.evictIdle(idleCount - this.maxIdleDocuments);
    }
    this.pruneBodies();
  }

  private pruneBodies(): void {
    if (this.totalBodyBytes <= this.maxBodyBytes) return;
    const candidates = Array.from(this.documents.values())
      .filter((document) => document.leaseCount === 0 && document.bodies.size > 0)
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const document of candidates) {
      for (const [path, body] of document.bodies) {
        document.bodies.delete(path);
        document.bodyBytes -= body.patchBytes;
        this.totalBodyBytes -= body.patchBytes;
        if (this.totalBodyBytes <= this.maxBodyBytes) return;
      }
    }
  }

  private evictIdle(count: number): void {
    const candidates = Array.from(this.documents.values())
      .filter((document) => document.leaseCount === 0)
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const document of candidates.slice(0, count)) this.deleteDocument(document);
  }

  private deleteDocument(document: MutableRegisteredGitReviewDocument): void {
    this.documents.delete(document.id);
    if (this.latestBySource.get(document.sourceCacheKey) === document.id) {
      this.latestBySource.delete(document.sourceCacheKey);
    }
    this.totalBodyBytes -= document.bodyBytes;
  }
}

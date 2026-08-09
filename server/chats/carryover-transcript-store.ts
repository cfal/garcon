import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../common/chat-types.js';
import { isProjectableMessage } from '../../common/transcript-seed.js';
import { AgentSwitchMessage } from '../../common/chat-types.js';
import { DomainError } from '../lib/domain-error.js';
import { writeJsonFileAtomic, syncDirectory } from '../lib/json-file-store.js';
import {
  CarryOverPageIntegrityError,
  decodeCarryOverPage,
  encodeCarryOverPages,
  writeEncodedCarryOverPage,
} from './carryover-page-codec.js';
import {
  CARRYOVER_MESSAGE_SCHEMA_VERSION,
  CARRYOVER_SEGMENT_VERSION,
  isCarryOverSegmentId,
  parseCarryOverSegmentIndex,
  type CarryOverSegmentIndex,
  type SeedSanitationOutcome,
} from './carryover-segment-types.js';
import {
  archivedLogicalCount,
  assertSegmentBinding,
  carryOverLayout,
  carryOverRevision,
} from './carryover-segments.js';
import type {
  CarryOverMigrationQuarantine,
  CarryOverSegmentRef,
} from './store.js';

const DEFAULT_INDEX_CACHE_SIZE = 256;

export type CarryOverTranscriptErrorCode =
  | 'CARRYOVER_SEGMENT_COLLISION'
  | 'CARRYOVER_INVALID_CUTOFF';

export class CarryOverTranscriptError extends Error {
  constructor(
    readonly code: CarryOverTranscriptErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CarryOverTranscriptError';
  }
}

export class CarryOverHistoryUnavailableError extends DomainError {
  constructor(options?: ErrorOptions) {
    super(
      'CARRYOVER_HISTORY_UNAVAILABLE',
      'Archived chat history is unavailable.',
      422,
      false,
      options,
    );
    this.name = 'CarryOverHistoryUnavailableError';
  }
}

export interface PrepareCarryOverSegmentRequest {
  readonly operationId: string;
  readonly id: string;
  readonly seedSanitation: SeedSanitationOutcome;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
}

export interface PreparedCarryOverSegment {
  readonly id: string;
  readonly messageCount: number;
  readonly canonicalMessagesSha256: string;
  commit(): Promise<void>;
  discard(): Promise<void>;
  releaseRoot(): void;
}

export interface CarryOverTranscriptPage {
  readonly messages: readonly ChatMessage[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly revision: string;
}

export interface CarryOverSweepResult {
  readonly reachableSegmentCount: number;
  readonly unreachableSegmentCount: number;
  readonly removedSegmentCount: number;
  readonly compressedBytes: number;
  readonly declaredUncompressedBytes: number;
  readonly durationMs: number;
}

export class CarryOverTranscriptStore {
  readonly #rootDir: string;
  readonly #segmentsDir: string;
  readonly #tmpDir: string;
  readonly #trashDir: string;
  readonly #indexCacheSize: number;
  readonly #indexCache = new Map<string, CarryOverSegmentIndex>();
  readonly #degradedSegments = new Set<string>();
  readonly #writerRoots = new Set<string>();
  readonly #decodePage: typeof decodeCarryOverPage;
  readonly #onSegmentCommitted: (() => Promise<void>) | null;
  #gcPromise: Promise<void> = Promise.resolve();
  #segmentCommitPromise: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly workspaceDir: string;
    readonly indexCacheSize?: number;
    readonly decodePage?: typeof decodeCarryOverPage;
    readonly onSegmentCommitted?: () => Promise<void>;
  }) {
    this.#rootDir = path.join(options.workspaceDir, 'carryover-transcripts');
    this.#segmentsDir = path.join(this.#rootDir, 'segments');
    this.#tmpDir = path.join(this.#rootDir, 'tmp');
    this.#trashDir = path.join(this.#rootDir, 'trash');
    this.#indexCacheSize = options.indexCacheSize ?? DEFAULT_INDEX_CACHE_SIZE;
    this.#decodePage = options.decodePage ?? decodeCarryOverPage;
    this.#onSegmentCommitted = options.onSegmentCommitted ?? null;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#segmentsDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#tmpDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#trashDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(this.#rootDir, 'quarantine'), { recursive: true, mode: 0o700 }),
    ]);
  }

  revision(
    refs: readonly CarryOverSegmentRef[],
    quarantine: CarryOverMigrationQuarantine | null = null,
  ): string {
    return carryOverRevision(refs, quarantine);
  }

  writerRoots(): ReadonlySet<string> {
    return new Set(this.#writerRoots);
  }

  async cleanupTemporary(retainedSegmentIds: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const entry of await fs.readdir(this.#tmpDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const operationDir = path.join(this.#tmpDir, entry.name);
      const children = await fs.readdir(operationDir, { withFileTypes: true }).catch(() => []);
      const retained = children.some((child) => (
        child.isDirectory()
        && isCarryOverSegmentId(child.name)
        && retainedSegmentIds.has(child.name)
      ));
      if (retained) continue;
      await fs.rm(operationDir, { recursive: true, force: true });
      removed += 1;
    }
    if (removed > 0) await syncDirectory(this.#tmpDir);
    return removed;
  }

  sweep(roots: () => ReadonlySet<string>): Promise<CarryOverSweepResult> {
    const operation = this.#gcPromise
      .catch(() => undefined)
      .then(() => this.#sweepNow(roots()));
    this.#gcPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async prepareSegment(
    request: PrepareCarryOverSegmentRequest,
  ): Promise<PreparedCarryOverSegment> {
    request.signal?.throwIfAborted();
    const id = requireSegmentId(request.id);
    if (request.messages.length === 0) {
      throw new Error('Carryover segment must contain at least one message');
    }
    const preparedDir = this.#preparedSegmentDir(request.operationId, id);
    await fs.rm(preparedDir, { recursive: true, force: true });
    await fs.mkdir(path.join(preparedDir, 'pages'), { recursive: true, mode: 0o700 });
    this.#writerRoots.add(id);
    try {
      const pages = await encodeCarryOverPages(request.messages, request.signal);
      for (const page of pages) {
        request.signal?.throwIfAborted();
        await writeEncodedCarryOverPage(path.join(preparedDir, page.descriptor.file), page);
      }
      await syncDirectory(path.join(preparedDir, 'pages'));
      const index: CarryOverSegmentIndex = {
        version: CARRYOVER_SEGMENT_VERSION,
        messageSchemaVersion: CARRYOVER_MESSAGE_SCHEMA_VERSION,
        id,
        seedSanitation: request.seedSanitation,
        messageCount: request.messages.length,
        canonicalMessagesSha256: canonicalMessagesDigest(request.messages),
        pages: pages.map((page) => page.descriptor),
      };
      parseCarryOverSegmentIndex(index, id);
      await writeJsonFileAtomic(path.join(preparedDir, 'segment.json'), index, { mode: 0o600 });
      await syncDirectory(preparedDir);
      return this.#preparedHandle(request.operationId, index, preparedDir);
    } catch (error) {
      this.#writerRoots.delete(id);
      await fs.rm(preparedDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async assertAvailable(
    refs: readonly CarryOverSegmentRef[],
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      for (const ref of refs) {
        signal?.throwIfAborted();
        if (ref.storedMessageCount === 0) continue;
        if (this.#degradedSegments.has(ref.id)) {
          throw new Error(`Carryover segment ${ref.id} is degraded`);
        }
        const index = await this.#readIndex(ref.id);
        assertSegmentBinding(ref, index);
        await this.#statPages(index, signal);
      }
    } catch (error) {
      throwUnavailableUnlessAborted(error);
    }
  }

  logicalMessageCount(refs: readonly CarryOverSegmentRef[]): number {
    return archivedLogicalCount(refs);
  }

  async loadAll(
    refs: readonly CarryOverSegmentRef[],
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const total = archivedLogicalCount(refs);
    return [...(await this.loadPage({ refs, offset: 0, limit: total, signal })).messages];
  }

  async loadPage(input: {
    readonly refs: readonly CarryOverSegmentRef[];
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<CarryOverTranscriptPage> {
    const offset = Math.max(0, Math.trunc(input.offset));
    const limit = Math.max(0, Math.trunc(input.limit));
    const total = archivedLogicalCount(input.refs);
    const revision = carryOverRevision(input.refs);
    if (limit === 0 || input.refs.length === 0) {
      return { messages: [], total, offset, limit, hasMore: offset < total, revision };
    }
    const firstSequence = offset + 1;
    const lastSequence = Math.min(total, offset + limit);
    const messages: ChatMessage[] = [];
    if (firstSequence <= lastSequence) {
      for (const item of carryOverLayout(input.refs)) {
        input.signal?.throwIfAborted();
        const payloadStart = Math.max(firstSequence, item.startSequence);
        const payloadEnd = Math.min(lastSequence, item.payloadEndSequence);
        if (payloadStart <= payloadEnd) {
          messages.push(...await this.#readSegmentRange(
            item.ref,
            payloadStart - item.startSequence,
            payloadEnd - payloadStart + 1,
            input.signal,
          ));
        }
        if (
          item.boundarySequence !== null
          && item.boundarySequence >= firstSequence
          && item.boundarySequence <= lastSequence
        ) {
          const target = item.ref.trailingHandoff!;
          messages.push(new AgentSwitchMessage(
            item.ref.capturedAt,
            item.ref.agentId,
            target.agentId,
            item.ref.model,
            target.model,
          ));
        }
      }
    }
    return {
      messages,
      total,
      offset,
      limit,
      hasMore: offset + messages.length < total,
      revision,
    };
  }

  // Returns the whole archive for the projection ladder, which selects by message
  // class rather than recency and therefore needs to see every turn. A tail cannot
  // serve it: on tool-heavy chats a five-hundred message window held two of
  // seventy-one user turns, so the asks were gone before any budget applied.
  // Streams in pages and drops from the oldest end only when the byte guard trips.
  async loadProjectionSource(input: {
    readonly refs: readonly CarryOverSegmentRef[];
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  }): Promise<ChatMessage[]> {
    if (archivedLogicalCount(input.refs) === 0) return [];
    const maxBytes = input.maxBytes ?? 64 * 1024 * 1024;
    const collected: ChatMessage[] = [];
    let bytes = 2;
    for await (const batch of this.stream({
      refs: input.refs,
      maxMessagesPerBatch: 512,
      signal: input.signal,
    })) {
      for (const message of batch) {
        // Only messages the projection can actually render are admitted, so the
        // byte guard is never spent on content that is discarded downstream.
        // Tool results alone are 45% of a typical archive; counting them here
        // let a large chat evict its whole conversation and hand off empty.
        if (!isProjectableMessage(message)) continue;
        bytes += Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
        collected.push(message);
      }
      while (bytes > maxBytes && collected.length > 1) {
        // The asks are never evicted. They are the irreducible floor of a
        // carried transcript and are tiny beside the tool traffic around them.
        const index = collected.findIndex((message) => message.type !== 'user-message');
        if (index === -1) break;
        bytes -= Buffer.byteLength(JSON.stringify(collected[index]), 'utf8') + 1;
        collected.splice(index, 1);
      }
    }
    return collected;
  }

  async *stream(input: {
    readonly refs: readonly CarryOverSegmentRef[];
    readonly maxMessagesPerBatch: number;
    readonly signal?: AbortSignal;
  }): AsyncIterable<readonly ChatMessage[]> {
    if (!Number.isSafeInteger(input.maxMessagesPerBatch) || input.maxMessagesPerBatch < 1) {
      throw new Error('Carryover stream batch size must be positive');
    }
    const total = archivedLogicalCount(input.refs);
    let offset = 0;
    while (offset < total) {
      input.signal?.throwIfAborted();
      const page = await this.loadPage({
        refs: input.refs,
        offset,
        limit: input.maxMessagesPerBatch,
        signal: input.signal,
      });
      if (page.messages.length === 0) break;
      yield page.messages;
      offset += page.messages.length;
    }
  }

  resolveCutoff(
    refs: readonly CarryOverSegmentRef[],
    inclusiveSequence: number,
  ): readonly CarryOverSegmentRef[] {
    if (inclusiveSequence <= 0) return [];
    const layout = carryOverLayout(refs);
    for (const [index, item] of layout.entries()) {
      if (inclusiveSequence < item.startSequence) return refs.slice(0, index);
      if (inclusiveSequence <= item.payloadEndSequence) {
        const visibleMessageCount = inclusiveSequence - item.startSequence + 1;
        return [
          ...refs.slice(0, index),
          { ...item.ref, visibleMessageCount, trailingHandoff: null },
        ];
      }
      if (item.boundarySequence === inclusiveSequence) return refs.slice(0, index + 1);
    }
    return refs.slice();
  }

  async readIndex(id: string): Promise<CarryOverSegmentIndex> {
    return this.#readIndex(requireSegmentId(id));
  }

  async verifySegment(ref: CarryOverSegmentRef, signal?: AbortSignal): Promise<void> {
    if (ref.storedMessageCount === 0) return;
    const index = await this.#readIndex(ref.id);
    assertSegmentBinding(ref, index);
    const digest = crypto.createHash('sha256');
    digest.update('[');
    let count = 0;
    for (const descriptor of index.pages) {
      signal?.throwIfAborted();
      const page = await this.#decodePage(
        path.join(this.#segmentDir(index.id), descriptor.file),
        descriptor,
        signal,
      );
      for (const message of page) {
        if (count > 0) digest.update(',');
        digest.update(JSON.stringify(message));
        count += 1;
      }
    }
    digest.update(']');
    if (count !== index.messageCount || digest.digest('hex') !== index.canonicalMessagesSha256) {
      this.#degradedSegments.add(ref.id);
      throw new CarryOverHistoryUnavailableError({
        cause: new Error(`Carryover segment ${ref.id} canonical digest mismatch`),
      });
    }
  }

  async #readSegmentRange(
    ref: CarryOverSegmentRef,
    start: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    if (ref.storedMessageCount === 0) return [];
    const end = Math.min(ref.visibleMessageCount, start + count);
    if (start < 0 || start >= end) return [];
    const messages: ChatMessage[] = [];
    try {
      const index = await this.#readIndex(ref.id);
      assertSegmentBinding(ref, index);
      for (const descriptor of index.pages) {
        signal?.throwIfAborted();
        const pageStart = descriptor.firstSequence;
        const pageEnd = pageStart + descriptor.messageCount;
        if (pageEnd <= start || pageStart >= end) continue;
        const page = await this.#decodePage(
          path.join(this.#segmentDir(index.id), descriptor.file),
          descriptor,
          signal,
        );
        messages.push(...page.slice(
          Math.max(0, start - pageStart),
          Math.min(page.length, end - pageStart),
        ));
      }
      if (messages.length !== end - start) {
        throw new CarryOverPageIntegrityError('Carryover page range is incomplete');
      }
      return messages;
    } catch (error) {
      if (error instanceof CarryOverPageIntegrityError) this.#degradedSegments.add(ref.id);
      throwUnavailableUnlessAborted(error);
    }
  }

  async #readIndex(id: string): Promise<CarryOverSegmentIndex> {
    const cached = this.#indexCache.get(id);
    if (cached) {
      this.#indexCache.delete(id);
      this.#indexCache.set(id, cached);
      return cached;
    }
    try {
      const raw = await fs.readFile(path.join(this.#segmentDir(id), 'segment.json'), 'utf8');
      let index: CarryOverSegmentIndex;
      try {
        index = parseCarryOverSegmentIndex(JSON.parse(raw), id);
      } catch (error) {
        this.#degradedSegments.add(id);
        throw new CarryOverHistoryUnavailableError({ cause: error });
      }
      this.#indexCache.set(id, index);
      while (this.#indexCache.size > this.#indexCacheSize) {
        const oldest = this.#indexCache.keys().next().value;
        if (oldest === undefined) break;
        this.#indexCache.delete(oldest);
      }
      return index;
    } catch (error) {
      throwUnavailableUnlessAborted(error);
    }
  }

  async #statPages(index: CarryOverSegmentIndex, signal?: AbortSignal): Promise<void> {
    for (const descriptor of index.pages) {
      signal?.throwIfAborted();
      const stat = await fs.stat(path.join(this.#segmentDir(index.id), descriptor.file));
      if (!stat.isFile() || stat.size !== descriptor.compressedBytes) {
        this.#degradedSegments.add(index.id);
        throw new Error(`Carryover page metadata mismatch in ${index.id}`);
      }
    }
  }

  #preparedHandle(
    operationId: string,
    index: CarryOverSegmentIndex,
    preparedDir: string,
  ): PreparedCarryOverSegment {
    let committed = false;
    let installed = false;
    let released = false;
    return {
      id: index.id,
      messageCount: index.messageCount,
      canonicalMessagesSha256: index.canonicalMessagesSha256,
      commit: async () => {
        if (committed) return;
        const finalDir = this.#segmentDir(index.id);
        try {
          await fs.rename(preparedDir, finalDir);
          installed = true;
          await syncDirectory(this.#segmentsDir);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
          await this.#assertIdempotentCollision(finalDir, index);
          await fs.rm(preparedDir, { recursive: true, force: true });
        }
        committed = true;
        this.#indexCache.set(index.id, index);
        await this.#removeEmptyOperationDir(operationId);
        await this.#recordSegmentCommitted();
      },
      discard: async () => {
        if (released) return;
        await fs.rm(preparedDir, { recursive: true, force: true });
        if (committed && installed) {
          await fs.rm(this.#segmentDir(index.id), { recursive: true, force: true });
          this.#indexCache.delete(index.id);
          this.#degradedSegments.delete(index.id);
          await syncDirectory(this.#segmentsDir);
        }
        this.#writerRoots.delete(index.id);
        released = true;
        await this.#removeEmptyOperationDir(operationId);
      },
      releaseRoot: () => {
        this.#writerRoots.delete(index.id);
        released = true;
      },
    };
  }

  #recordSegmentCommitted(): Promise<void> {
    if (!this.#onSegmentCommitted) return Promise.resolve();
    const operation = this.#segmentCommitPromise
      .catch(() => undefined)
      .then(this.#onSegmentCommitted);
    this.#segmentCommitPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #assertIdempotentCollision(
    finalDir: string,
    expected: CarryOverSegmentIndex,
  ): Promise<void> {
    try {
      const actual = parseCarryOverSegmentIndex(
        JSON.parse(await fs.readFile(path.join(finalDir, 'segment.json'), 'utf8')),
        expected.id,
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Index differs');
      await this.verifySegment({
        id: actual.id,
        agentId: 'collision-check',
        model: '',
        capturedAt: new Date(0).toISOString(),
        storedMessageCount: actual.messageCount,
        visibleMessageCount: actual.messageCount,
        trailingHandoff: null,
      });
    } catch (error) {
      throw new CarryOverTranscriptError(
        'CARRYOVER_SEGMENT_COLLISION',
        `Carryover segment ${expected.id} already exists with different content`,
        { cause: error },
      );
    }
  }

  async #sweepNow(roots: ReadonlySet<string>): Promise<CarryOverSweepResult> {
    const startedAt = Date.now();
    const reachable = new Set([...roots, ...this.#writerRoots].map(requireSegmentId));
    let compressedBytes = 0;
    let declaredUncompressedBytes = 0;
    for (const id of reachable) {
      try {
        const index = await this.#readIndex(id);
        compressedBytes += index.pages.reduce((total, page) => total + page.compressedBytes, 0);
        declaredUncompressedBytes += index.pages.reduce(
          (total, page) => total + page.uncompressedBytes,
          0,
        );
      } catch {
        // A corrupt root must not prevent unrelated unreachable artifacts from being reclaimed.
      }
    }

    const candidates = (await fs.readdir(this.#segmentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isCarryOverSegmentId(entry.name))
      .map((entry) => entry.name)
      .filter((id) => !reachable.has(id));
    let removedSegmentCount = 0;
    for (const id of candidates) {
      if (this.#writerRoots.has(id)) continue;
      const trashPath = path.join(this.#trashDir, `${id}-${crypto.randomUUID()}`);
      try {
        await fs.rename(this.#segmentDir(id), trashPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      this.#indexCache.delete(id);
      this.#degradedSegments.delete(id);
      await fs.rm(trashPath, { recursive: true, force: true });
      removedSegmentCount += 1;
    }
    if (removedSegmentCount > 0) {
      await Promise.all([syncDirectory(this.#segmentsDir), syncDirectory(this.#trashDir)]);
    }
    return {
      reachableSegmentCount: reachable.size,
      unreachableSegmentCount: candidates.length,
      removedSegmentCount,
      compressedBytes,
      declaredUncompressedBytes,
      durationMs: Date.now() - startedAt,
    };
  }

  async #removeEmptyOperationDir(operationId: string): Promise<void> {
    await fs.rmdir(this.#operationDir(operationId)).catch(() => undefined);
  }

  #preparedSegmentDir(operationId: string, id: string): string {
    return path.join(this.#operationDir(operationId), id);
  }

  #operationDir(operationId: string): string {
    const key = crypto.createHash('sha256').update(operationId).digest('hex');
    return path.join(this.#tmpDir, key);
  }

  #segmentDir(id: string): string {
    return path.join(this.#segmentsDir, id);
  }
}

function canonicalMessagesDigest(messages: readonly ChatMessage[]): string {
  const digest = crypto.createHash('sha256');
  digest.update('[');
  for (const [index, message] of messages.entries()) {
    if (index > 0) digest.update(',');
    digest.update(JSON.stringify(message));
  }
  digest.update(']');
  return digest.digest('hex');
}

function requireSegmentId(value: string): string {
  if (!isCarryOverSegmentId(value)) throw new Error('Carryover segment ID must be a lowercase UUID');
  return value;
}

function asUnavailable(error: unknown): CarryOverHistoryUnavailableError {
  return error instanceof CarryOverHistoryUnavailableError
    ? error
    : new CarryOverHistoryUnavailableError({ cause: error });
}

function throwUnavailableUnlessAborted(error: unknown): never {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  throw asUnavailable(error);
}

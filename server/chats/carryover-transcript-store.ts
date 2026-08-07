import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../common/chat-types.js';
import { AgentSwitchMessage } from '../../common/chat-types.js';
import { writeJsonFileAtomic, syncDirectory } from '../lib/json-file-store.js';
import {
  decodeCarryOverPage,
  encodeCarryOverPages,
  writeEncodedCarryOverPage,
} from './carryover-page-codec.js';
import {
  CARRYOVER_NODE_VERSION,
  isCarryOverNodeId,
  parseCarryOverNode,
  type CarryOverBoundaryDescriptor,
  type CarryOverNode,
  type CarryOverSourceDescriptor,
  type CarryOverTargetDescriptor,
  type MaterializedCarryOverNode,
  type PrefixCarryOverNode,
  type SeedSanitationOutcome,
} from './carryover-node-types.js';

const DEFAULT_MAX_NODE_DEPTH = 10_000;
const DEFAULT_MANIFEST_CACHE_SIZE = 256;

export type CarryOverTranscriptErrorCode =
  | 'CARRYOVER_HISTORY_UNAVAILABLE'
  | 'CARRYOVER_NODE_COLLISION'
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

export interface PrepareMaterializedNodeRequest {
  readonly operationId: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly source: CarryOverSourceDescriptor;
  readonly boundary: CarryOverBoundaryDescriptor | null;
  readonly seedSanitation: SeedSanitationOutcome;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
  readonly createdAt?: string;
}

export interface PreparePrefixNodeRequest {
  readonly operationId: string;
  readonly id: string;
  readonly sourceNodeId: string;
  readonly messageCount: number;
  readonly signal?: AbortSignal;
  readonly createdAt?: string;
}

export interface PreparedCarryOverNode {
  readonly id: string;
  readonly messageCount: number;
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

export type CarryOverCutoff =
  | { readonly kind: 'reuse'; readonly headId: string | null }
  | { readonly kind: 'prefix'; readonly sourceNodeId: string; readonly messageCount: number };

interface LogicalNode {
  readonly node: CarryOverNode;
  readonly startSequence: number;
  readonly payloadEndSequence: number;
  readonly boundarySequence: number | null;
}

export class CarryOverTranscriptStore {
  readonly #rootDir: string;
  readonly #nodesDir: string;
  readonly #tmpDir: string;
  readonly #trashDir: string;
  readonly #maxNodeDepth: number;
  readonly #manifestCacheSize: number;
  readonly #manifestCache = new Map<string, CarryOverNode>();
  readonly #degradedNodes = new Set<string>();
  readonly #writerRoots = new Set<string>();

  constructor(options: {
    readonly workspaceDir: string;
    readonly maxNodeDepth?: number;
    readonly manifestCacheSize?: number;
  }) {
    this.#rootDir = path.join(options.workspaceDir, 'carryover-transcripts');
    this.#nodesDir = path.join(this.#rootDir, 'nodes');
    this.#tmpDir = path.join(this.#rootDir, 'tmp');
    this.#trashDir = path.join(this.#rootDir, 'trash');
    this.#maxNodeDepth = options.maxNodeDepth ?? DEFAULT_MAX_NODE_DEPTH;
    this.#manifestCacheSize = options.manifestCacheSize ?? DEFAULT_MANIFEST_CACHE_SIZE;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#nodesDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#tmpDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#trashDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  revision(headId: string | null): string {
    return headId ? `carry-v2:${headId}` : 'carry-v1:0';
  }

  writerRoots(): ReadonlySet<string> {
    return new Set(this.#writerRoots);
  }

  async prepareMaterialized(request: PrepareMaterializedNodeRequest): Promise<PreparedCarryOverNode> {
    request.signal?.throwIfAborted();
    const id = requireNodeId(request.id);
    const parentId = request.parentId === null ? null : requireNodeId(request.parentId);
    if (request.messages.length === 0) throw new Error('Materialized carryover nodes must not be empty');
    if (parentId) await this.assertReachableForHandoff(parentId, request.signal);

    const preparedDir = this.#preparedNodeDir(request.operationId, id);
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
      const manifest: MaterializedCarryOverNode = {
        version: CARRYOVER_NODE_VERSION,
        kind: 'materialized',
        id,
        parentId,
        createdAt: request.createdAt ?? new Date().toISOString(),
        source: request.source,
        boundary: request.boundary,
        seedSanitation: request.seedSanitation,
        messageCount: request.messages.length,
        pages: pages.map((page) => page.descriptor),
      };
      parseCarryOverNode(manifest, id);
      await writeJsonFileAtomic(path.join(preparedDir, 'manifest.json'), manifest, { mode: 0o600 });
      await syncDirectory(preparedDir);
      return this.#preparedHandle(request.operationId, manifest, preparedDir);
    } catch (error) {
      this.#writerRoots.delete(id);
      await fs.rm(preparedDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async preparePrefix(request: PreparePrefixNodeRequest): Promise<PreparedCarryOverNode> {
    request.signal?.throwIfAborted();
    const id = requireNodeId(request.id);
    const sourceId = requireNodeId(request.sourceNodeId);
    const sourceCandidate = await this.#readManifest(sourceId);
    const materialized = sourceCandidate.kind === 'materialized'
      ? sourceCandidate
      : await this.#readMaterializedPrefixSource(sourceCandidate);
    const maximum = sourceCandidate.kind === 'prefix'
      ? Math.min(sourceCandidate.messageCount, materialized.messageCount)
      : materialized.messageCount;
    if (!Number.isSafeInteger(request.messageCount) || request.messageCount < 1 || request.messageCount > maximum) {
      throw new CarryOverTranscriptError('CARRYOVER_INVALID_CUTOFF', 'Carryover prefix cutoff is outside its source');
    }
    if (materialized.parentId) await this.assertReachableForHandoff(materialized.parentId, request.signal);

    const preparedDir = this.#preparedNodeDir(request.operationId, id);
    await fs.rm(preparedDir, { recursive: true, force: true });
    await fs.mkdir(preparedDir, { recursive: true, mode: 0o700 });
    this.#writerRoots.add(id);
    const manifest: PrefixCarryOverNode = {
      version: CARRYOVER_NODE_VERSION,
      kind: 'prefix',
      id,
      parentId: materialized.parentId,
      createdAt: request.createdAt ?? new Date().toISOString(),
      sourceNodeId: materialized.id,
      messageCount: request.messageCount,
      source: materialized.source,
    };
    try {
      parseCarryOverNode(manifest, id);
      await writeJsonFileAtomic(path.join(preparedDir, 'manifest.json'), manifest, { mode: 0o600 });
      await syncDirectory(preparedDir);
      return this.#preparedHandle(request.operationId, manifest, preparedDir);
    } catch (error) {
      this.#writerRoots.delete(id);
      await fs.rm(preparedDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async assertReachableForHandoff(headId: string | null, signal?: AbortSignal): Promise<void> {
    if (!headId) return;
    try {
      const chain = await this.#loadChain(headId, signal);
      for (const node of chain) {
        signal?.throwIfAborted();
        if (this.#degradedNodes.has(node.id)) throw new Error(`Carryover node ${node.id} is degraded`);
        if (node.kind === 'prefix') {
          const source = await this.#readMaterializedPrefixSource(node);
          if (source.parentId !== node.parentId || node.messageCount > source.messageCount) {
            throw new Error(`Carryover prefix ${node.id} is inconsistent with its source`);
          }
          await this.#statPages(source, signal);
        } else {
          await this.#statPages(node, signal);
        }
      }
    } catch (error) {
      throw asUnavailable(error);
    }
  }

  async logicalMessageCount(headId: string | null, signal?: AbortSignal): Promise<number> {
    if (!headId) return 0;
    const layout = await this.#logicalLayout(headId, signal);
    const last = layout.at(-1);
    return last?.boundarySequence ?? last?.payloadEndSequence ?? 0;
  }

  async loadAll(
    headId: string | null,
    current: CarryOverTargetDescriptor,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    if (!headId) return [];
    const total = await this.logicalMessageCount(headId, signal);
    return [...(await this.loadPage({ headId, current, offset: 0, limit: total, signal })).messages];
  }

  async loadPage(input: {
    readonly headId: string | null;
    readonly current: CarryOverTargetDescriptor;
    readonly offset: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<CarryOverTranscriptPage> {
    const offset = Math.max(0, Math.trunc(input.offset));
    const limit = Math.max(0, Math.trunc(input.limit));
    if (!input.headId || limit === 0) {
      const total = input.headId ? await this.logicalMessageCount(input.headId, input.signal) : 0;
      return { messages: [], total, offset, limit, hasMore: offset < total, revision: this.revision(input.headId) };
    }
    const layout = await this.#logicalLayout(input.headId, input.signal);
    const last = layout.at(-1);
    const total = last?.boundarySequence ?? last?.payloadEndSequence ?? 0;
    const firstSequence = offset + 1;
    const lastSequence = Math.min(total, offset + limit);
    const messages: ChatMessage[] = [];
    if (firstSequence <= lastSequence) {
      for (const [index, item] of layout.entries()) {
        input.signal?.throwIfAborted();
        const payloadStart = Math.max(firstSequence, item.startSequence);
        const payloadEnd = Math.min(lastSequence, item.payloadEndSequence);
        if (payloadStart <= payloadEnd) {
          messages.push(...await this.#readNodeRange(
            item.node,
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
          const target = layout[index + 1]?.node.source ?? input.current;
          messages.push(new AgentSwitchMessage(
            item.node.createdAt,
            item.node.source.agentId,
            target.agentId,
            item.node.source.model,
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
      revision: this.revision(input.headId),
    };
  }

  async loadTailForSeed(input: {
    readonly headId: string | null;
    readonly current: CarryOverTargetDescriptor;
    readonly maxMessages?: number;
    readonly maxBytes?: number;
    readonly signal?: AbortSignal;
  }): Promise<ChatMessage[]> {
    if (!input.headId) return [];
    const total = await this.logicalMessageCount(input.headId, input.signal);
    const maxMessages = Math.max(1, input.maxMessages ?? 512);
    const page = await this.loadPage({
      headId: input.headId,
      current: input.current,
      offset: Math.max(0, total - maxMessages),
      limit: Math.min(total, maxMessages),
      signal: input.signal,
    });
    const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
    const result: ChatMessage[] = [];
    let bytes = 2;
    for (let index = page.messages.length - 1; index >= 0; index -= 1) {
      const message = page.messages[index];
      const cost = Buffer.byteLength(JSON.stringify(message), 'utf8') + (result.length > 0 ? 1 : 0);
      if (result.length > 0 && bytes + cost > maxBytes) break;
      result.unshift(message);
      bytes += cost;
    }
    return result;
  }

  async *stream(input: {
    readonly headId: string | null;
    readonly current: CarryOverTargetDescriptor;
    readonly maxMessagesPerBatch: number;
    readonly signal?: AbortSignal;
  }): AsyncIterable<readonly ChatMessage[]> {
    if (!input.headId) return;
    if (!Number.isSafeInteger(input.maxMessagesPerBatch) || input.maxMessagesPerBatch < 1) {
      throw new Error('Carryover stream batch size must be positive');
    }
    const total = await this.logicalMessageCount(input.headId, input.signal);
    let offset = 0;
    while (offset < total) {
      input.signal?.throwIfAborted();
      const page = await this.loadPage({
        headId: input.headId,
        current: input.current,
        offset,
        limit: input.maxMessagesPerBatch,
        signal: input.signal,
      });
      if (page.messages.length === 0) break;
      yield page.messages;
      offset += page.messages.length;
    }
  }

  async resolveCutoff(
    headId: string | null,
    inclusiveSequence: number,
    signal?: AbortSignal,
  ): Promise<CarryOverCutoff> {
    if (!headId || inclusiveSequence <= 0) return { kind: 'reuse', headId: null };
    const layout = await this.#logicalLayout(headId, signal);
    for (const item of layout) {
      if (inclusiveSequence < item.startSequence) {
        const priorIndex = layout.indexOf(item) - 1;
        return { kind: 'reuse', headId: priorIndex >= 0 ? layout[priorIndex].node.id : null };
      }
      if (inclusiveSequence <= item.payloadEndSequence) {
        const count = inclusiveSequence - item.startSequence + 1;
        if (count === item.node.messageCount && item.boundarySequence === null) {
          return { kind: 'reuse', headId: item.node.id };
        }
        return {
          kind: 'prefix',
          sourceNodeId: item.node.kind === 'prefix' ? item.node.sourceNodeId : item.node.id,
          messageCount: count,
        };
      }
      if (item.boundarySequence === inclusiveSequence) return { kind: 'reuse', headId: item.node.id };
    }
    return { kind: 'reuse', headId };
  }

  async readManifest(id: string): Promise<CarryOverNode> {
    return this.#readManifest(requireNodeId(id));
  }

  async #logicalLayout(headId: string, signal?: AbortSignal): Promise<LogicalNode[]> {
    const chain = await this.#loadChain(headId, signal);
    let sequence = 1;
    return chain.map((node) => {
      const startSequence = sequence;
      const payloadEndSequence = sequence + node.messageCount - 1;
      const boundarySequence = node.kind === 'materialized' && node.boundary
        ? payloadEndSequence + 1
        : null;
      sequence = (boundarySequence ?? payloadEndSequence) + 1;
      return { node, startSequence, payloadEndSequence, boundarySequence };
    });
  }

  async #loadChain(headId: string, signal?: AbortSignal): Promise<CarryOverNode[]> {
    const visited = new Set<string>();
    const reversed: CarryOverNode[] = [];
    let cursor: string | null = requireNodeId(headId);
    while (cursor) {
      signal?.throwIfAborted();
      if (visited.has(cursor)) throw new Error(`Carryover history cycle at ${cursor}`);
      if (visited.size >= this.#maxNodeDepth) throw new Error('Carryover history exceeds maximum depth');
      visited.add(cursor);
      const node = await this.#readManifest(cursor);
      if (node.kind === 'prefix') {
        const source = await this.#readMaterializedPrefixSource(node);
        if (source.parentId !== node.parentId || node.messageCount > source.messageCount) {
          throw new Error(`Carryover prefix ${node.id} is inconsistent with its source`);
        }
      }
      reversed.push(node);
      cursor = node.parentId;
    }
    return reversed.reverse();
  }

  async #readNodeRange(
    node: CarryOverNode,
    start: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<ChatMessage[]> {
    const materialized = node.kind === 'materialized'
      ? node
      : await this.#readMaterializedPrefixSource(node);
    const maximum = node.kind === 'prefix' ? node.messageCount : materialized.messageCount;
    const end = Math.min(maximum, start + count);
    if (start < 0 || start >= end) return [];
    const messages: ChatMessage[] = [];
    try {
      for (const descriptor of materialized.pages) {
        signal?.throwIfAborted();
        const pageStart = descriptor.firstSequence;
        const pageEnd = pageStart + descriptor.messageCount;
        if (pageEnd <= start || pageStart >= end) continue;
        const page = await decodeCarryOverPage(
          path.join(this.#nodeDir(materialized.id), descriptor.file),
          descriptor,
          signal,
        );
        messages.push(...page.slice(
          Math.max(0, start - pageStart),
          Math.min(page.length, end - pageStart),
        ));
      }
      if (messages.length !== end - start) throw new Error('Carryover page range is incomplete');
      return messages;
    } catch (error) {
      this.#degradedNodes.add(materialized.id);
      throw asUnavailable(error);
    }
  }

  async #readMaterializedPrefixSource(node: PrefixCarryOverNode): Promise<MaterializedCarryOverNode> {
    const source = await this.#readManifest(node.sourceNodeId);
    if (source.kind !== 'materialized') throw new Error('Carryover prefix source is not materialized');
    return source;
  }

  async #readManifest(id: string): Promise<CarryOverNode> {
    const cached = this.#manifestCache.get(id);
    if (cached) {
      this.#manifestCache.delete(id);
      this.#manifestCache.set(id, cached);
      return cached;
    }
    try {
      const raw = await fs.readFile(path.join(this.#nodeDir(id), 'manifest.json'), 'utf8');
      const node = parseCarryOverNode(JSON.parse(raw), id);
      this.#manifestCache.set(id, node);
      while (this.#manifestCache.size > this.#manifestCacheSize) {
        const oldest = this.#manifestCache.keys().next().value;
        if (oldest === undefined) break;
        this.#manifestCache.delete(oldest);
      }
      return node;
    } catch (error) {
      this.#degradedNodes.add(id);
      throw asUnavailable(error);
    }
  }

  async #statPages(node: MaterializedCarryOverNode, signal?: AbortSignal): Promise<void> {
    for (const descriptor of node.pages) {
      signal?.throwIfAborted();
      const stat = await fs.stat(path.join(this.#nodeDir(node.id), descriptor.file));
      if (!stat.isFile() || stat.size !== descriptor.compressedBytes) {
        throw new Error(`Carryover page metadata mismatch in ${node.id}`);
      }
    }
  }

  #preparedHandle(
    operationId: string,
    manifest: CarryOverNode,
    preparedDir: string,
  ): PreparedCarryOverNode {
    let committed = false;
    let released = false;
    return {
      id: manifest.id,
      messageCount: manifest.messageCount,
      commit: async () => {
        if (committed) return;
        const finalDir = this.#nodeDir(manifest.id);
        try {
          await fs.rename(preparedDir, finalDir);
          await syncDirectory(this.#nodesDir);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
          await this.#assertIdempotentCollision(finalDir, manifest);
          await fs.rm(preparedDir, { recursive: true, force: true });
        }
        committed = true;
        this.#manifestCache.set(manifest.id, manifest);
        await this.#removeEmptyOperationDir(operationId);
      },
      discard: async () => {
        if (released) return;
        await fs.rm(preparedDir, { recursive: true, force: true });
        if (committed) {
          await fs.rm(this.#nodeDir(manifest.id), { recursive: true, force: true });
          this.#manifestCache.delete(manifest.id);
          this.#degradedNodes.delete(manifest.id);
          await syncDirectory(this.#nodesDir);
        }
        this.#writerRoots.delete(manifest.id);
        released = true;
        await this.#removeEmptyOperationDir(operationId);
      },
      releaseRoot: () => {
        this.#writerRoots.delete(manifest.id);
        released = true;
      },
    };
  }

  async #assertIdempotentCollision(finalDir: string, expected: CarryOverNode): Promise<void> {
    try {
      const actual = parseCarryOverNode(
        JSON.parse(await fs.readFile(path.join(finalDir, 'manifest.json'), 'utf8')),
        expected.id,
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Manifest differs');
      if (actual.kind === 'materialized') {
        for (const page of actual.pages) {
          await decodeCarryOverPage(path.join(finalDir, page.file), page);
        }
      }
    } catch (error) {
      throw new CarryOverTranscriptError(
        'CARRYOVER_NODE_COLLISION',
        `Carryover node ${expected.id} already exists with different content`,
        { cause: error },
      );
    }
  }

  async #removeEmptyOperationDir(operationId: string): Promise<void> {
    await fs.rmdir(this.#operationDir(operationId)).catch(() => undefined);
  }

  #preparedNodeDir(operationId: string, id: string): string {
    return path.join(this.#operationDir(operationId), id);
  }

  #operationDir(operationId: string): string {
    const key = crypto.createHash('sha256').update(operationId).digest('hex');
    return path.join(this.#tmpDir, key);
  }

  #nodeDir(id: string): string {
    return path.join(this.#nodesDir, id);
  }
}

function requireNodeId(value: string): string {
  if (!isCarryOverNodeId(value)) throw new Error('Carryover node ID must be a UUID');
  return value.toLowerCase();
}

function asUnavailable(error: unknown): CarryOverTranscriptError {
  return error instanceof CarryOverTranscriptError
    ? error
    : new CarryOverTranscriptError(
        'CARRYOVER_HISTORY_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
}

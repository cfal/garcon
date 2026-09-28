import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { parseFirstJsonlValue } from '../lib/jsonl.js';

export interface ForkTranscriptEntryContext {
  readonly sourceAgentSessionId: string;
  readonly targetAgentSessionId: string;
  readonly retainedMessageCount?: number;
}

export interface ForkTranscriptTransformInput {
  readonly selectedEntries: readonly unknown[];
  readonly sourceEntries: readonly unknown[];
  readonly sourceAgentSessionId: string;
  readonly targetAgentSessionId: string;
}

export interface ForkTranscriptTransformResult {
  readonly entries: readonly unknown[];
  readonly expectedSemanticDigest?: string;
}

export interface ForkJsonlTargetPathInput {
  readonly sourcePath: string;
  readonly targetAgentSessionId: string;
  readonly createdAt: Date;
}

export interface ForkJsonlRequest {
  readonly sourcePath: string;
  readonly sourceAgentSessionId: string;
  readonly cutoffLine: number | null;
  readonly allowUnmaterializedWholeSession?: boolean;
  readonly leadingLineCount?: number;
  readonly retainedMessageCounts?: ReadonlyMap<number, number>;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly transformEntries?: (
    input: ForkTranscriptTransformInput,
  ) => ForkTranscriptTransformResult;
  readonly createTargetPath?: (input: ForkJsonlTargetPathInput) => string;
}

export type ForkJsonlOutcome =
  | {
      readonly kind: 'materialized';
      readonly agentSessionId: string;
      readonly nativePath: string;
      readonly expectedSemanticDigest?: string;
    }
  | { readonly kind: 'unmaterialized' };

export class JsonlSourcePrefixChangedError extends Error {
  constructor(sourcePath: string) {
    super(`Source transcript prefix changed while reading: ${sourcePath}`);
    this.name = 'JsonlSourcePrefixChangedError';
  }
}

const READ_CHUNK_BYTES = 64 * 1024;
const WRITE_BATCH_BYTES = 1024 * 1024;

interface PhysicalLine {
  readonly bytes: Buffer;
  readonly lineNumber: number;
  readonly terminated: boolean;
}

interface ParsedLine {
  readonly value: unknown;
  readonly raw: string;
  readonly lineNumber: number;
}

// Identifies the bytes a fork was derived from without retaining them. The prefix digest
// excludes the final line's terminator, which a retained-prefix append may still add; the
// byte digest covers exactly what a whole-session fork read.
interface SourceDigest {
  readonly prefixLength: number;
  readonly prefixDigest: string;
  readonly terminated: boolean;
  readonly byteLength: number;
  readonly byteDigest: string;
}

// Forks in one streaming pass. Each 64 KiB read yields to the event loop, only parsed entries
// are retained, and copied lines stream to the target, so a rollout of any size neither
// blocks other work nor holds whole-file copies. The source is then re-read by digest to
// prove the fork was taken from a faithful prefix.
export async function forkJsonlTranscript(request: ForkJsonlRequest): Promise<ForkJsonlOutcome> {
  const targetAgentSessionId = crypto.randomUUID();
  const context = {
    sourceAgentSessionId: request.sourceAgentSessionId,
    targetAgentSessionId,
  };
  const target = new TargetWriter(() => request.createTargetPath?.({
    sourcePath: request.sourcePath,
    targetAgentSessionId,
    createdAt: new Date(),
  }) ?? path.join(path.dirname(request.sourcePath), `${targetAgentSessionId}.jsonl`));
  try {
    const read = request.cutoffLine === null
      ? await readWholeSession(request, context, target)
      : await readRetainedPrefix(request, context, target);
    const transformed = request.transformEntries?.({
      selectedEntries: read.entries.selected,
      sourceEntries: read.entries.source,
      ...context,
    });
    if (
      request.allowUnmaterializedWholeSession
      && (transformed?.entries.length ?? read.entries.selectedCount) === 0
    ) {
      if (request.cutoffLine !== null) {
        throw new Error('Only whole-session JSONL forks can remain unmaterialized');
      }
      await target.abandon();
      await verifySource(request, read.digest);
      return { kind: 'unmaterialized' };
    }
    if (transformed) {
      for (const entry of transformed.entries) await target.line(serializeJsonlEntry(entry, request.sourcePath));
    }
    await target.finish();
    await verifySource(request, read.digest);
    return {
      kind: 'materialized',
      agentSessionId: targetAgentSessionId,
      nativePath: target.path!,
      ...(transformed?.expectedSemanticDigest !== undefined
        ? { expectedSemanticDigest: transformed.expectedSemanticDigest }
        : {}),
    };
  } catch (error) {
    await target.remove();
    throw error;
  }
}

interface SourceRead {
  readonly entries: ForkEntries;
  readonly digest: SourceDigest;
}

// Only a whole-graph transform needs parsed entries; a line-by-line copy just counts them.
class ForkEntries {
  readonly selected: unknown[] = [];
  readonly source: unknown[] = [];
  selectedCount = 0;

  constructor(private readonly retained: boolean) {}

  addSource(value: unknown): void {
    if (this.retained) this.source.push(value);
  }

  addSelected(value: unknown): void {
    this.selectedCount += 1;
    if (this.retained) this.selected.push(value);
  }
}

// A whole-session fork copies the bytes present when it starts. A working chat keeps
// appending; the trailing partial line is left out and later bytes are never read.
async function readWholeSession(
  request: ForkJsonlRequest,
  context: ForkTranscriptEntryContext,
  target: TargetWriter,
): Promise<SourceRead> {
  const entries = new ForkEntries(request.transformEntries !== undefined);
  const allowMissing = request.allowUnmaterializedWholeSession === true;
  const before = await fs.stat(request.sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  });
  if (before === null) return { entries, digest: emptyDigest() };
  const hash = new PrefixHash();
  const copy = new WholeSessionCopy(request, context, target);
  const file = await fs.open(request.sourcePath, 'r');
  try {
    for await (const line of readPhysicalLines(file, before.size)) {
      hash.add(line);
      const parsed = parseFirstJsonlValue(line.bytes.toString('utf8'));
      if (parsed.kind === 'empty') {
        await copy.empty();
        continue;
      }
      if (parsed.kind === 'incomplete') {
        await copy.incomplete(line.lineNumber);
        continue;
      }
      if (parsed.kind !== 'value') {
        copy.assertComplete();
        throw invalidJsonl(request.sourcePath, line.lineNumber);
      }
      const entry = { value: parsed.value, raw: parsed.raw, lineNumber: line.lineNumber };
      entries.addSource(entry.value);
      entries.addSelected(await copy.entry(entry));
    }
  } finally {
    await file.close();
  }
  copy.finish();
  const after = await fs.stat(request.sourcePath);
  if (sourceChangedDuringRead(before, after)) throw new JsonlSourcePrefixChangedError(request.sourcePath);
  return { entries, digest: hash.digest() };
}

async function readRetainedPrefix(
  request: ForkJsonlRequest,
  context: ForkTranscriptEntryContext,
  target: TargetWriter,
): Promise<SourceRead> {
  const lineCount = request.cutoffLine === 0 ? (request.leadingLineCount ?? 0) : request.cutoffLine!;
  if (!Number.isSafeInteger(lineCount) || lineCount < 0) {
    throw new JsonlSourcePrefixChangedError(request.sourcePath);
  }
  const hash = new PrefixHash();
  const transforms = request.transformEntries !== undefined;
  const entries = new ForkEntries(transforms);
  let retainedLines = 0;
  // A transform also receives every later source entry; only the final one may be incomplete.
  let incompleteLine: number | null = null;
  const file = await fs.open(request.sourcePath, 'r');
  try {
    for await (const line of readPhysicalLines(file, null)) {
      if (line.lineNumber > lineCount) {
        if (!transforms) break;
        const parsed = parseFirstJsonlValue(line.bytes.toString('utf8'));
        if (parsed.kind === 'empty') continue;
        if (incompleteLine !== null) throw invalidJsonl(request.sourcePath, incompleteLine);
        if (parsed.kind === 'incomplete') incompleteLine = line.lineNumber;
        else if (parsed.kind === 'value') entries.addSource(parsed.value);
        else throw invalidJsonl(request.sourcePath, line.lineNumber);
        continue;
      }
      hash.add(line);
      retainedLines = line.lineNumber;
      const parsed = parseFirstJsonlValue(line.bytes.toString('utf8'));
      if (parsed.kind === 'empty') {
        if (!transforms) await target.line('');
        continue;
      }
      if (parsed.kind !== 'value') throw new JsonlSourcePrefixChangedError(request.sourcePath);
      entries.addSource(parsed.value);
      const projected = project(request, context, { value: parsed.value, raw: parsed.raw, lineNumber: line.lineNumber });
      entries.addSelected(projected.value);
      if (!transforms) await target.line(projected.serialized);
    }
  } finally {
    await file.close();
  }
  if (retainedLines < lineCount) throw new JsonlSourcePrefixChangedError(request.sourcePath);
  return { entries, digest: hash.digest() };
}

// Copies a whole session line by line. Empty lines count toward physical positions only once
// a later entry follows them, and only the final content line may be incomplete.
class WholeSessionCopy {
  #pendingEmpty = 0;
  #incompleteLine: number | null = null;

  constructor(
    private readonly request: ForkJsonlRequest,
    private readonly context: ForkTranscriptEntryContext,
    private readonly target: TargetWriter,
  ) {}

  async empty(): Promise<void> {
    this.#pendingEmpty += 1;
  }

  async incomplete(lineNumber: number): Promise<void> {
    this.assertComplete();
    await this.#flushEmpty();
    this.#incompleteLine = lineNumber;
  }

  async entry(entry: ParsedLine): Promise<unknown> {
    this.assertComplete();
    await this.#flushEmpty();
    const projected = project(this.request, this.context, entry);
    if (!this.request.transformEntries) await this.target.line(projected.serialized);
    return projected.value;
  }

  finish(): void {
    this.#pendingEmpty = 0;
  }

  assertComplete(): void {
    if (this.#incompleteLine !== null) throw invalidJsonl(this.request.sourcePath, this.#incompleteLine);
  }

  async #flushEmpty(): Promise<void> {
    for (; this.#pendingEmpty > 0; this.#pendingEmpty -= 1) {
      if (!this.request.transformEntries) await this.target.line('');
    }
  }
}

function project(
  request: ForkJsonlRequest,
  context: ForkTranscriptEntryContext,
  entry: ParsedLine,
): { readonly value: unknown; readonly serialized: string } {
  if (!request.rewriteEntry) return { value: entry.value, serialized: entry.raw };
  const retainedMessageCount = request.retainedMessageCounts?.get(entry.lineNumber);
  const rewritten = request.rewriteEntry(entry.value, {
    ...context,
    ...(retainedMessageCount !== undefined ? { retainedMessageCount } : {}),
  });
  const serialized = Object.is(rewritten, entry.value) ? entry.raw : JSON.stringify(rewritten);
  if (serialized === undefined) {
    throw new Error(
      `Fork transcript rewriter returned a non-JSON value at ${request.sourcePath}:${entry.lineNumber}`,
    );
  }
  return { value: rewritten, serialized };
}

async function verifySource(request: ForkJsonlRequest, expected: SourceDigest): Promise<void> {
  if (request.cutoffLine === null) {
    await verifyWholeSessionPrefix(request, expected);
    return;
  }
  const lineCount = request.cutoffLine === 0 ? (request.leadingLineCount ?? 0) : request.cutoffLine;
  const file = await fs.open(request.sourcePath, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new JsonlSourcePrefixChangedError(request.sourcePath);
    throw error;
  });
  const hash = new PrefixHash();
  let retainedLines = 0;
  try {
    for await (const line of readPhysicalLines(file, null)) {
      if (line.lineNumber > lineCount) break;
      hash.add(line);
      retainedLines = line.lineNumber;
    }
  } finally {
    await file.close();
  }
  const current = hash.digest();
  if (
    retainedLines < lineCount
    || current.prefixLength !== expected.prefixLength
    || current.prefixDigest !== expected.prefixDigest
    || (expected.terminated && !current.terminated)
  ) {
    throw new JsonlSourcePrefixChangedError(request.sourcePath);
  }
}

// Transcripts only grow, so a whole-session snapshot stays faithful while its bytes remain a
// prefix of the source; only a rewrite of already-read bytes invalidates it.
async function verifyWholeSessionPrefix(request: ForkJsonlRequest, expected: SourceDigest): Promise<void> {
  const allowMissing = request.allowUnmaterializedWholeSession === true;
  const file = await fs.open(request.sourcePath, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && allowMissing && expected.byteLength === 0) return null;
    if (error.code === 'ENOENT') throw new JsonlSourcePrefixChangedError(request.sourcePath);
    throw error;
  });
  if (file === null) return;
  const hash = crypto.createHash('sha256');
  let length = 0;
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    while (length < expected.byteLength) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, expected.byteLength - length), length);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      length += bytesRead;
    }
  } finally {
    await file.close();
  }
  if (length !== expected.byteLength || hash.digest('hex') !== expected.byteDigest) {
    throw new JsonlSourcePrefixChangedError(request.sourcePath);
  }
}

async function* readPhysicalLines(file: FileHandle, limit: number | null): AsyncGenerator<PhysicalLine> {
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  let lineNumber = 1;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  for (;;) {
    const length = limit === null ? buffer.length : Math.min(buffer.length, limit - position);
    if (length <= 0) break;
    const { bytesRead } = await file.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      const segment = chunk.subarray(start, index);
      const bytes = pendingLength > 0 ? Buffer.concat([...pending, segment], pendingLength + segment.length) : Buffer.from(segment);
      pending = [];
      pendingLength = 0;
      yield { bytes, lineNumber, terminated: true };
      lineNumber += 1;
      start = index + 1;
    }
    if (start < chunk.length) {
      pending.push(Buffer.from(chunk.subarray(start)));
      pendingLength += chunk.length - start;
    }
  }
  if (pendingLength > 0) yield { bytes: Buffer.concat(pending, pendingLength), lineNumber, terminated: false };
}

class PrefixHash {
  readonly #prefix = crypto.createHash('sha256');
  readonly #bytes = crypto.createHash('sha256');
  #prefixLength = 0;
  #pendingTerminator = false;
  #terminated = true;

  add(line: PhysicalLine): void {
    if (this.#pendingTerminator) {
      this.#prefix.update('\n');
      this.#prefixLength += 1;
    }
    this.#prefix.update(line.bytes);
    this.#bytes.update(line.bytes);
    this.#prefixLength += line.bytes.length;
    if (line.terminated) this.#bytes.update('\n');
    this.#pendingTerminator = line.terminated;
    this.#terminated = line.terminated;
  }

  digest(): SourceDigest {
    return {
      prefixLength: this.#prefixLength,
      prefixDigest: this.#prefix.digest('hex'),
      terminated: this.#terminated,
      byteLength: this.#prefixLength + (this.#pendingTerminator ? 1 : 0),
      byteDigest: this.#bytes.digest('hex'),
    };
  }
}

function emptyDigest(): SourceDigest {
  return new PrefixHash().digest();
}

// Opens the target only once there is content to write, so an unmaterialized or failed fork
// never leaves a file behind.
class TargetWriter {
  #path: string | null = null;
  #file: FileHandle | null = null;
  #batch: string[] = [];
  #batchBytes = 0;

  constructor(private readonly createPath: () => string) {}

  get path(): string | null { return this.#path; }

  async line(text: string): Promise<void> {
    this.#batch.push(`${text}\n`);
    this.#batchBytes += text.length + 1;
    if (this.#batchBytes >= WRITE_BATCH_BYTES) await this.#flush();
  }

  async finish(): Promise<void> {
    await this.#flush();
    await this.#open();
    await this.#file!.close();
    this.#file = null;
  }

  async abandon(): Promise<void> {
    this.#batch = [];
    this.#batchBytes = 0;
    await this.remove();
  }

  async remove(): Promise<void> {
    await this.#file?.close().catch(() => undefined);
    this.#file = null;
    if (this.#path) await fs.rm(this.#path, { force: true }).catch(() => undefined);
  }

  async #open(): Promise<void> {
    if (this.#file) return;
    this.#path ??= this.createPath();
    this.#file = await fs.open(this.#path, 'wx', 0o600);
  }

  async #flush(): Promise<void> {
    if (this.#batch.length === 0) return;
    await this.#open();
    const data = Buffer.from(this.#batch.join(''), 'utf8');
    this.#batch = [];
    this.#batchBytes = 0;
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await this.#file!.write(data, written, data.length - written);
      written += bytesWritten;
    }
  }
}

function serializeJsonlEntry(entry: unknown, sourcePath: string): string {
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) {
    throw new Error(`Fork transcript transformer returned a non-JSON value for ${sourcePath}`);
  }
  return serialized;
}

function invalidJsonl(sourcePath: string, lineNumber: number): Error {
  return new Error(`Invalid JSONL at ${sourcePath}:${lineNumber}`);
}

function sourceChangedDuringRead(before: Stats, after: Stats): boolean {
  if (before.dev !== after.dev || before.ino !== after.ino) return true;
  // A working chat appends while the read runs. Growth of the same file leaves what was read a
  // prefix of it, which the post-write check confirms; anything else is a rewrite.
  if (after.size > before.size) return false;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { hasNodeErrorCode } from '../lib/errors.js';
import type { EventLoopSteps } from '../shared/event-loop.js';
import {
  collapseUsageCopies,
  isMalformedUsage,
  type MalformedUsage,
  type TranscriptUsageFormat,
  type UsageRecord,
} from './usage-record.js';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const READ_CHUNK_BYTES = 256 * 1024;
const STAT_CONCURRENCY = 16;
// Claude keeps subagent transcripts two levels below a project directory.
const MAX_DIRECTORY_DEPTH = 6;
// A line this long carries a tool payload; buffering it whole would let one file exhaust memory.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// Usage older than any selectable window is dropped at parse time, and cached
// files untouched for this long are forgotten.
const RETENTION_MS = 92 * 86_400_000;
const GUARD_BYTES = 64;
const PLAIN_SUFFIX = '.jsonl';
// Codex can compress cold rollouts in place; compressed files are complete and never grow.
const COMPRESSED_SUFFIX = '.jsonl.zst';

interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedTranscript<State> {
  readonly size: number;
  readonly mtimeMs: number;
  // Records from newline-terminated lines, one per request; a grown file appends to these.
  readonly records: readonly UsageRecord[];
  readonly malformed: readonly MalformedUsage[];
  // Records from an unterminated last line, reread once the line completes.
  readonly tailRecords: readonly UsageRecord[];
  readonly resumeOffset: number;
  // Guards a resume against a file rewritten to a larger size.
  readonly guardHash: number;
  readonly state: State;
}

export interface ScannedTranscript {
  readonly path: string;
  readonly records: readonly UsageRecord[];
  readonly malformed: readonly MalformedUsage[];
}

export interface TranscriptUsageScan {
  // Whether any configured root exists on this executor, readable or not.
  readonly rootFound: boolean;
  readonly files: readonly ScannedTranscript[];
  readonly unreadablePaths: number;
}

export interface TranscriptUsageScannerOptions<State> {
  // Names the scan's event-loop steps in slow-step reports.
  readonly operation: string;
  readonly format: TranscriptUsageFormat<State>;
  // Resolved per scan, so environment changes apply without restarting the integration.
  readonly roots: () => readonly string[];
  readonly now?: () => number;
}

interface ParsedLines<State> {
  readonly records: UsageRecord[];
  readonly malformed: MalformedUsage[];
  readonly tailRecords: UsageRecord[];
  readonly resumeOffset: number;
  readonly state: State;
}

/**
 * Reads usage records from JSONL transcripts under the configured roots. Parsed
 * files stay cached in memory by size and modification time, and a grown file
 * resumes after its last complete line, so repeated scans read only new bytes.
 * Scans run one at a time; a queued scan reuses what the previous one parsed.
 */
export class TranscriptUsageScanner<State> {
  readonly #options: TranscriptUsageScannerOptions<State>;
  readonly #cache = new Map<string, CachedTranscript<State>>();
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TranscriptUsageScannerOptions<State>) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  scan(sinceMs: number, steps: EventLoopSteps, signal?: AbortSignal): Promise<TranscriptUsageScan> {
    const run = this.#queue.then(() => this.#scan(sinceMs, steps, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #scan(sinceMs: number, steps: EventLoopSteps, signal: AbortSignal | undefined): Promise<TranscriptUsageScan> {
    signal?.throwIfAborted();
    const listing = await listTranscripts(this.#options.roots(), signal);
    const retainedSinceMs = this.#now() - RETENTION_MS;
    for (const filePath of [...this.#cache.keys()]) {
      const mtimeMs = listing.existing.get(filePath);
      if (mtimeMs === undefined || mtimeMs < retainedSinceMs) this.#cache.delete(filePath);
    }

    const files: ScannedTranscript[] = [];
    let unreadablePaths = listing.unreadablePaths;
    for (const file of listing.files) {
      if (file.mtimeMs < sinceMs) continue;
      signal?.throwIfAborted();
      const cached = this.#cache.get(file.path);
      let entry: CachedTranscript<State> | null = cached ?? null;
      if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) {
        entry = await this.#read(file, cached, retainedSinceMs, steps);
        if (entry) this.#cache.set(file.path, entry);
      }
      if (!entry) {
        // A read failure is not an empty transcript; keep reporting the last good parse.
        unreadablePaths += 1;
        if (!cached) continue;
        entry = cached;
      }
      files.push({
        path: file.path,
        records: entry.tailRecords.length === 0 ? entry.records : [...entry.records, ...entry.tailRecords],
        malformed: entry.malformed,
      });
    }
    return { rootFound: listing.rootFound, files, unreadablePaths };
  }

  async #read(
    file: TranscriptFile,
    cached: CachedTranscript<State> | undefined,
    retainedSinceMs: number,
    steps: EventLoopSteps,
  ): Promise<CachedTranscript<State> | null> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file.path, 'r');
    } catch {
      return null;
    }
    try {
      let parsed: ParsedLines<State>;
      let base: Pick<CachedTranscript<State>, 'records' | 'malformed'> = { records: [], malformed: [] };
      if (file.path.endsWith(COMPRESSED_SUFFIX)) {
        const content = await Bun.zstdDecompress(await handle.readFile());
        parsed = await this.#parseLines([content], 0, this.#options.format.createState(), steps);
      } else {
        // Only a strictly grown file resumes; same size with a new mtime means rewritten content.
        const resume = cached && file.size > cached.size
          && await guardMatches(handle, cached.resumeOffset, cached.guardHash);
        const start = resume ? cached.resumeOffset : 0;
        if (resume) base = cached;
        const state = resume ? this.#options.format.cloneState(cached.state) : this.#options.format.createState();
        const chunks = file.size > start
          ? handle.createReadStream({ start, end: file.size - 1, highWaterMark: READ_CHUNK_BYTES, autoClose: false }) as AsyncIterable<Buffer>
          : [];
        parsed = await this.#parseLines(chunks, start, state, steps);
      }
      const retained = (record: UsageRecord) => record.timestampMs >= retainedSinceMs;
      return {
        size: file.size,
        mtimeMs: file.mtimeMs,
        records: collapseUsageCopies([...base.records, ...parsed.records.filter(retained)]),
        malformed: [...base.malformed, ...parsed.malformed.filter((entry) => entry.timestampMs === null || entry.timestampMs >= retainedSinceMs)],
        tailRecords: parsed.tailRecords.filter(retained),
        resumeOffset: parsed.resumeOffset,
        guardHash: file.path.endsWith(COMPRESSED_SUFFIX) ? 0 : await readGuardHash(handle, parsed.resumeOffset),
        state: parsed.state,
      };
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // Parses newline-terminated lines from `offset` on. The state returned is the
  // state after the last complete line; an unterminated tail parses against a copy.
  async #parseLines(
    chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    offset: number,
    state: State,
    steps: EventLoopSteps,
  ): Promise<ParsedLines<State>> {
    const { format } = this.#options;
    const markers = format.lineMarkers.map((marker) => Buffer.from(marker, 'latin1'));
    const hasMarker = (bytes: Buffer) => markers.some((marker) => bytes.includes(marker));
    const records: UsageRecord[] = [];
    const malformed: MalformedUsage[] = [];
    const parse = (line: Buffer, lineState: State, into: UsageRecord[], malformedInto: MalformedUsage[] | null) => {
      if (!hasMarker(line)) return;
      const end = line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length;
      const result = format.parseLine(line.toString('utf8', 0, end), lineState);
      if (!result) return;
      if (!isMalformedUsage(result)) into.push(result);
      else malformedInto?.push(result);
    };

    let pending: Buffer[] = [];
    let pendingBytes = 0;
    // An oversized line is skipped; it counts as malformed only if it may have carried usage.
    let oversized = false;
    let oversizedHasMarker = false;
    let position = offset;
    let resumeOffset = offset;
    for await (const raw of chunks) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, lineStart);
        const piece = chunk.subarray(lineStart, newline === -1 ? chunk.length : newline);
        if (oversized || pendingBytes + piece.length > MAX_LINE_BYTES) {
          if (!oversized) oversizedHasMarker = pending.some(hasMarker);
          oversized = true;
          oversizedHasMarker ||= hasMarker(piece);
          pending = [];
          pendingBytes = 0;
        } else if (piece.length > 0) {
          pending.push(piece);
          pendingBytes += piece.length;
        }
        if (newline === -1) break;
        if (oversized) {
          if (oversizedHasMarker) malformed.push({ malformed: true, timestampMs: null });
        } else {
          parse(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes), state, records, malformed);
        }
        pending = [];
        pendingBytes = 0;
        oversized = false;
        oversizedHasMarker = false;
        lineStart = newline + 1;
        resumeOffset = position + lineStart;
        if (steps.due) await steps.next();
      }
      position += chunk.length;
    }

    const committedState = format.cloneState(state);
    const tailRecords: UsageRecord[] = [];
    // A tail may still be being written, so its parse failures are not malformed usage.
    if (!oversized && pendingBytes > 0) {
      parse(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes), state, tailRecords, null);
    }
    return { records, malformed, tailRecords, resumeOffset, state: committedState };
  }
}

interface TranscriptListing {
  readonly rootFound: boolean;
  // Every transcript under the roots with its modification time, for cache pruning.
  readonly existing: ReadonlyMap<string, number>;
  readonly files: readonly TranscriptFile[];
  readonly unreadablePaths: number;
}

async function listTranscripts(roots: readonly string[], signal: AbortSignal | undefined): Promise<TranscriptListing> {
  const candidates = new Set<string>();
  let rootFound = false;
  let unreadablePaths = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A root that exists but cannot be listed still holds transcripts we failed to read.
      if (depth === 0 && hasNodeErrorCode(error, 'ENOENT')) return;
      if (depth === 0) rootFound = true;
      unreadablePaths += 1;
      return;
    }
    if (depth === 0) rootFound = true;
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      // Dirent types do not follow symlinks, so linked directories are never walked twice.
      if (entry.isDirectory()) {
        if (depth < MAX_DIRECTORY_DEPTH) await walk(child, depth + 1);
      } else if (entry.isFile() && (entry.name.endsWith(PLAIN_SUFFIX) || entry.name.endsWith(COMPRESSED_SUFFIX))) {
        candidates.add(child);
      }
    }
  };
  for (const root of new Set(roots.map((root) => path.resolve(root)))) await walk(root, 0);

  // While Codex compresses a rollout both forms exist briefly; the plain file is authoritative.
  const paths = [...candidates]
    .filter((candidate) => !candidate.endsWith(COMPRESSED_SUFFIX) || !candidates.has(candidate.slice(0, -'.zst'.length)))
    // Sorted paths make the scan order, and with it any first-seen tie, deterministic.
    .sort();
  const stats: Array<TranscriptFile | null> = new Array(paths.length).fill(null);
  let next = 0;
  const statNext = async () => {
    while (next < paths.length) {
      const index = next++;
      try {
        const stat = await fs.stat(paths[index]!);
        stats[index] = { path: paths[index]!, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (!hasNodeErrorCode(error, 'ENOENT')) unreadablePaths += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, statNext));
  const files = stats.filter((file): file is TranscriptFile => file !== null);
  return {
    rootFound,
    existing: new Map(files.map((file) => [file.path, file.mtimeMs])),
    files,
    unreadablePaths,
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function readGuardHash(handle: fs.FileHandle, resumeOffset: number): Promise<number> {
  const length = Math.min(GUARD_BYTES, resumeOffset);
  if (length === 0) return 0;
  const window = Buffer.alloc(length);
  const { bytesRead } = await handle.read(window, 0, length, resumeOffset - length);
  return fnv1a(window.subarray(0, bytesRead));
}

async function guardMatches(handle: fs.FileHandle, resumeOffset: number, guardHash: number): Promise<boolean> {
  if (resumeOffset <= 0) return false;
  try {
    return await readGuardHash(handle, resumeOffset) === guardHash;
  } catch {
    return false;
  }
}

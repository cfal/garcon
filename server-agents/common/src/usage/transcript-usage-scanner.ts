import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { hasNodeErrorCode } from '../lib/errors.js';
import { EventLoopSteps } from '../shared/event-loop.js';
import type { TranscriptUsageFormat, UsageRecord } from './usage-record.js';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const READ_CHUNK_BYTES = 256 * 1024;
const STAT_CONCURRENCY = 16;
// Claude keeps subagent transcripts two levels below a project directory.
const MAX_DIRECTORY_DEPTH = 6;
// A line this long carries a tool payload; buffering it whole would let one file exhaust memory.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// Cached parses outlive any selectable window by this much before pruning.
const CACHE_RETENTION_MS = 92 * 86_400_000;
const GUARD_BYTES = 64;

interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface CachedTranscript<State> {
  readonly size: number;
  readonly mtimeMs: number;
  // Records from newline-terminated lines; the next read of a grown file appends to these.
  readonly records: readonly UsageRecord[];
  // Records from an unterminated last line, reread once the line completes.
  readonly tailRecords: readonly UsageRecord[];
  readonly resumeOffset: number;
  // Guards a resume against a file rewritten to a larger size.
  readonly guardHash: number;
  readonly state: State;
  readonly malformedRecords: number;
}

export interface ScannedTranscript {
  readonly path: string;
  readonly records: readonly UsageRecord[];
}

export interface TranscriptUsageScan {
  // Whether any configured root exists on this executor.
  readonly rootFound: boolean;
  readonly files: readonly ScannedTranscript[];
  readonly unreadablePaths: number;
  readonly malformedRecords: number;
}

export interface TranscriptUsageScannerOptions<State> {
  // Names the scan's event-loop steps in slow-step reports.
  readonly operation: string;
  readonly format: TranscriptUsageFormat<State>;
  // Resolved per scan, so environment changes apply without restarting the integration.
  readonly roots: () => readonly string[];
  readonly now?: () => number;
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
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: TranscriptUsageScannerOptions<State>) {
    this.#options = options;
  }

  scan(sinceMs: number, signal?: AbortSignal): Promise<TranscriptUsageScan> {
    const run = this.#queue.then(() => this.#scan(sinceMs, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #scan(sinceMs: number, signal: AbortSignal | undefined): Promise<TranscriptUsageScan> {
    signal?.throwIfAborted();
    const steps = new EventLoopSteps(this.#options.operation);
    const listing = await listTranscripts(this.#options.roots(), signal);
    const nowMs = (this.#options.now ?? Date.now)();
    for (const filePath of [...this.#cache.keys()]) {
      const mtimeMs = listing.existing.get(filePath);
      if (mtimeMs === undefined || mtimeMs < nowMs - CACHE_RETENTION_MS) this.#cache.delete(filePath);
    }

    const files: ScannedTranscript[] = [];
    let unreadablePaths = listing.unreadablePaths;
    let malformedRecords = 0;
    for (const file of listing.files) {
      if (file.mtimeMs < sinceMs) continue;
      signal?.throwIfAborted();
      const cached = this.#cache.get(file.path);
      let entry: CachedTranscript<State> | null = cached ?? null;
      if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) {
        entry = await this.#read(file, cached, steps);
        if (entry) this.#cache.set(file.path, entry);
      }
      if (!entry) {
        // A read failure is not an empty transcript; keep reporting the last good parse.
        unreadablePaths += 1;
        if (!cached) continue;
        entry = cached;
      }
      malformedRecords += entry.malformedRecords;
      files.push({
        path: file.path,
        records: entry.tailRecords.length === 0 ? entry.records : [...entry.records, ...entry.tailRecords],
      });
    }
    return { rootFound: listing.rootFound, files, unreadablePaths, malformedRecords };
  }

  async #read(
    file: TranscriptFile,
    cached: CachedTranscript<State> | undefined,
    steps: EventLoopSteps,
  ): Promise<CachedTranscript<State> | null> {
    const { format } = this.#options;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file.path, 'r');
    } catch {
      return null;
    }
    try {
      let state = format.createState();
      let records: UsageRecord[] = [];
      let start = 0;
      // Only a strictly grown file resumes; same size with a new mtime means rewritten content.
      if (cached && file.size > cached.size && await guardMatches(handle, cached.resumeOffset, cached.guardHash)) {
        state = format.cloneState(cached.state);
        records = [...cached.records];
        start = cached.resumeOffset;
      }

      const markers = format.lineMarkers.map((marker) => Buffer.from(marker, 'latin1'));
      const parse = (line: Buffer, into: UsageRecord[]) => {
        if (line.length > MAX_LINE_BYTES || !markers.some((marker) => line.includes(marker))) return;
        const end = line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length;
        const record = format.parseLine(line.toString('utf8', 0, end), state);
        if (record) into.push(record);
      };

      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let offset = start;
      let resumeOffset = start;
      let oversizedLines = 0;
      if (file.size > start) {
        const stream = handle.createReadStream({
          start,
          end: file.size - 1,
          highWaterMark: READ_CHUNK_BYTES,
          autoClose: false,
        }) as AsyncIterable<Buffer>;
        for await (const chunk of stream) {
          let lineStart = 0;
          while (lineStart < chunk.length) {
            const newline = chunk.indexOf(NEWLINE, lineStart);
            const piece = chunk.subarray(lineStart, newline === -1 ? chunk.length : newline);
            if (pendingBytes + piece.length > MAX_LINE_BYTES) {
              if (pendingBytes <= MAX_LINE_BYTES) oversizedLines += 1;
              pending = [];
              pendingBytes = MAX_LINE_BYTES + 1;
            } else if (piece.length > 0) {
              pending.push(piece);
              pendingBytes += piece.length;
            }
            if (newline === -1) break;
            if (pendingBytes <= MAX_LINE_BYTES) {
              parse(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes), records);
            }
            pending = [];
            pendingBytes = 0;
            lineStart = newline + 1;
            resumeOffset = offset + lineStart;
            if (steps.due) await steps.next();
          }
          offset += chunk.length;
        }
      }

      const committedState = format.cloneState(state);
      const tailRecords: UsageRecord[] = [];
      if (pendingBytes > 0 && pendingBytes <= MAX_LINE_BYTES) {
        parse(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes), tailRecords);
      }
      return {
        size: file.size,
        mtimeMs: file.mtimeMs,
        records,
        tailRecords,
        resumeOffset,
        guardHash: await readGuardHash(handle, resumeOffset),
        state: committedState,
        malformedRecords: format.malformedRecords(state) + oversizedLines,
      };
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
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
  const candidates: string[] = [];
  let rootFound = false;
  let unreadablePaths = 0;
  const walk = async (directory: string, depth: number, isRoot: boolean): Promise<void> => {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!(isRoot && hasNodeErrorCode(error, 'ENOENT'))) unreadablePaths += 1;
      return;
    }
    if (isRoot) rootFound = true;
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      // Dirent types do not follow symlinks, so linked directories are never walked twice.
      if (entry.isDirectory()) {
        if (depth < MAX_DIRECTORY_DEPTH) await walk(child, depth + 1, false);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        candidates.push(child);
      }
    }
  };
  for (const root of [...new Set(roots.map((root) => path.resolve(root)))]) await walk(root, 0, true);

  // Sorted paths make the scan order, and with it any first-seen tie, deterministic.
  candidates.sort();
  const stats: Array<TranscriptFile | null> = new Array(candidates.length).fill(null);
  let next = 0;
  const statNext = async () => {
    while (next < candidates.length) {
      const index = next++;
      try {
        const stat = await fs.stat(candidates[index]!);
        stats[index] = { path: candidates[index]!, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (!hasNodeErrorCode(error, 'ENOENT')) unreadablePaths += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statNext));
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

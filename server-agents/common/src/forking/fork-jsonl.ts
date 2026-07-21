import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
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

export interface ForkJsonlRequest {
  readonly sourcePath: string;
  readonly sourceAgentSessionId: string;
  readonly cutoffLine: number | null;
  readonly leadingLineCount?: number;
  readonly retainedMessageCounts?: ReadonlyMap<number, number>;
  readonly sourceSnapshot?: JsonlSourceSnapshot;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly transformEntries?: (
    input: ForkTranscriptTransformInput,
  ) => ForkTranscriptTransformResult;
}

export interface ForkJsonlResult {
  readonly agentSessionId: string;
  readonly nativePath: string;
  readonly expectedSemanticDigest?: string;
}

export interface JsonlSourceSnapshot {
  readonly content: Buffer;
}

export class JsonlSourcePrefixChangedError extends Error {
  constructor(sourcePath: string) {
    super(`Source transcript prefix changed while reading: ${sourcePath}`);
    this.name = 'JsonlSourcePrefixChangedError';
  }
}

export async function snapshotJsonlSource(sourcePath: string): Promise<JsonlSourceSnapshot> {
  return { content: await fs.readFile(sourcePath) };
}

export function jsonlSourceLineCount(snapshot: JsonlSourceSnapshot, sourcePath: string): number {
  return normalizeJsonl(snapshot.content.toString('utf8'), sourcePath).lineCount;
}

export async function forkJsonlTranscript(request: ForkJsonlRequest): Promise<ForkJsonlResult> {
  const targetAgentSessionId = crypto.randomUUID();
  const targetPath = path.join(path.dirname(request.sourcePath), `${targetAgentSessionId}.jsonl`);
  const lineCount = request.cutoffLine === 0 ? (request.leadingLineCount ?? 0) : request.cutoffLine;
  const snapshot =
    request.cutoffLine === null
      ? await readStableSource(request.sourcePath)
      : (request.sourceSnapshot ?? (await snapshotJsonlSource(request.sourcePath)));
  const selected =
    request.cutoffLine === null
      ? normalizeJsonl(snapshot.content.toString('utf8'), request.sourcePath)
      : normalizeRetainedJsonl(snapshot.content, lineCount, request.sourcePath);

  const context = {
    sourceAgentSessionId: request.sourceAgentSessionId,
    targetAgentSessionId,
  };
  const projectedEntries = selected.entries.map((entry) => {
    if (!request.rewriteEntry) return entry.value;
    return request.rewriteEntry(entry.value, {
      ...context,
      ...(request.retainedMessageCounts
        ? {
            retainedMessageCount: request.retainedMessageCounts.get(entry.lineNumber) ?? 0,
          }
        : {}),
    });
  });
  const projectedByLine = new Map(
    selected.entries.map((entry, index) => [entry.lineNumber, projectedEntries[index]]),
  );
  const transformed = request.transformEntries?.({
    selectedEntries: projectedEntries,
    sourceEntries: normalizeJsonl(snapshot.content.toString('utf8'), request.sourcePath)
      .entries.map((entry) => entry.value),
    ...context,
  });
  const entriesByLine = new Map(selected.entries.map((entry) => [entry.lineNumber, entry]));
  const retained = transformed
    ? transformed.entries.map((entry) => serializeJsonlEntry(entry, request.sourcePath))
    : Array.from({ length: selected.lineCount }, (_, index) => {
    const lineNumber = index + 1;
    const entry = entriesByLine.get(lineNumber);
    if (!entry) return '';
    if (!request.rewriteEntry) return entry.raw;
    const rewritten = projectedByLine.get(lineNumber);
    const serialized = Object.is(rewritten, entry.value) ? entry.raw : JSON.stringify(rewritten);
    if (serialized === undefined) {
      throw new Error(
        `Fork transcript rewriter returned a non-JSON value at ${request.sourcePath}:${lineNumber}`,
      );
    }
    return serialized;
  });
  const content = retained.length > 0 ? `${retained.join('\n')}\n` : '';
  try {
    await fs.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (request.cutoffLine === null) {
      const current = await snapshotJsonlSource(request.sourcePath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new JsonlSourcePrefixChangedError(request.sourcePath);
          throw error;
        },
      );
      if (!current.content.equals(snapshot.content)) {
        throw new JsonlSourcePrefixChangedError(request.sourcePath);
      }
    } else {
      const current = await snapshotJsonlSource(request.sourcePath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new JsonlSourcePrefixChangedError(request.sourcePath);
          throw error;
        },
      );
      const currentPrefix = retainedPhysicalPrefix(current.content, lineCount, request.sourcePath);
      if (!sameRetainedPrefix(selected.prefix!, currentPrefix)) {
        throw new JsonlSourcePrefixChangedError(request.sourcePath);
      }
    }
  } catch (error) {
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    agentSessionId: targetAgentSessionId,
    nativePath: targetPath,
    ...(transformed?.expectedSemanticDigest !== undefined
      ? { expectedSemanticDigest: transformed.expectedSemanticDigest }
      : {}),
  };
}

function serializeJsonlEntry(entry: unknown, sourcePath: string): string {
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) {
    throw new Error(`Fork transcript transformer returned a non-JSON value for ${sourcePath}`);
  }
  return serialized;
}

interface PhysicalPrefix {
  readonly content: Buffer;
  readonly terminated: boolean;
}

function retainedPhysicalPrefix(
  source: Buffer,
  lineCount: number | null,
  sourcePath: string,
): PhysicalPrefix {
  if (!Number.isSafeInteger(lineCount) || lineCount === null || lineCount < 0) {
    throw new JsonlSourcePrefixChangedError(sourcePath);
  }
  if (lineCount === 0) return { content: source.subarray(0, 0), terminated: true };
  let lineStart = 0;
  for (let line = 1; line <= lineCount; line += 1) {
    const lineEnd = source.indexOf(0x0a, lineStart);
    if (lineEnd !== -1) {
      if (line === lineCount) {
        return { content: source.subarray(0, lineEnd + 1), terminated: true };
      }
      lineStart = lineEnd + 1;
      continue;
    }
    if (line === lineCount && lineStart < source.length) {
      return { content: source, terminated: false };
    }
    throw new JsonlSourcePrefixChangedError(sourcePath);
  }
  throw new JsonlSourcePrefixChangedError(sourcePath);
}

function sameRetainedPrefix(expected: PhysicalPrefix, current: PhysicalPrefix): boolean {
  if (expected.terminated) {
    return current.terminated && current.content.equals(expected.content);
  }
  if (!current.terminated) return current.content.equals(expected.content);
  return (
    current.content.length === expected.content.length + 1 &&
    current.content.subarray(0, expected.content.length).equals(expected.content)
  );
}

function normalizeRetainedJsonl(
  source: Buffer,
  lineCount: number | null,
  sourcePath: string,
): ReturnType<typeof normalizeJsonl> & { prefix: PhysicalPrefix } {
  const prefix = retainedPhysicalPrefix(source, lineCount, sourcePath);
  const lines = prefix.content.toString('utf8').split('\n');
  if (prefix.terminated) lines.pop();
  const entries: Array<{ value: unknown; raw: string; lineNumber: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseFirstJsonlValue(lines[index]!);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind !== 'value') throw new JsonlSourcePrefixChangedError(sourcePath);
    entries.push({
      value: parsed.value,
      raw: parsed.raw,
      lineNumber: index + 1,
    });
  }
  return { entries, lineCount: lines.length, prefix };
}

async function readStableSource(sourcePath: string): Promise<JsonlSourceSnapshot> {
  const before = await fs.stat(sourcePath);
  const content = await fs.readFile(sourcePath);
  const after = await fs.stat(sourcePath);
  if (fileChanged(before, after)) {
    throw new JsonlSourcePrefixChangedError(sourcePath);
  }
  return { content };
}

function normalizeJsonl(
  source: string,
  sourcePath: string,
): {
  entries: Array<{ value: unknown; raw: string; lineNumber: number }>;
  lineCount: number;
  prefix?: PhysicalPrefix;
} {
  const lines = source.split('\n');
  let lastContentLine = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim()) {
      lastContentLine = index;
      break;
    }
  }

  const entries: Array<{ value: unknown; raw: string; lineNumber: number }> = [];
  let incompleteLastLine = false;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseFirstJsonlValue(lines[index]!);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'value') {
      entries.push({
        value: parsed.value,
        raw: parsed.raw,
        lineNumber: index + 1,
      });
      continue;
    }
    if (parsed.kind === 'incomplete' && index === lastContentLine) {
      incompleteLastLine = true;
      break;
    }
    throw new Error(`Invalid JSONL at ${sourcePath}:${index + 1}`);
  }
  return {
    entries,
    lineCount: lastContentLine < 0 ? 0 : incompleteLastLine ? lastContentLine : lastContentLine + 1,
  };
}

function fileChanged(before: Stats, after: Stats): boolean {
  return (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  );
}

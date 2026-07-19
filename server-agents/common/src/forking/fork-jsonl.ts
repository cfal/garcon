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

export interface ForkJsonlRequest {
  readonly sourcePath: string;
  readonly sourceAgentSessionId: string;
  readonly cutoffLine: number | null;
  readonly leadingLineCount?: number;
  readonly retainedMessageCounts?: ReadonlyMap<number, number>;
  readonly rewriteEntry?: (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
}

export interface ForkJsonlResult {
  readonly agentSessionId: string;
  readonly nativePath: string;
}

export async function forkJsonlTranscript(request: ForkJsonlRequest): Promise<ForkJsonlResult> {
  const targetAgentSessionId = crypto.randomUUID();
  const targetPath = path.join(path.dirname(request.sourcePath), `${targetAgentSessionId}.jsonl`);
  const before = await fs.stat(request.sourcePath);
  const source = await fs.readFile(request.sourcePath, 'utf8');
  const after = await fs.stat(request.sourcePath);
  if (fileChanged(before, after)) {
    throw new Error(`Source transcript changed while reading: ${request.sourcePath}`);
  }

  const normalized = normalizeJsonl(source, request.sourcePath);
  const lineCount = request.cutoffLine === null
    ? normalized.lineCount
    : request.cutoffLine === 0
      ? request.leadingLineCount ?? 0
      : request.cutoffLine;
  if (!Number.isSafeInteger(lineCount) || lineCount < 0 || lineCount > normalized.lineCount) {
    throw new Error(`Invalid transcript cutoff ${lineCount} for ${request.sourcePath}`);
  }

  const context = {
    sourceAgentSessionId: request.sourceAgentSessionId,
    targetAgentSessionId,
  };
  const entriesByLine = new Map(normalized.entries.map((entry) => [entry.lineNumber, entry]));
  const retained = Array.from({ length: lineCount }, (_, index) => {
    const lineNumber = index + 1;
    const entry = entriesByLine.get(lineNumber);
    if (!entry) return '';
    if (!request.rewriteEntry) return entry.raw;
    const rewritten = request.rewriteEntry(entry.value, {
      ...context,
      ...(request.retainedMessageCounts
        ? { retainedMessageCount: request.retainedMessageCounts.get(lineNumber) ?? 0 }
        : {}),
    });
    const serialized = Object.is(rewritten, entry.value) ? entry.raw : JSON.stringify(rewritten);
    if (serialized === undefined) {
      throw new Error(`Fork transcript rewriter returned a non-JSON value at ${request.sourcePath}:${lineNumber}`);
    }
    return serialized;
  });
  const content = retained.length > 0 ? `${retained.join('\n')}\n` : '';
  await fs.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
  return { agentSessionId: targetAgentSessionId, nativePath: targetPath };
}

function normalizeJsonl(
  source: string,
  sourcePath: string,
): {
  entries: Array<{ value: unknown; raw: string; lineNumber: number }>;
  lineCount: number;
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
      entries.push({ value: parsed.value, raw: parsed.raw, lineNumber: index + 1 });
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
    lineCount: lastContentLine < 0
      ? 0
      : incompleteLastLine
        ? lastContentLine
        : lastContentLine + 1,
  };
}

function fileChanged(before: Stats, after: Stats): boolean {
  return before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs;
}

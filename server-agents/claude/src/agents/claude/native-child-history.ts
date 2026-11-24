import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRecord } from '@garcon/common/json';
import {
  AgentIntegrationError,
  type AgentNativeChildRef, type AgentNativeChildHistoryRequest, type AgentImportedTranscriptRow,
} from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { deterministicTranscriptTimestamp } from '@garcon/server-agent-common/shared/transcript-timestamp';
import { convertClaudeChildContent } from './native-child-content.js';

export interface ClaudeChildLocator {
  readonly configHomeDir: string;
  readonly rootNativePath: string;
  readonly rootSessionId: string;
  readonly agentId: string;
}

export function claudeChildRef(locator: ClaudeChildLocator): AgentNativeChildRef {
  return {
    ownerId: 'claude', schemaVersion: 1,
    key: JSON.stringify([locator.configHomeDir, locator.rootSessionId, locator.agentId]),
    value: { ...locator },
  };
}

export function parseClaudeChildRef(ref: AgentNativeChildRef): ClaudeChildLocator {
  const { configHomeDir, rootNativePath, rootSessionId, agentId } = ref.value;
  if (ref.ownerId !== 'claude' || ref.schemaVersion !== 1
    || typeof configHomeDir !== 'string' || !path.isAbsolute(configHomeDir)
    || typeof rootNativePath !== 'string' || !path.isAbsolute(rootNativePath)
    || !safeId(rootSessionId) || !safeId(agentId)
    || path.basename(rootNativePath) !== `${rootSessionId}.jsonl`
    || path.dirname(path.dirname(rootNativePath)) !== path.join(configHomeDir, 'projects')) {
    throw unavailable();
  }
  const locator = { configHomeDir, rootNativePath, rootSessionId, agentId };
  if (claudeChildRef(locator).key !== ref.key) throw unavailable();
  return locator;
}

interface ChainEntry {
  readonly type: string;
  readonly parentUuid: string | null;
  readonly message: boolean;
  readonly offset: number;
  readonly length: number;
  readonly lineNumber: number;
}

const MAX_CHAIN_ENTRIES = 250_000;
const MAX_CHAIN_IDENTITY_BYTES = 32 * 1024 * 1024;

export async function* loadClaudeChildHistory(
  request: AgentNativeChildHistoryRequest,
  assertSourceUnchanged: () => void,
): AsyncGenerator<readonly AgentImportedTranscriptRow[]> {
  const locator = parseClaudeChildRef(request.child);
  const steps = new EventLoopSteps('claude-child-history');
  const assertCurrent = () => { request.signal.throwIfAborted(); assertSourceUnchanged(); };
  assertCurrent();
  try {
    const source = await exactChildPath(locator, request.signal, steps);
    const initial = await fs.stat(source, { bigint: true });
    if (!initial.isFile()) throw unavailable();
    const entries = new Map<string, ChainEntry>();
    let identityBytes = 0;
    let leaf: string | null = null;
    for await (const { line, lineNumber, byteOffset } of readJsonlLineEntries(source, {
      signal: request.signal, maxLineBytes: 16 * 1024 * 1024, maxReadBytes: Number(initial.size),
    })) {
      assertCurrent();
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) throw unavailable();
      if (entry.type === 'user' || entry.type === 'assistant') {
        if (entry.sessionId !== locator.rootSessionId
          || (entry.agentId !== undefined && entry.agentId !== locator.agentId)
          || !safeId(entry.uuid)) throw unavailable();
        leaf = entry.uuid;
      }
      if (typeof entry.uuid === 'string' && chainType(entry.type)) {
        if (!safeId(entry.uuid) || (entry.parentUuid !== null && !safeId(entry.parentUuid))) throw unavailable();
        const parentUuid = entry.parentUuid;
        const previous = entries.get(entry.uuid);
        if (previous && previous.type !== entry.type) throw unavailable();
        identityBytes += Buffer.byteLength(entry.uuid) + Buffer.byteLength(parentUuid ?? '');
        if (previous) identityBytes -= Buffer.byteLength(entry.uuid) + Buffer.byteLength(previous.parentUuid ?? '');
        if (identityBytes > MAX_CHAIN_IDENTITY_BYTES || (!previous && entries.size >= MAX_CHAIN_ENTRIES)) throw unavailable();
        entries.set(entry.uuid, { type: entry.type, parentUuid, message: entry.type === 'user' || entry.type === 'assistant',
          offset: byteOffset, length: Buffer.byteLength(line), lineNumber: lineNumber ?? 0 });
      }
      if (steps.due) await steps.next();
    }
    const chain: ChainEntry[] = [];
    const seen = new Set<string>();
    // Native child selection follows parentUuid, not logicalParentUuid across compaction.
    while (leaf) {
      assertCurrent();
      if (seen.has(leaf)) throw unavailable();
      seen.add(leaf);
      const entry = entries.get(leaf);
      if (!entry) throw unavailable();
      chain.push(entry);
      leaf = entry.parentUuid;
      if (steps.due) await steps.next();
    }
    entries.clear();
    seen.clear();
    const handle = await fs.open(source, 'r');
    try {
      let batch: AgentImportedTranscriptRow[] = [];
      for (let index = chain.length - 1; index >= 0; index--) {
        assertCurrent();
        const entry = chain[index]!;
        const { lineNumber } = entry;
        if (entry.message) {
          const buffer = Buffer.alloc(entry.length);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
          if (bytesRead !== entry.length) throw unavailable();
          const value: unknown = JSON.parse(buffer.toString('utf8'));
          if (!isRecord(value) || !isRecord(value.message) || value.message.role !== entry.type) throw unavailable();
          const timestamp = typeof value.timestamp === 'string'
            ? value.timestamp : deterministicTranscriptTimestamp(lineNumber);
          for (const row of convertClaudeChildContent(value, timestamp)) {
            batch.push(row);
            if (batch.length === 256) { yield batch; batch = []; }
          }
        }
        if (steps.due) await steps.next();
      }
      if (batch.length) yield batch;
    } finally { await handle.close(); }
    const final = await fs.stat(source, { bigint: true });
    if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size
      || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) throw unavailable();
    assertCurrent();
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof AgentIntegrationError) throw error;
    throw unavailable();
  }
}

async function exactChildPath(locator: ClaudeChildLocator, signal: AbortSignal, steps: EventLoopSteps): Promise<string> {
  const project = path.dirname(locator.rootNativePath);
  const root = path.join(project, locator.rootSessionId, 'subagents');
  const realConfig = await fs.realpath(locator.configHomeDir);
  const realProject = await fs.realpath(project);
  if (path.dirname(realProject) !== path.join(realConfig, 'projects')
    || !(await fs.stat(locator.rootNativePath)).isFile()
    || await fs.realpath(root) !== path.join(realProject, locator.rootSessionId, 'subagents')) throw unavailable();
  const pending = [root];
  let result: string | null = null;
  let visited = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    for await (const entry of await fs.opendir(directory)) {
      if (++visited > 8192) throw unavailable();
      const candidate = path.join(directory, entry.name);
      if (entry.name === `agent-${locator.agentId}.jsonl`) {
        if (!entry.isFile() || result) throw unavailable();
        result = candidate;
      } else if (entry.isDirectory()) pending.push(candidate);
      if (steps.due) await steps.next();
    }
  }
  if (!result) throw unavailable();
  return result;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function chainType(value: unknown): value is 'user' | 'assistant' | 'progress' | 'system' | 'attachment' {
  return value === 'user' || value === 'assistant' || value === 'progress'
    || value === 'system' || value === 'attachment';
}

function unavailable(): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'The exact Claude child history is unavailable or changed', false);
}

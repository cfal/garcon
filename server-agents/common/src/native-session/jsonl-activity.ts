import { open } from 'node:fs/promises';
import type {
  AgentNativeActivityProbe,
  AgentNativeActivityResult,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from './path-native-session.js';

const DEFAULT_TAIL_BYTES = 256 * 1024;

export type JsonlActivityTimestamp = string | null | undefined;

export interface JsonlNativeActivityProbeOptions {
  readonly nativeSessions: Pick<PathNativeSessionCodec, 'decode'>;
  readonly activityTimestamp: (entry: unknown) => JsonlActivityTimestamp;
  readonly maxTailBytes?: number;
}

export function createJsonlNativeActivityProbe(
  options: JsonlNativeActivityProbeOptions,
): AgentNativeActivityProbe {
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1) {
    throw new TypeError('Native activity tail size must be a positive integer');
  }
  return {
    async lastActivity(ref, signal) {
      signal.throwIfAborted();
      let path: string | null;
      try {
        path = options.nativeSessions.decode(ref).path;
      } catch {
        return { kind: 'unavailable' };
      }
      if (!path) return { kind: 'unavailable' };
      try {
        return await readJsonlActivity(path, maxTailBytes, options.activityTimestamp, signal);
      } catch (error) {
        signal.throwIfAborted();
        return { kind: 'unavailable' };
      }
    },
  };
}

async function readJsonlActivity(
  path: string,
  maxTailBytes: number,
  activityTimestamp: (entry: unknown) => JsonlActivityTimestamp,
  signal: AbortSignal,
): Promise<AgentNativeActivityResult> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, maxTailBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    if (length > 0) await file.read(buffer, 0, length, start);
    signal.throwIfAborted();
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return { kind: 'unavailable' };
      text = text.slice(firstNewline + 1);
    }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      signal.throwIfAborted();
      const line = lines[index]?.trim();
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const value = activityTimestamp(entry);
      if (value === undefined) continue;
      if (value === null) return { kind: 'unavailable' };
      const timestamp = new Date(value);
      if (Number.isNaN(timestamp.getTime())) return { kind: 'unavailable' };
      return { kind: 'ready', value: { lastEntryAt: timestamp.toISOString() } };
    }
    return start === 0
      ? { kind: 'ready', value: { lastEntryAt: null } }
      : { kind: 'unavailable' };
  } finally {
    await file.close();
  }
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, parseJsonPath, type Json } from './wildcard.js';

export type TraceExclusion = { suite: string; reason: string } & (
  { test: string; path?: string } | { chat: string | null; type: string }
);

export const traceGroup = (chat: string | null, type: string): string => JSON.stringify([chat, type]);

export async function readTraceExclusions(repoRoot: string): Promise<TraceExclusion[]> {
  const entries = JSON.parse(await readFile(join(repoRoot, 'rust/parity/trace-unstable.json'), 'utf8')) as Json;
  if (!Array.isArray(entries)) throw new Error('Trace exclusions must be an array');
  return entries.map((entry, index) => {
    if (isObject(entry) && typeof entry.suite === 'string' && entry.suite && typeof entry.reason === 'string' && entry.reason.trim()) {
      const { suite, reason } = entry;
      if (typeof entry.test === 'string' && entry.test && !Object.hasOwn(entry, 'type') && !Object.hasOwn(entry, 'chat')) {
        if (!Object.hasOwn(entry, 'path')) return { suite, reason, test: entry.test };
        if (typeof entry.path === 'string' && parseJsonPath(entry.path).length > 0) {
          return { suite, reason, test: entry.test, path: entry.path };
        }
      }
      if (!Object.hasOwn(entry, 'test') && !Object.hasOwn(entry, 'path') && typeof entry.type === 'string' && entry.type && (entry.chat === null || typeof entry.chat === 'string')) {
        return { suite, reason, chat: entry.chat, type: entry.type };
      }
    }
    throw new Error(`Invalid trace exclusion at index ${index}`);
  });
}

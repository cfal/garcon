import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntegrationDirectories } from './integration-fixture.js';

const FORWARDER_PATH = fileURLToPath(
  new URL('./live-claude-protocol-forwarder.ts', import.meta.url),
);
const PROTOCOL_PROBE_TIMEOUT_MS = 90_000;

export interface LiveClaudeProtocolProbe {
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  waitForInputStarted(count?: number): Promise<string>;
  waitForTerminalReason(
    reason: 'aborted_streaming' | 'aborted_tools',
    count?: number,
  ): Promise<{ reason: 'aborted_streaming' | 'aborted_tools'; userMessageUuid: string }>;
}

interface LiveClaudeProbeEntry {
  type: 'started' | 'terminal';
  commandUuid?: string;
  reason?: 'aborted_streaming' | 'aborted_tools';
  userMessageUuid?: string;
}

async function readProbeEntries(path: string): Promise<LiveClaudeProbeEntry[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LiveClaudeProbeEntry];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForProbeEntry<T extends LiveClaudeProbeEntry>(
  path: () => string,
  predicate: (entry: LiveClaudeProbeEntry) => entry is T,
  count: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + PROTOCOL_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const matches = (await readProbeEntries(path())).filter(predicate);
    if (matches.length >= count) return matches[count - 1]!;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for live Claude protocol ${label}.`);
}

export function createLiveClaudeProtocolProbe(
  serverEnvironment: Record<string, string>,
): LiveClaudeProtocolProbe {
  const realBinary = serverEnvironment.CLAUDE_BINARY;
  if (!realBinary) throw new Error('Live Claude protocol probe requires the Claude binary.');
  let startedPath = '';
  let terminalReasonPath = '';

  return {
    async prepareWorkspace(directories) {
      const wrapperPath = join(directories.root, 'claude-protocol-probe');
      startedPath = join(directories.root, 'claude-started-inputs');
      terminalReasonPath = join(directories.root, 'claude-terminal-results');
      await writeFile(wrapperPath, `#!/usr/bin/env bash
exec "$GARCON_LIVE_CLAUDE_BUN_BINARY" "$GARCON_LIVE_CLAUDE_FORWARDER" "$@"
`, { mode: 0o700 });
      serverEnvironment.GARCON_LIVE_CLAUDE_BUN_BINARY = process.execPath;
      serverEnvironment.GARCON_LIVE_CLAUDE_FORWARDER = FORWARDER_PATH;
      serverEnvironment.GARCON_LIVE_CLAUDE_REAL_BINARY = realBinary;
      serverEnvironment.GARCON_LIVE_CLAUDE_STARTED_PATH = startedPath;
      serverEnvironment.GARCON_LIVE_CLAUDE_TERMINAL_REASON_PATH = terminalReasonPath;
      serverEnvironment.CLAUDE_BINARY = wrapperPath;
    },
    waitForInputStarted(count = 1) {
      return waitForProbeEntry(
        () => startedPath,
        (entry): entry is LiveClaudeProbeEntry & { commandUuid: string } =>
          entry.type === 'started' && typeof entry.commandUuid === 'string',
        count,
        'input start',
      ).then((entry) => entry.commandUuid);
    },
    waitForTerminalReason(reason, count = 1) {
      return waitForProbeEntry(
        () => terminalReasonPath,
        (
          entry,
        ): entry is LiveClaudeProbeEntry & {
          reason: 'aborted_streaming' | 'aborted_tools';
          userMessageUuid: string;
        } =>
          entry.type === 'terminal'
          && entry.reason === reason
          && typeof entry.userMessageUuid === 'string',
        count,
        reason,
      ).then((entry) => ({
        reason: entry.reason,
        userMessageUuid: entry.userMessageUuid,
      }));
    },
  };
}

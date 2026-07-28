import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntegrationDirectories } from './integration-fixture.js';

const FORWARDER_PATH = fileURLToPath(
  new URL('./live-codex-protocol-forwarder.ts', import.meta.url),
);
const PROTOCOL_PROBE_TIMEOUT_MS = 90_000;

export interface LiveCodexProtocolProbe {
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  readApprovalRequests(): Promise<string[]>;
  waitForApprovalRequest(count?: number): Promise<string>;
}

interface LiveCodexProbeEntry {
  type: 'approval-request';
  method?: string;
}

async function readProbeEntries(path: string): Promise<LiveCodexProbeEntry[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LiveCodexProbeEntry];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function createLiveCodexProtocolProbe(
  serverEnvironment: Record<string, string>,
): LiveCodexProtocolProbe {
  const realBinary = serverEnvironment.GARCON_CODEX_CLI;
  if (!realBinary) throw new Error('Live Codex protocol probe requires the Codex binary.');
  let approvalPath = '';

  async function readApprovalRequests(): Promise<string[]> {
    return (await readProbeEntries(approvalPath)).flatMap((entry) =>
      entry.type === 'approval-request' && typeof entry.method === 'string'
        ? [entry.method]
        : []);
  }

  return {
    async prepareWorkspace(directories) {
      const wrapperPath = join(directories.root, 'codex-protocol-probe');
      approvalPath = join(directories.root, 'codex-approval-requests');
      await writeFile(wrapperPath, `#!/usr/bin/env bash
exec "$GARCON_LIVE_CODEX_BUN_BINARY" "$GARCON_LIVE_CODEX_FORWARDER" "$@"
`, { mode: 0o700 });
      serverEnvironment.GARCON_LIVE_CODEX_BUN_BINARY = process.execPath;
      serverEnvironment.GARCON_LIVE_CODEX_FORWARDER = FORWARDER_PATH;
      serverEnvironment.GARCON_LIVE_CODEX_REAL_BINARY = realBinary;
      serverEnvironment.GARCON_LIVE_CODEX_APPROVAL_PATH = approvalPath;
      serverEnvironment.GARCON_CODEX_CLI = wrapperPath;
    },
    readApprovalRequests,
    async waitForApprovalRequest(count = 1) {
      const deadline = Date.now() + PROTOCOL_PROBE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const requests = await readApprovalRequests();
        if (requests.length >= count) return requests[count - 1]!;
        await Bun.sleep(25);
      }
      throw new Error('Timed out waiting for a live Codex approval request.');
    },
  };
}

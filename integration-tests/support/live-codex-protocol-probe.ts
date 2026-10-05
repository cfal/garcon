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
  readApprovalRequestDetails(): Promise<LiveCodexApprovalRequest[]>;
  readCommandItemIds(): Promise<string[]>;
  waitForApprovalRequest(count?: number): Promise<string>;
}

export interface LiveCodexApprovalRequest {
  readonly method: string;
  readonly approvalId: string | null;
  readonly itemId: string | null;
  readonly kind: string | null;
}

interface LiveCodexProbeEntry {
  type: 'approval-request' | 'command-item';
  method?: string;
  approvalId?: string | null;
  itemId?: string | null;
  kind?: string | null;
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
    return (await readApprovalRequestDetails()).map((entry) => entry.method);
  }

  async function readApprovalRequestDetails(): Promise<LiveCodexApprovalRequest[]> {
    return (await readProbeEntries(approvalPath)).flatMap((entry) => {
      if (entry.type !== 'approval-request' || typeof entry.method !== 'string') return [];
      return [{
        method: entry.method,
        approvalId: typeof entry.approvalId === 'string' ? entry.approvalId : null,
        itemId: typeof entry.itemId === 'string' ? entry.itemId : null,
        kind: typeof entry.kind === 'string' ? entry.kind : null,
      }];
    });
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
    readApprovalRequestDetails,
    async readCommandItemIds() {
      return (await readProbeEntries(approvalPath)).flatMap((entry) => (
        entry.type === 'command-item' && typeof entry.itemId === 'string'
          ? [entry.itemId]
          : []
      ));
    },
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

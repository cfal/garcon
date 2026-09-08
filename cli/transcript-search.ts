import type { TranscriptSearchStatusResponse } from '@garcon/common/chat-search';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { TranscriptSearchCliCommand } from './args.js';
import type { CliOutput } from './output.js';

export interface TranscriptSearchAdministrationClient {
  getTranscriptSearchStatus(signal?: AbortSignal): Promise<TranscriptSearchStatusResponse>;
  setTranscriptSearchEnabled(
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<RemoteSettingsSnapshot>;
}

export async function runTranscriptSearchAdministration(
  command: TranscriptSearchCliCommand,
  client: TranscriptSearchAdministrationClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  if (command.action === 'status') {
    const status = await client.getTranscriptSearchStatus(signal);
    output.result(command.json ? JSON.stringify(status, null, 2) : formatTranscriptSearchStatus(status));
    return;
  }

  const enabled = command.action === 'enable';
  const settings = await client.setTranscriptSearchEnabled(enabled, signal);
  const result = {
    enabled: settings.features.transcriptSearch.enabled,
    settingsVersion: settings.version,
  };
  output.result(command.json
    ? JSON.stringify(result, null, 2)
    : [
      `transcript search: ${result.enabled ? 'enabled' : 'disabled'}`,
      `settings version: ${result.settingsVersion}`,
    ].join('\n'));
}

export function formatTranscriptSearchStatus(status: TranscriptSearchStatusResponse): string {
  const lines = [
    `transcript search: ${status.phase}`,
    `updated at: ${status.updatedAt}`,
    `chats total: ${status.chats.total}`,
    `chats indexed: ${status.chats.indexed}`,
    `chats pending: ${status.chats.pending}`,
    `chats failed: ${status.chats.failed}`,
    `chats unindexed: ${status.chats.unindexed}`,
    `queued jobs: ${status.queuedJobs}`,
    `backlog rows: ${status.backlogRows}`,
    `resync: ${formatProgress(status.resync)}`,
    `active chat: ${formatProgress(status.activeChat)}`,
    `last error: ${status.lastErrorCode ?? 'none'}`,
    `queries served: ${status.queryStats.served}`,
    `queries timed out: ${status.queryStats.timedOut}`,
    `queries rejected busy: ${status.queryStats.rejectedBusy}`,
    `execution latency ms: ${formatLatency(
      status.queryStats.p50Ms,
      status.queryStats.p95Ms,
      status.queryStats.maxMs,
    )}`,
    `admission latency ms: ${formatLatency(
      status.queryStats.admissionP50Ms,
      status.queryStats.admissionP95Ms,
      status.queryStats.admissionMaxMs,
    )}`,
    `total latency ms: ${formatLatency(
      status.queryStats.totalP50Ms,
      status.queryStats.totalP95Ms,
      status.queryStats.totalMaxMs,
    )}`,
  ];
  return lines.join('\n');
}

function formatProgress(
  progress: { readonly completedChats: number; readonly totalChats: number }
    | { readonly position: number; readonly total: number }
    | null,
): string {
  if (!progress) return 'none';
  if ('completedChats' in progress) return `${progress.completedChats}/${progress.totalChats}`;
  return `${progress.position}/${progress.total}`;
}

function formatLatency(p50Ms: number, p95Ms: number, maxMs: number): string {
  return `p50 ${p50Ms}, p95 ${p95Ms}, max ${maxMs}`;
}

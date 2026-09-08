import { describe, expect, test } from 'bun:test';
import type { TranscriptSearchStatusResponse } from '@garcon/common/chat-search';
import {
  DEFAULT_REMOTE_FEATURE_SETTINGS,
  type RemoteSettingsSnapshot,
} from '@garcon/common/settings';
import type { TranscriptSearchCliCommand } from '../args.js';
import type { CliOutput } from '../output.js';
import {
  formatTranscriptSearchStatus,
  runTranscriptSearchAdministration,
  type TranscriptSearchAdministrationClient,
} from '../transcript-search.js';

const status = {
  version: 1,
  phase: 'rebuilding',
  chats: { total: 5, indexed: 2, pending: 1, failed: 1, unindexed: 1 },
  queuedJobs: 2,
  resync: { completedChats: 3, totalChats: 5 },
  backlogRows: 7,
  activeChat: { position: 4, total: 8 },
  lastErrorCode: 'SEARCH_READER_RESTARTED',
  updatedAt: '2026-09-08T00:00:00.000Z',
  queryStats: {
    served: 20,
    timedOut: 2,
    rejectedBusy: 1,
    p50Ms: 12,
    p95Ms: 40,
    maxMs: 80,
    admissionP50Ms: 1,
    admissionP95Ms: 3,
    admissionMaxMs: 5,
    totalP50Ms: 13,
    totalP95Ms: 43,
    totalMaxMs: 85,
  },
} satisfies TranscriptSearchStatusResponse;

function settings(enabled: boolean): RemoteSettingsSnapshot {
  return {
    version: 4,
    features: {
      ...DEFAULT_REMOTE_FEATURE_SETTINGS,
      transcriptSearch: { enabled },
    },
    ui: {},
    uiEffective: {},
    paths: { pinnedProjectPaths: [], browseStartPath: '', recentProjectPaths: [] },
    pinnedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: { permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {} },
      byAgent: {},
    },
    projectBasePath: '/project',
    telegram: {
      botTokenAvailable: false,
      botUsername: null,
      botFirstName: null,
      recipientUsername: null,
      recipientDisplayName: null,
      recipientLinked: false,
      pendingLink: false,
      linkUrl: null,
    },
  };
}

function command(
  action: TranscriptSearchCliCommand['action'],
  json = false,
): TranscriptSearchCliCommand {
  return {
    kind: 'transcript-search',
    workspace: 'default',
    configDir: '/config',
    action,
    json,
  };
}

function captureOutput(): CliOutput & { readonly results: string[] } {
  const results: string[] = [];
  return {
    results,
    accepted() {},
    completed() {},
    diagnostic() {},
    result(value) { results.push(value); },
    sent() {},
    stopped() {},
  };
}

describe('transcript search administration', () => {
  test('formats complete operational status', () => {
    expect(formatTranscriptSearchStatus(status)).toBe([
      'transcript search: rebuilding',
      'updated at: 2026-09-08T00:00:00.000Z',
      'chats total: 5',
      'chats indexed: 2',
      'chats pending: 1',
      'chats failed: 1',
      'chats unindexed: 1',
      'queued jobs: 2',
      'backlog rows: 7',
      'resync: 3/5',
      'active chat: 4/8',
      'last error: SEARCH_READER_RESTARTED',
      'queries served: 20',
      'queries timed out: 2',
      'queries rejected busy: 1',
      'execution latency ms: p50 12, p95 40, max 80',
      'admission latency ms: p50 1, p95 3, max 5',
      'total latency ms: p50 13, p95 43, max 85',
    ].join('\n'));
  });

  test('emits the validated status as one JSON document', async () => {
    const output = captureOutput();
    const client = {
      async getTranscriptSearchStatus() { return status; },
      async rebuildTranscriptSearch() { throw new Error('must not rebuild'); },
      async setTranscriptSearchEnabled() { throw new Error('must not update settings'); },
    } satisfies TranscriptSearchAdministrationClient;

    await runTranscriptSearchAdministration(command('status', true), client, output);

    expect(output.results).toEqual([JSON.stringify(status, null, 2)]);
  });

  test('sets explicit desired state and reports the authoritative settings version', async () => {
    const enabledValues: boolean[] = [];
    const client = {
      async getTranscriptSearchStatus() { throw new Error('must not fetch status'); },
      async rebuildTranscriptSearch() { throw new Error('must not rebuild'); },
      async setTranscriptSearchEnabled(enabled: boolean) {
        enabledValues.push(enabled);
        return settings(enabled);
      },
    } satisfies TranscriptSearchAdministrationClient;
    const output = captureOutput();

    await runTranscriptSearchAdministration(command('enable'), client, output);
    await runTranscriptSearchAdministration(command('disable', true), client, output);

    expect(enabledValues).toEqual([true, false]);
    expect(output.results).toEqual([
      'transcript search: enabled\nsettings version: 4',
      JSON.stringify({ enabled: false, settingsVersion: 4 }, null, 2),
    ]);
  });

  test('starts a rebuild and reports its immediate authoritative status', async () => {
    const output = captureOutput();
    const client = {
      async getTranscriptSearchStatus() { throw new Error('must not fetch status'); },
      async rebuildTranscriptSearch() { return { success: true as const, status }; },
      async setTranscriptSearchEnabled() { throw new Error('must not update settings'); },
    } satisfies TranscriptSearchAdministrationClient;

    await runTranscriptSearchAdministration(command('rebuild', true), client, output);

    expect(output.results).toEqual([
      JSON.stringify({ success: true, status }, null, 2),
    ]);
  });
});

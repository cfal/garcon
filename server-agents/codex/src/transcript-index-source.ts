import { stat } from 'node:fs/promises';
import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  type AgentTranscriptIndexSource,
  type AgentTranscriptIndexerHost,
  type AgentTranscriptIndexerModule,
  type AgentTranscriptIndexSourceRef,
} from '@garcon/server-agent-interface';
import {
  createCompleteJsonlSnapshot,
  sourceFailure,
  yieldBoundedMessageBatches,
} from '@garcon/server-agent-common/search/index-source-helpers';
import { loadCodexChatMessages } from './agents/codex/history-loader.js';
import {
  assertCodexPaginatedHistoryMaterializable,
} from './agents/codex/history-source.js';
import {
  inspectCodexHistoryProfile,
  type CodexHistoryProfile,
} from './agents/codex/history-profile.js';
import {
  PaginatedCodexHistorySource,
  type CodexPaginatedHistoryClient,
} from './agents/codex/app-server/paginated-history-source.js';
import { CodexAppServerClient } from './agents/codex/app-server/client.js';

interface CodexIndexDescriptor {
  readonly nativePath: string;
  readonly threadId: string;
  readonly historyMode: CodexHistoryProfile['mode'];
  readonly codexHome: string;
}

interface CodexIndexSourceOptions {
  readonly createClient?: (codexHome: string) => CodexPaginatedHistoryClient;
}

class CodexIndexClientPool {
  readonly #clients = new Map<string, CodexPaginatedHistoryClient>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly createClient: (codexHome: string) => CodexPaginatedHistoryClient,
  ) {}

  run<T>(
    codexHome: string,
    operation: (client: CodexPaginatedHistoryClient) => Promise<T>,
  ): Promise<T> {
    const scheduled = (this.#queues.get(codexHome) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => operation(this.#client(codexHome)));
    this.#queues.set(codexHome, scheduled);
    void scheduled.finally(() => {
      if (this.#queues.get(codexHome) === scheduled) this.#queues.delete(codexHome);
    }).catch(() => undefined);
    return scheduled;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#queues.values());
    for (const client of this.#clients.values()) client.shutdown();
    this.#clients.clear();
    this.#queues.clear();
  }

  #client(codexHome: string): CodexPaginatedHistoryClient {
    let client = this.#clients.get(codexHome);
    if (!client) {
      client = this.createClient(codexHome);
      this.#clients.set(codexHome, client);
    }
    return client;
  }
}

export function createCodexTranscriptIndexSource(
  host: AgentTranscriptIndexerHost,
  options: CodexIndexSourceOptions = {},
): AgentTranscriptIndexSource {
  const clients = new CodexIndexClientPool(options.createClient ?? ((codexHome) => (
    new CodexAppServerClient({ env: { CODEX_HOME: codexHome } })
  )));

  const probe = async (
    source: AgentTranscriptIndexSourceRef,
    signal: AbortSignal,
  ): Promise<{ readonly revision: string }> => {
    signal.throwIfAborted();
    const descriptor = parseCodexIndexDescriptor(source, host.agentId);
    const profile = await inspectProfile(descriptor, signal);
    const file = await fileRevision(descriptor.nativePath, signal);
    if (profile.mode === 'legacy') return { revision: file };
    assertIndexHistoryMaterializable(profile);
    let turnRevision: string;
    try {
      turnRevision = await clients.run(descriptor.codexHome, async (client) => {
        signal.throwIfAborted();
        const response = await client.listThreadTurns({
          threadId: descriptor.threadId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'full',
        });
        signal.throwIfAborted();
        const newest = response.data[0];
        return newest
          ? `${newest.id}:${newest.startedAt ?? ''}:${newest.completedAt ?? ''}:${newest.items.length}`
          : 'empty';
      });
    } catch {
      signal.throwIfAborted();
      throw sourceFailure('SOURCE_READ_FAILED', true);
    }
    return { revision: `codex-paginated-v1:${file}:${turnRevision}` };
  };

  return {
    probe,
    async *load(request) {
      request.signal.throwIfAborted();
      const descriptor = parseCodexIndexDescriptor(request.source, host.agentId);
      const profile = await inspectProfile(descriptor, request.signal);
      let messages: readonly ChatMessage[];
      if (profile.mode === 'legacy') {
        const snapshot = await createCompleteJsonlSnapshot({
          nativePath: descriptor.nativePath,
          scratchDirectory: request.scratchDirectory,
          maxRecordBytes: request.limits.maxRecordBytes,
          signal: request.signal,
        });
        try {
          try {
            messages = await loadCodexChatMessages(snapshot.path, undefined, {
              throwOnError: true,
              signal: request.signal,
            });
          } catch {
            request.signal.throwIfAborted();
            throw sourceFailure('SOURCE_RECORD_INVALID', false);
          }
        } finally {
          await snapshot.remove();
        }
      } else {
        assertIndexHistoryMaterializable(profile);
        const before = await probe(request.source, request.signal);
        try {
          messages = await clients.run(descriptor.codexHome, (client) => (
            new PaginatedCodexHistorySource(profile, () => ({
              listThreadTurns: client.listThreadTurns.bind(client),
              shutdown() {},
            })).load(request.signal)
          ));
        } catch {
          request.signal.throwIfAborted();
          throw sourceFailure('SOURCE_READ_FAILED', true);
        }
        const after = await probe(request.source, request.signal);
        if (before.revision !== after.revision) {
          throw sourceFailure('SOURCE_CHANGED', true);
        }
      }
      yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
    },
    close: () => clients.close(),
  };
}

function parseCodexIndexDescriptor(
  source: AgentTranscriptIndexSourceRef,
  ownerId: string,
): CodexIndexDescriptor {
  if (source.ownerId !== ownerId || source.schemaVersion !== 2) {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false, true);
  }
  const { nativePath, threadId, historyMode, codexHome } = source.value;
  if (
    typeof nativePath !== 'string' || !nativePath
    || typeof threadId !== 'string' || !threadId
    || (historyMode !== 'legacy' && historyMode !== 'paginated')
    || typeof codexHome !== 'string' || !codexHome
  ) {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false, true);
  }
  return { nativePath, threadId, historyMode, codexHome };
}

async function inspectProfile(
  descriptor: CodexIndexDescriptor,
  signal: AbortSignal,
): Promise<CodexHistoryProfile> {
  let profile: CodexHistoryProfile;
  try {
    profile = await inspectCodexHistoryProfile({
      nativePath: descriptor.nativePath,
      expectedThreadId: descriptor.threadId,
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AgentIntegrationError && error.code === 'OPERATION_UNSUPPORTED') {
      throw sourceFailure('SOURCE_UNSUPPORTED', false, true);
    }
    throw sourceFailure('SOURCE_READ_FAILED', true, true);
  }
  if (profile.mode !== descriptor.historyMode) {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false, true);
  }
  return profile;
}

function assertIndexHistoryMaterializable(
  profile: Extract<CodexHistoryProfile, { mode: 'paginated' }>,
): void {
  try {
    assertCodexPaginatedHistoryMaterializable(profile, 'index-history');
  } catch {
    throw sourceFailure('SOURCE_UNSUPPORTED', false, true);
  }
}

async function fileRevision(nativePath: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  try {
    const value = await stat(nativePath, { bigint: true });
    signal.throwIfAborted();
    return `file-v1:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    throw sourceFailure(code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_STAT_FAILED', true);
  }
}

const moduleDefinition: AgentTranscriptIndexerModule = {
  integrationId: 'codex',
  apiVersion: 1,
  create: (host) => createCodexTranscriptIndexSource(host),
};

export default moduleDefinition;

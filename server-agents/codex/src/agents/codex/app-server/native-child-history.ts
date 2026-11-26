import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '@garcon/common/json';
import {
  AgentIntegrationError, type AgentNativeChildRef, type AgentNativeChildHistoryRequest,
  type AgentImportedTranscriptRow,
} from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { runtimeRows } from '@garcon/server-agent-common/execution/runtime-events';
import { inspectCodexHistoryProfile } from '../history-profile.js';
import { loadCodexChatMessages } from '../history-loader.js';
import { CodexAppServerClient } from './client.js';
import { PaginatedCodexHistorySource } from './paginated-history-source.js';
import { loadPaginatedUserMessageEvidence } from './paginated-user-message-evidence.js';
import type { CodexThreadMetadata } from './protocol.js';

export interface CodexChildLocator {
  readonly codexHome: string;
  readonly rootThreadId: string;
  readonly childThreadId: string;
  readonly parentThreadId: string;
}

export type CodexChildHistoryClient = Pick<CodexAppServerClient,
  'connect' | 'readThreadMetadata' | 'listThreadTurns' | 'listThreadItems' | 'shutdown'>;

export function codexChildRef(locator: CodexChildLocator): AgentNativeChildRef {
  return { ownerId: 'codex', schemaVersion: 1,
    key: JSON.stringify([locator.codexHome, locator.rootThreadId, locator.childThreadId]), value: { ...locator } };
}

export function parseCodexChildRef(ref: AgentNativeChildRef): CodexChildLocator {
  const { codexHome, rootThreadId, childThreadId, parentThreadId } = ref.value;
  if (ref.ownerId !== 'codex' || ref.schemaVersion !== 1 || typeof codexHome !== 'string'
    || !path.isAbsolute(codexHome) || !validId(rootThreadId) || !validId(childThreadId)
    || !validId(parentThreadId) || childThreadId === rootThreadId || childThreadId === parentThreadId) throw unavailable();
  const locator = { codexHome, rootThreadId, childThreadId, parentThreadId };
  if (codexChildRef(locator).key !== ref.key) throw unavailable();
  return locator;
}

export async function* loadCodexChildHistory(
  request: AgentNativeChildHistoryRequest,
  assertSourceUnchanged: () => void,
  createClient: (home: string) => CodexChildHistoryClient = home => new CodexAppServerClient({ env: { CODEX_HOME: home } }),
  rpcTimeoutMs = 20_000,
): AsyncGenerator<readonly AgentImportedTranscriptRow[]> {
  const locator = parseCodexChildRef(request.child);
  const assertCurrent = () => { request.signal.throwIfAborted(); assertSourceUnchanged(); };
  assertCurrent();
  const client = cancellableHistoryClient(createClient(locator.codexHome), request.signal, rpcTimeoutMs);
  try {
    const initialized = await client.connect();
    assertCurrent();
    if (initialized.codexHome !== locator.codexHome) throw unavailable();
    const metadata = await verifyAncestry(client, locator, assertCurrent);
    if (!metadata.path) throw unavailable();
    const initial = await stat(metadata.path, { bigint: true });
    await assertTerminatedRollout(metadata.path, initial.size);
    const profile = await inspectCodexHistoryProfile({
      nativePath: metadata.path, expectedThreadId: locator.childThreadId, signal: request.signal,
    });
    if (profile.mode !== metadata.historyMode) throw unavailable();
    assertCurrent();
    const steps = new EventLoopSteps('codex-child-history');
    if (profile.mode === 'legacy') {
      for await (const entry of readJsonlLineEntries(profile.nativePath, { signal: request.signal, maxLineBytes: 16 * 1024 * 1024 })) {
        assertCurrent();
        parseRetainedRecord(entry.line);
        if (steps.due) await steps.next();
      }
    }
    const projectedItems = new Set<string>();
    const messages = profile.mode === 'legacy'
      ? await loadCodexChatMessages(profile.nativePath, undefined, { throwOnError: true, signal: request.signal })
      : await new PaginatedCodexHistorySource(profile, () => ({
        listThreadTurns: params => client.listThreadTurns(params),
        listThreadItems: async params => {
          const page = await client.listThreadItems(params);
          for (const { turnId, item } of page.data) projectedItems.add(JSON.stringify([turnId, item.id]));
          return page;
        },
        // The validated client stays alive through the final identity check.
        shutdown() {},
      }), async (nativePath, timestamp, signal, survivingTurns) => {
        const evidence = childEvidenceParser(survivingTurns, projectedItems);
        const rows = await loadPaginatedUserMessageEvidence(nativePath, timestamp, signal, survivingTurns, evidence.parse);
        evidence.assertComplete();
        return rows;
      }).load(request.signal);
    for (let start = 0; start < messages.length; start += 256) {
      assertCurrent();
      yield runtimeRows(messages.slice(start, start + 256));
      if (steps.due) await steps.next();
    }
    const final = await stat(metadata.path, { bigint: true });
    if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size
      || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) throw unavailable();
    const current = await verifyAncestry(client, locator, assertCurrent);
    if (current.path !== metadata.path || current.historyMode !== metadata.historyMode
      || current.updatedAt !== metadata.updatedAt) throw unavailable();
    assertCurrent();
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof AgentIntegrationError) throw error;
    throw unavailable();
  } finally { await client.shutdown(); }
  assertCurrent();
}

async function assertTerminatedRollout(nativePath: string, size: bigint): Promise<void> {
  if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw unavailable();
  const handle = await open(nativePath, 'r');
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, Number(size) - 1);
    if (bytesRead !== 1 || byte[0] !== 0x0a) throw unavailable();
  } finally { await handle.close(); }
}

function childEvidenceParser(survivingTurns: ReadonlySet<string>, projectedItems: ReadonlySet<string>) {
  let inheritedBeforeOrdinal = 0;
  let lastOrdinal = 0;
  let sawMetadata = false;
  const parse = (line: string): unknown => {
    const record = parseRetainedRecord(line);
    const payload = record.payload;
    if (record.type === 'session_meta' && !sawMetadata) {
      if (!isRecord(payload)) throw unavailable();
      sawMetadata = true;
      const boundary = payload.subagent_history_start_ordinal;
      if (boundary !== undefined && boundary !== null) {
        if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary) || boundary < 0) throw unavailable();
        inheritedBeforeOrdinal = boundary;
      }
      return record;
    }
    // Native projection excludes the explicitly inherited prefix, not arbitrary missing turns.
    // https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/thread-store/src/local/thread_history_materialization.rs#L314-L320
    if (inheritedBeforeOrdinal > 0) {
      if (typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0) throw unavailable();
      lastOrdinal = record.ordinal;
      if (record.ordinal < inheritedBeforeOrdinal) return null;
    }
    if (record.type === 'event_msg' && isRecord(payload) && payload.type === 'item_completed'
      && isRecord(payload.item) && !omittedEmptyItem(payload.item)) {
      const turnId = payload.turn_id ?? payload.turnId;
      if (typeof turnId !== 'string' || !survivingTurns.has(turnId)) throw unavailable();
      if (payload.item.type !== 'UserMessage' && payload.item.type !== 'userMessage'
        && !projectedItems.has(JSON.stringify([turnId, payload.item.id]))) throw unavailable();
    }
    return record;
  };
  return {
    parse,
    assertComplete() {
      // Native resume also refuses a prefix whose copy ended before the declared boundary.
      // https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/rollout/src/ordinal.rs#L86-L95
      if (lastOrdinal < inheritedBeforeOrdinal - 1) throw unavailable();
    },
  };
}

function parseRetainedRecord(line: string): Record<string, unknown> {
  const record: unknown = JSON.parse(line);
  if (!isRecord(record)) throw unavailable();
  const payload = record.payload;
  if (record.type === 'event_msg' || record.type === 'response_item') {
    if (!isRecord(payload) || typeof payload.type !== 'string') throw unavailable();
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message' || payload.type === 'agent_message') {
        if (typeof payload.message !== 'string') throw unavailable();
      } else if (payload.type === 'agent_reasoning' && typeof (payload.message ?? payload.text) !== 'string') throw unavailable();
    } else {
      if (payload.type === 'message') {
        if (payload.role !== 'user' && payload.role !== 'assistant' && payload.role !== 'developer') throw unavailable();
        validateResponseParts(payload.content, ['input_text', 'output_text', 'input_image', 'input_audio']);
      }
      if (payload.type === 'agent_message') validateResponseParts(payload.content, ['input_text', 'encrypted_content']);
      if (payload.type === 'reasoning') {
        validateResponseParts(payload.summary, ['summary_text']);
        if (payload.content !== undefined && payload.content !== null) validateResponseParts(payload.content, ['reasoning_text', 'text']);
      }
      if (payload.type === 'function_call' && (typeof payload.name !== 'string' || typeof payload.arguments !== 'string'
        || !retainedIdentity(payload.call_id))) throw unavailable();
      if (payload.type === 'custom_tool_call' && (typeof payload.name !== 'string' || typeof payload.input !== 'string'
        || !retainedIdentity(payload.call_id))) throw unavailable();
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const requiresIdentity = payload.type === 'custom_tool_call_output' || payload.call_id != null;
        if ((requiresIdentity && !retainedIdentity(payload.call_id))
          || (typeof payload.output !== 'string' && !Array.isArray(payload.output))) throw unavailable();
        if (Array.isArray(payload.output)) validateResponseParts(payload.output, ['input_text', 'input_image', 'input_audio', 'encrypted_content']);
      }
    }
  }
  if (record.type === 'event_msg' && isRecord(payload) && payload.type === 'item_completed') {
    const item = payload.item;
    if (!retainedIdentity(payload.turn_id ?? payload.turnId) || !isRecord(item) || !retainedIdentity(item.id)) throw unavailable();
    if (item.type === 'UserMessage' || item.type === 'userMessage') {
      const clientId = item.client_id ?? item.clientId;
      if ((clientId !== undefined && clientId !== null && !retainedIdentity(clientId)) || !Array.isArray(item.content)) throw unavailable();
      for (const input of item.content) {
        if (!isRecord(input)) throw unavailable();
        switch (input.type) {
          case 'text':
            if (typeof input.text !== 'string'
              || (input.text_elements !== undefined && !Array.isArray(input.text_elements))) throw unavailable();
            break;
          case 'image': if (typeof (input.image_url ?? input.file_id ?? input.url) !== 'string') throw unavailable(); break;
          case 'local_image': case 'localImage': if (typeof input.path !== 'string') throw unavailable(); break;
          case 'audio': if (typeof (input.audio_url ?? input.file_id) !== 'string') throw unavailable(); break;
          case 'local_audio': if (typeof input.path !== 'string') throw unavailable(); break;
          case 'skill': case 'mention':
            if (typeof input.path !== 'string' || typeof input.name !== 'string') throw unavailable();
            break;
          default: throw unavailable();
        }
      }
    }
    if (item.type === 'AgentMessage' && (!Array.isArray(item.content)
      || !item.content.every(part => isRecord(part) && part.type === 'Text' && typeof part.text === 'string'))) throw unavailable();
    if ((item.type === 'agentMessage' || item.type === 'Plan' || item.type === 'plan') && typeof item.text !== 'string') throw unavailable();
    if (item.type === 'Reasoning' && (!stringArray(item.summary_text)
      || (item.raw_content !== undefined && !stringArray(item.raw_content)))) throw unavailable();
  }
  return record;
}

function validateResponseParts(value: unknown, types: readonly string[]): void {
  if (!Array.isArray(value)) throw unavailable();
  for (const part of value) {
    if (!isRecord(part) || typeof part.type !== 'string' || !types.includes(part.type)) throw unavailable();
    switch (part.type) {
      case 'input_image': if (typeof (part.image_url ?? part.file_id) !== 'string') throw unavailable(); break;
      case 'input_audio': if (typeof (part.audio_url ?? part.file_id) !== 'string') throw unavailable(); break;
      case 'encrypted_content': if (typeof part.encrypted_content !== 'string') throw unavailable(); break;
      default: if (typeof part.text !== 'string') throw unavailable();
    }
  }
}

function omittedEmptyItem(item: Record<string, unknown>): boolean {
  // Empty assistant and plan items carry no conversation if omitted by a native projection.
  // https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L743-L795
  if (item.type === 'AgentMessage' && Array.isArray(item.content)) return item.content.every(part => isRecord(part) && part.text === '');
  return (item.type === 'Plan' || item.type === 'plan' || item.type === 'agentMessage') && item.text === '';
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(part => typeof part === 'string');
}

function retainedIdentity(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function cancellableHistoryClient(
  client: CodexChildHistoryClient,
  signal: AbortSignal,
  timeoutMs: number,
): CodexChildHistoryClient {
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const interrupted = Promise.withResolvers<never>();
    const abort = () => interrupted.reject(signal.reason);
    const timer = setTimeout(() => interrupted.reject(unavailable()), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await Promise.race([operation(), interrupted.promise]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  return {
    connect: () => read(() => client.connect()),
    readThreadMetadata: id => read(() => client.readThreadMetadata(id)),
    listThreadTurns: params => read(() => client.listThreadTurns(params)),
    listThreadItems: params => read(() => client.listThreadItems(params)),
    shutdown: () => client.shutdown(),
  };
}

async function verifyAncestry(
  client: CodexChildHistoryClient,
  locator: CodexChildLocator,
  assertCurrent: () => void,
): Promise<CodexThreadMetadata> {
  let id = locator.childThreadId;
  let child: CodexThreadMetadata | null = null;
  const seen = new Set<string>();
  while (seen.size < 64 && !seen.has(id)) {
    seen.add(id);
    const metadata = await client.readThreadMetadata(id);
    assertCurrent();
    if (metadata.id !== id || metadata.ephemeral || (metadata.sessionId !== id
      && metadata.sessionId !== locator.rootThreadId)) throw unavailable();
    if (metadata.status === 'active') throw new AgentIntegrationError('SESSION_BUSY', 'The native Codex source is running', true);
    if (metadata.status === 'systemError') throw unavailable();
    if (!child) {
      child = metadata;
      if (metadata.parentThreadId !== locator.parentThreadId) throw unavailable();
    }
    if (id === locator.rootThreadId) return child;
    if (!metadata.parentThreadId) throw unavailable();
    id = metadata.parentThreadId;
  }
  throw unavailable();
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}

function unavailable(): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'The exact Codex child history is unavailable or changed', false);
}

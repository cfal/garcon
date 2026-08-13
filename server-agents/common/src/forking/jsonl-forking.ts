import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import { retargetNativeSeedReceiptIfPreserved } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  getNativeMessageRevisionSource,
  type AgentNativeFork,
  type AgentNativeForkOutcome,
  type AgentNativeForkRequest,
  type AgentStartedSession,
  type NativeMessageSource,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../transcript-projection/evidence-source.js';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import {
  forkJsonlTranscript,
  JsonlSourcePrefixChangedError,
  type ForkJsonlRequest,
  type ForkTranscriptEntryContext,
} from './fork-jsonl.js';

export interface JsonlNativeForkingOptions {
  readonly nativeEvidence: Pick<AgentNativeEvidenceSource, 'load' | 'resolveNativeSession'>;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly createRewriteEntry?: () => (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly forkWholeSession?: (
    request: AgentNativeForkRequest,
  ) => Promise<AgentStartedSession | null>;
  readonly transformEntries?: ForkJsonlRequest['transformEntries'];
  readonly createTargetPath?: ForkJsonlRequest['createTargetPath'];
  readonly allowUnmaterializedWholeSession?: boolean;
  readonly semanticDigest?: (messages: readonly ChatMessage[]) => string;
}

export function createJsonlNativeForking(options: JsonlNativeForkingOptions): AgentNativeFork {
  return {
    async fork(request) {
      request.admission.signal.throwIfAborted();
      if (!request.providerMeta && options.forkWholeSession) {
        const result = await options.forkWholeSession(request);
        if (result) return { kind: 'materialized', session: result };
      }
      return forkJsonlAtProviderPoint(options, request);
    },
    async discard(session, signal) {
      signal.throwIfAborted();
      const native = options.nativeSessions.decode(session.nativeSession);
      if (!native.path) return;
      await fs.rm(native.path, { force: true });
    },
  };
}

async function forkJsonlAtProviderPoint(
  options: JsonlNativeForkingOptions,
  request: AgentNativeForkRequest,
): Promise<AgentNativeForkOutcome> {
  const resolvedReference = await resolveSourceReference(options, request);
  const sourceNative = options.nativeSessions.decode(resolvedReference);
  const sourceAgentSessionId = request.source.agentSessionId ?? sourceNative.agentSessionId;
  const sourcePath = sourceNative.path;
  if (!sourceAgentSessionId || !sourcePath) {
    if (!request.providerMeta && options.allowUnmaterializedWholeSession && !sourceAgentSessionId) {
      return { kind: 'unmaterialized' };
    }
    throw transcriptUnavailable('Source native transcript is unavailable');
  }

  const point = request.providerMeta
    ? await resolveProviderPoint(options, request)
    : null;
  const result = await forkJsonlTranscript({
    sourcePath,
    sourceAgentSessionId,
    cutoffLine: point?.lineNumber ?? null,
    allowUnmaterializedWholeSession:
      !request.providerMeta && options.allowUnmaterializedWholeSession === true,
    ...(point
      ? { retainedMessageCounts: new Map([[point.lineNumber, point.retainedMessageCount]]) }
      : {}),
    rewriteEntry: options.createRewriteEntry?.() ?? options.rewriteEntry,
    transformEntries: options.transformEntries,
    createTargetPath: options.createTargetPath,
  }).catch((error) => {
    if (error instanceof JsonlSourcePrefixChangedError) throw sourceRevisionChanged();
    throw error;
  });
  if (result.kind === 'unmaterialized') {
    if (request.providerMeta) throw new Error('A message-point fork cannot remain unmaterialized');
    return result;
  }

  try {
    const nativeSession = options.nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? sourceNative.modelEndpointId,
    });
    let forkedMessages: readonly ChatMessage[] | null = null;
    if (result.expectedSemanticDigest !== undefined || request.source.nativeSeedReceipt) {
      const forked = await options.nativeEvidence.load({
        chat: {
          chatId: request.chatId,
          agentId: request.source.agentId,
          agentSessionId: result.agentSessionId,
          projectPath: request.projectPath,
          model: request.model,
          nativeSession,
          carryOverRevision: '',
          nativeSeedReceipt: null,
          settings: request.settings,
        },
        signal: request.admission.signal,
      });
      forkedMessages = forked.messages;
      if (
        result.expectedSemanticDigest !== undefined
        && options.semanticDigest?.(forked.messages) !== result.expectedSemanticDigest
      ) {
        throw transcriptUnavailable('The provider-native fork did not preserve its selected prefix');
      }
    }
    return {
      kind: 'materialized',
      session: {
        agentSessionId: result.agentSessionId,
        nativeSession,
        nativeSeedReceipt: retargetNativeSeedReceiptIfPreserved(
          request.source.nativeSeedReceipt,
          result.agentSessionId,
          forkedMessages ?? [],
        ),
      },
    };
  } catch (error) {
    if (request.providerMeta || options.transformEntries) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function resolveProviderPoint(
  options: JsonlNativeForkingOptions,
  request: AgentNativeForkRequest,
): Promise<{ readonly lineNumber: number; readonly retainedMessageCount: number }> {
  const expected = request.providerMeta;
  if (!expected) throw missingNativePoint();
  const native = await options.nativeEvidence.load({
    chat: request.source,
    signal: request.admission.signal,
  });
  for (const message of native.messages) {
    const source = getNativeMessageRevisionSource(message);
    if (!source || !matchesProviderMeta(source, expected)) continue;
    const lineNumber = positiveSafeInteger(source.lineNumber);
    if (lineNumber === null) break;
    return {
      lineNumber,
      retainedMessageCount: (nonNegativeSafeInteger(source.withinSourceOrdinal) ?? 0) + 1,
    };
  }
  throw missingNativePoint();
}

function matchesProviderMeta(
  source: NativeMessageSource,
  expected: JsonObject,
): boolean {
  let compared = false;
  for (const key of ['entryId', 'lineNumber', 'byteOffset', 'withinSourceOrdinal'] as const) {
    const value = expected[key];
    if (value === undefined) continue;
    compared = true;
    if (source[key] !== value) return false;
  }
  return compared;
}

async function resolveSourceReference(
  options: JsonlNativeForkingOptions,
  request: AgentNativeForkRequest,
) {
  const current = options.nativeSessions.decode(request.source.nativeSession);
  if (current.path) return request.source.nativeSession;
  return options.nativeEvidence.resolveNativeSession({
    chat: request.source,
    signal: request.admission.signal,
  });
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function missingNativePoint(): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    'The selected ledger row has no provider-native fork position',
    true,
    { nativeForkReason: 'not-settled' },
  );
}

function transcriptUnavailable(message: string): AgentIntegrationError {
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', message, false);
}

function sourceRevisionChanged(): AgentIntegrationError {
  return new AgentIntegrationError(
    'SOURCE_REVISION_CHANGED',
    'Source transcript changed while the fork was being created',
    true,
  );
}

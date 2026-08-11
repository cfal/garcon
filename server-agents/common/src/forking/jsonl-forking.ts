import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import { retargetNativeSeedReceiptIfPreserved } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevisions,
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  type AgentForkRequest,
  type AgentForkRequestV4,
  type AgentForkOutcome,
  type AgentForking,
  type AgentForkingV4,
  type AgentNativeForkRef,
  type AgentStartedSession,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import {
  forkJsonlTranscript,
  jsonlSourceLineCount,
  JsonlSourcePrefixChangedError,
  snapshotJsonlSource,
  type ForkJsonlRequest,
  type ForkTranscriptEntryContext,
} from './fork-jsonl.js';
import type { JournalBackedAgentTranscriptStream } from '../transcript-projection/journal-stream.js';

export interface JsonlForkingOptions {
  readonly supportsWhileRunning: boolean;
  readonly transcript: Pick<AgentTranscript, 'load' | 'resolveNativeSession'>;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly createRewriteEntry?: () => (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly forkWholeSession?: (request: AgentForkRequest) => Promise<AgentStartedSession | null>;
  readonly transformEntries?: ForkJsonlRequest['transformEntries'];
  readonly createTargetPath?: ForkJsonlRequest['createTargetPath'];
  // Whole-session forks without persisted output remain unmaterialized. This also tolerates
  // a missing source file; message-point forks always require materialized native history.
  readonly allowUnmaterializedWholeSession?: boolean;
  readonly semanticDigest?: (messages: readonly ChatMessage[]) => string;
}

export interface ProjectionJsonlForkingOptions
  extends Omit<JsonlForkingOptions, 'forkWholeSession'> {
  readonly ownerId: string;
  readonly projection: Pick<JournalBackedAgentTranscriptStream, 'resolveNativeForkPoint'>;
  readonly forkWholeSession?: (request: AgentForkRequestV4) => Promise<AgentStartedSession | null>;
}

export function createProjectionJsonlForking(
  options: ProjectionJsonlForkingOptions,
): AgentForkingV4 {
  return {
    supportsAtMessage: true,
    supportsWhileRunning: options.supportsWhileRunning,
    resolvePoint: (request) => options.projection.resolveNativeForkPoint({
      chat: request.source,
      point: request.point,
      signal: request.signal,
    }),
    async fork(request) {
      request.admission.signal.throwIfAborted();
      if (!request.point && options.forkWholeSession) {
        const result = await options.forkWholeSession(request);
        if (result) return { kind: 'materialized', session: result };
      }
      return forkProjectionJsonlAtPoint(options, request);
    },
    async discard(session, signal) {
      signal.throwIfAborted();
      const native = options.nativeSessions.decode(session.nativeSession);
      if (!native.path) return;
      await fs.rm(native.path, { force: true });
    },
  };
}

export function createJsonlForking(options: JsonlForkingOptions): AgentForking {
  return {
    supportsAtMessage: true,
    supportsWhileRunning: options.supportsWhileRunning,
    async fork(request) {
      request.admission.signal.throwIfAborted();
      if (!request.point && options.forkWholeSession) {
        const result = await options.forkWholeSession(request);
        if (result) return { kind: 'materialized', session: result };
      }
      return forkJsonlAtPoint(options, request);
    },
    async discard(session, signal) {
      signal.throwIfAborted();
      const native = options.nativeSessions.decode(session.nativeSession);
      if (!native.path) return;
      await fs.rm(native.path, { force: true });
    },
  };
}

async function forkJsonlAtPoint(
  options: JsonlForkingOptions,
  request: AgentForkRequest,
): Promise<AgentForkOutcome> {
  const resolvedReference = await resolveSourceReference(options, request);
  const sourceNative = options.nativeSessions.decode(resolvedReference);
  const sourceAgentSessionId = request.source.agentSessionId ?? sourceNative.agentSessionId;
  const sourcePath = sourceNative.path;
  if (!sourceAgentSessionId || !sourcePath) {
    if (
      !request.point
      && options.allowUnmaterializedWholeSession
      && !sourceAgentSessionId
    ) {
      return { kind: 'unmaterialized' };
    }
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Source native transcript is unavailable',
      false,
    );
  }

  let cutoffLine: number | null = null;
  let leadingLineCount = 0;
  let retainedMessageCounts: ReadonlyMap<number, number> | undefined;
  let expectedForkDigest: string | null = null;
  let nativeSequence = 0;
  if (
    request.point &&
    request.point.sourceRevision.carryOver !== request.source.carryOverRevision
  ) {
    throw sourceRevisionChanged();
  }
  const sourceSnapshot = request.point ? await snapshotJsonlSource(sourcePath) : undefined;
  if (request.point) {
    if (
      !Number.isSafeInteger(request.point.archivedMessageCount)
      || request.point.archivedMessageCount < 0
      || request.point.archivedMessageCount > request.point.messageSequence
    ) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Fork carry-over count is invalid',
        false,
      );
    }
    const native = await options.transcript.load({
      chat: request.source,
      signal: request.admission.signal,
    });
    nativeSequence = request.point.messageSequence - request.point.archivedMessageCount;
    if (nativeSequence > native.messages.length) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Fork message is outside the source transcript',
        false,
      );
    }
    if (
      computeAgentTranscriptRevisions(native.messages, nativeSequence).prefix !==
      request.point.sourceRevision.nativePrefix
    ) {
      throw sourceRevisionChanged();
    }
    const sourceLines = native.messages
      .map((message) => getNativeMessageRevisionSource(message)?.lineNumber)
      .filter((line): line is number => line !== undefined);
    leadingLineCount =
      sourceLines.length > 0
        ? Math.max(0, Math.min(...sourceLines) - (nativeSequence === 0 ? 0 : 1))
        : native.messages.length === 0
          ? jsonlSourceLineCount(sourceSnapshot!, sourcePath)
          : 0;
    const retainedMessages = native.messages.slice(0, nativeSequence);
    expectedForkDigest = forkTranscriptDigest(retainedMessages);
    const retainedCounts = new Map<number, number>();
    for (const message of retainedMessages) {
      const sourcePosition = getNativeMessageRevisionSource(message);
      if (!sourcePosition?.lineNumber) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The selected transcript prefix has no provider-native fork position',
          false,
        );
      }
      retainedCounts.set(
        sourcePosition.lineNumber,
        (retainedCounts.get(sourcePosition.lineNumber) ?? 0) + 1,
      );
    }
    retainedMessageCounts = retainedCounts;
    cutoffLine = nativeSequence === 0 ? 0 : Math.max(...retainedCounts.keys());
  }

  const result = await forkJsonlTranscript({
    sourcePath,
    sourceAgentSessionId,
    cutoffLine,
    allowUnmaterializedWholeSession:
      !request.point && options.allowUnmaterializedWholeSession === true,
    leadingLineCount,
    retainedMessageCounts,
    sourceSnapshot,
    rewriteEntry: options.createRewriteEntry?.() ?? options.rewriteEntry,
    transformEntries: options.transformEntries,
    createTargetPath: options.createTargetPath,
  }).catch((error) => {
    if (error instanceof JsonlSourcePrefixChangedError) throw sourceRevisionChanged();
    throw error;
  });
  if (result.kind === 'unmaterialized') {
    if (request.point) {
      throw new Error('A message-point fork cannot remain unmaterialized');
    }
    return result;
  }
  try {
    const nativeSession = options.nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? sourceNative.modelEndpointId,
    });
    const expectedDigest = result.expectedSemanticDigest ?? expectedForkDigest;
    let forkedMessages: readonly ChatMessage[] | null = null;
    if (expectedDigest !== null || request.source.nativeSeedReceipt) {
      const forked = await options.transcript.load({
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
      const actualDigest = expectedDigest === null
        ? null
        : options.semanticDigest
          ? options.semanticDigest(forked.messages)
          : forkTranscriptDigest(forked.messages);
      if (expectedDigest !== null && actualDigest !== expectedDigest) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The provider-native fork did not preserve the selected message prefix',
          false,
        );
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
    if (request.point || options.transformEntries) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function forkProjectionJsonlAtPoint(
  options: ProjectionJsonlForkingOptions,
  request: AgentForkRequestV4,
): Promise<AgentForkOutcome> {
  const resolvedReference = await resolveProjectionSourceReference(options, request);
  const sourceNative = options.nativeSessions.decode(resolvedReference);
  const sourceAgentSessionId = request.source.agentSessionId ?? sourceNative.agentSessionId;
  const sourcePath = sourceNative.path;
  if (!sourceAgentSessionId || !sourcePath) {
    if (!request.point && options.allowUnmaterializedWholeSession && !sourceAgentSessionId) {
      return { kind: 'unmaterialized' };
    }
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Source native transcript is unavailable',
      false,
    );
  }

  let cutoffLine: number | null = null;
  let leadingLineCount = 0;
  let retainedMessageCounts: ReadonlyMap<number, number> | undefined;
  let expectedForkDigest: string | null = null;
  const sourceSnapshot = request.point ? await snapshotJsonlSource(sourcePath) : undefined;
  if (request.point) {
    const nativePoint = parseProjectionNativePoint(request.point.native, options.ownerId);
    cutoffLine = nativePoint.lineNumber;
    leadingLineCount = nativePoint.firstLine === null
      ? 0
      : Math.max(0, nativePoint.firstLine - 1);
    retainedMessageCounts = nativePoint.lineCounts;
    expectedForkDigest = nativePoint.semanticDigest;
  }

  const result = await forkJsonlTranscript({
    sourcePath,
    sourceAgentSessionId,
    cutoffLine,
    allowUnmaterializedWholeSession:
      !request.point && options.allowUnmaterializedWholeSession === true,
    leadingLineCount,
    retainedMessageCounts,
    sourceSnapshot,
    rewriteEntry: options.createRewriteEntry?.() ?? options.rewriteEntry,
    transformEntries: options.transformEntries,
    createTargetPath: options.createTargetPath,
  }).catch((error) => {
    if (error instanceof JsonlSourcePrefixChangedError) throw sourceRevisionChanged();
    throw error;
  });
  if (result.kind === 'unmaterialized') {
    if (request.point) throw new Error('A message-point fork cannot remain unmaterialized');
    return result;
  }
  try {
    const nativeSession = options.nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? sourceNative.modelEndpointId,
    });
    const expectedDigest = result.expectedSemanticDigest ?? expectedForkDigest;
    let forkedMessages: readonly ChatMessage[] | null = null;
    if (expectedDigest !== null || request.source.nativeSeedReceipt) {
      const forked = await options.transcript.load({
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
      const actualDigest = expectedDigest === null
        ? null
        : options.semanticDigest
          ? options.semanticDigest(forked.messages)
          : forkTranscriptDigest(forked.messages);
      if (expectedDigest !== null && actualDigest !== expectedDigest) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The provider-native fork did not preserve the selected projection prefix',
          false,
        );
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
    if (request.point || options.transformEntries) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function parseProjectionNativePoint(
  reference: AgentNativeForkRef,
  ownerId: string,
): {
  readonly lineNumber: number;
  readonly firstLine: number | null;
  readonly lineCounts: ReadonlyMap<number, number>;
  readonly semanticDigest: string;
} {
  if (reference.ownerId !== ownerId || reference.schemaVersion !== 1) {
    throw sourceRevisionChanged();
  }
  const value = reference.value as Record<string, unknown>;
  const ordinal = positiveSafeInteger(value.ordinal);
  const alias = asRecord(value.alias);
  const prefix = asRecord(value.prefix);
  const lineNumber = positiveSafeInteger(alias?.lineNumber);
  const semanticDigest = typeof prefix?.semanticDigest === 'string'
    ? prefix.semanticDigest
    : null;
  const firstLineValue = prefix?.firstLine;
  const firstLine = firstLineValue === null ? null : positiveSafeInteger(firstLineValue);
  const rawCounts = asRecord(prefix?.lineCounts);
  if (ordinal === null || lineNumber === null || !semanticDigest || !rawCounts) {
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'The selected projection entry has no provider-native fork position',
      false,
    );
  }
  const lineCounts = new Map<number, number>();
  for (const [rawLine, rawCount] of Object.entries(rawCounts)) {
    const line = positiveSafeInteger(Number(rawLine));
    const count = positiveSafeInteger(rawCount);
    if (line === null || count === null) throw sourceRevisionChanged();
    lineCounts.set(line, count);
  }
  const representedEntries = [...lineCounts.values()].reduce((total, count) => total + count, 0);
  if (!lineCounts.has(lineNumber) || representedEntries !== ordinal) throw sourceRevisionChanged();
  return { lineNumber, firstLine, lineCounts, semanticDigest };
}

async function resolveProjectionSourceReference(
  options: ProjectionJsonlForkingOptions,
  request: AgentForkRequestV4,
) {
  const current = options.nativeSessions.decode(request.source.nativeSession);
  if (current.path) return request.source.nativeSession;
  return options.transcript.resolveNativeSession({
    chat: request.source,
    signal: request.admission.signal,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function forkTranscriptDigest(messages: readonly ChatMessage[]): string {
  return orderedTranscriptDigest(
    messages.map((message, index) => ({
      seq: index + 1,
      message,
    })),
  );
}

async function resolveSourceReference(options: JsonlForkingOptions, request: AgentForkRequest) {
  const current = options.nativeSessions.decode(request.source.nativeSession);
  if (current.path) return request.source.nativeSession;
  return options.transcript.resolveNativeSession({
    chat: request.source,
    signal: request.admission.signal,
  });
}

function sourceRevisionChanged(): AgentIntegrationError {
  return new AgentIntegrationError(
    'SOURCE_REVISION_CHANGED',
    'Source transcript changed while the fork was being created',
    true,
  );
}

import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import { retargetNativeSeedReceiptIfPreserved } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  type AgentForkRequestV4,
  type AgentForkOutcome,
  type AgentForkingV4,
  type AgentNativeForkRef,
  type AgentStartedSession,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../transcript-projection/evidence-source.js';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import {
  forkJsonlTranscript,
  JsonlSourcePrefixChangedError,
  snapshotJsonlSource,
  type ForkJsonlRequest,
  type ForkTranscriptEntryContext,
} from './fork-jsonl.js';
import type { JournalBackedAgentTranscriptStream } from '../transcript-projection/journal-stream.js';

export interface ProjectionJsonlForkingOptions {
  readonly ownerId: string;
  // Gates both whole-session and at-message forks: a running provider session must tolerate
  // having its transcript read and copied while it is still appending to it.
  readonly supportsWhileRunning: boolean;
  readonly projection: Pick<JournalBackedAgentTranscriptStream, 'resolveNativeForkPoint'>;
  readonly nativeEvidence: Pick<AgentNativeEvidenceSource, 'load' | 'resolveNativeSession'>;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly createRewriteEntry?: () => (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly forkWholeSession?: (request: AgentForkRequestV4) => Promise<AgentStartedSession | null>;
  readonly transformEntries?: ForkJsonlRequest['transformEntries'];
  readonly createTargetPath?: ForkJsonlRequest['createTargetPath'];
  // Whole-session forks without persisted output remain unmaterialized. This also tolerates
  // a missing source file; message-point forks always require materialized native history.
  readonly allowUnmaterializedWholeSession?: boolean;
  readonly semanticDigest?: (messages: readonly ChatMessage[]) => string;
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
  let prefixRendering: 'native' | 'mixed' = 'native';
  const sourceSnapshot = request.point ? await snapshotJsonlSource(sourcePath) : undefined;
  if (request.point) {
    const nativePoint = parseProjectionNativePoint(request.point.native, options.ownerId);
    cutoffLine = nativePoint.lineNumber;
    leadingLineCount = nativePoint.firstLine === null
      ? 0
      : Math.max(0, nativePoint.firstLine - 1);
    retainedMessageCounts = nativePoint.lineCounts;
    expectedForkDigest = nativePoint.semanticDigest;
    prefixRendering = nativePoint.rendering;
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
    const expectedDigest = result.expectedSemanticDigest
      ?? (prefixRendering === 'native' ? expectedForkDigest : null);
    // Structural transforms reorder or rewrite lines, so only an untransformed
    // line cut can be proven against the source's own native window.
    const verifyAgainstSourceWindow = expectedDigest === null
      && expectedForkDigest !== null
      && prefixRendering === 'mixed'
      && options.transformEntries === undefined;
    let forkedMessages: readonly ChatMessage[] | null = null;
    if (expectedDigest !== null || verifyAgainstSourceWindow || request.source.nativeSeedReceipt) {
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
      const digestOf = options.semanticDigest ?? forkTranscriptDigest;
      let mismatch = false;
      if (expectedDigest !== null) {
        mismatch = digestOf(forked.messages) !== expectedDigest;
      } else if (verifyAgainstSourceWindow && cutoffLine !== null) {
        // The projection prefix renders admission rows differently from the
        // provider file, so line-cut exactness is proven against the source's
        // own native rendering of the retained line window.
        const source = await options.nativeEvidence.load({
          chat: request.source,
          signal: request.admission.signal,
        });
        mismatch = digestOf(nativeWindow(forked.messages, cutoffLine))
          !== digestOf(nativeWindow(source.messages, cutoffLine));
      }
      if (mismatch) {
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
  readonly rendering: 'native' | 'mixed';
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
  return {
    lineNumber,
    firstLine,
    lineCounts,
    semanticDigest,
    rendering: prefix?.rendering === 'mixed' ? 'mixed' : 'native',
  };
}

async function resolveProjectionSourceReference(
  options: ProjectionJsonlForkingOptions,
  request: AgentForkRequestV4,
) {
  const current = options.nativeSessions.decode(request.source.nativeSession);
  if (current.path) return request.source.nativeSession;
  return options.nativeEvidence.resolveNativeSession({
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

function nativeWindow(
  messages: readonly ChatMessage[],
  cutoffLine: number,
): ChatMessage[] {
  return messages.filter((message) => {
    const line = getNativeMessageRevisionSource(message)?.lineNumber;
    return typeof line === 'number' && line <= cutoffLine;
  });
}

function forkTranscriptDigest(messages: readonly ChatMessage[]): string {
  return orderedTranscriptDigest(
    messages.map((message, index) => ({
      seq: index + 1,
      message,
    })),
  );
}

function sourceRevisionChanged(): AgentIntegrationError {
  return new AgentIntegrationError(
    'SOURCE_REVISION_CHANGED',
    'Source transcript changed while the fork was being created',
    true,
  );
}

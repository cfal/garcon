import { promises as fs } from 'node:fs';
import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  computeAgentTranscriptRevisions,
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  type AgentForkRequest,
  type AgentForking,
  type AgentHost,
  type AgentStartedSession,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '../native-session/path-native-session.js';
import {
  forkJsonlTranscript,
  jsonlSourceLineCount,
  JsonlSourcePrefixChangedError,
  snapshotJsonlSource,
  type ForkTranscriptEntryContext,
} from './fork-jsonl.js';

export interface JsonlForkingOptions {
  readonly host: Pick<AgentHost, 'carryOver'>;
  readonly supportsWhileRunning: boolean;
  readonly transcript: Pick<AgentTranscript, 'load' | 'resolveNativeSession'>;
  readonly nativeSessions: PathNativeSessionCodec;
  readonly rewriteEntry?: (entry: unknown, context: ForkTranscriptEntryContext) => unknown;
  readonly createRewriteEntry?: () => (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
  readonly forkWholeSession?: (request: AgentForkRequest) => Promise<AgentStartedSession | null>;
}

export function createJsonlForking(options: JsonlForkingOptions): AgentForking {
  return {
    supportsAtMessage: true,
    supportsWhileRunning: options.supportsWhileRunning,
    async fork(request) {
      request.admission.signal.throwIfAborted();
      if (!request.point && options.forkWholeSession) {
        const result = await options.forkWholeSession(request);
        if (result) return result;
      }
      return forkJsonlAtPoint(options, request);
    },
  };
}

async function forkJsonlAtPoint(
  options: JsonlForkingOptions,
  request: AgentForkRequest,
): Promise<AgentStartedSession> {
  const resolvedReference = await resolveSourceReference(options, request);
  const sourceNative = options.nativeSessions.decode(resolvedReference);
  const sourceAgentSessionId = request.source.agentSessionId ?? sourceNative.agentSessionId;
  const sourcePath = sourceNative.path;
  if (!sourceAgentSessionId || !sourcePath) {
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
    const carryOver = await options.host.carryOver.load({
      chatId: request.source.chatId,
      expectedRevision: request.point.sourceRevision.carryOver,
      currentAgentId: request.source.agentId,
      currentModel: request.source.model,
      signal: request.admission.signal,
    });
    const native = await options.transcript.load({
      chat: request.source,
      signal: request.admission.signal,
    });
    nativeSequence = Math.max(0, request.point.messageSequence - carryOver.messages.length);
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
    leadingLineCount,
    retainedMessageCounts,
    sourceSnapshot,
    rewriteEntry: options.createRewriteEntry?.() ?? options.rewriteEntry,
  }).catch((error) => {
    if (error instanceof JsonlSourcePrefixChangedError) throw sourceRevisionChanged();
    throw error;
  });
  try {
    const nativeSession = options.nativeSessions.encode({
      path: result.nativePath,
      agentSessionId: result.agentSessionId,
      modelEndpointId: request.endpoint?.endpointId ?? sourceNative.modelEndpointId,
    });
    if (request.point) {
      const forked = await options.transcript.load({
        chat: {
          chatId: request.chatId,
          agentId: request.source.agentId,
          agentSessionId: result.agentSessionId,
          projectPath: request.projectPath,
          model: request.model,
          nativeSession,
          carryOverRevision: '',
          settings: request.settings,
        },
        signal: request.admission.signal,
      });
      if (forkTranscriptDigest(forked.messages) !== expectedForkDigest) {
        throw new AgentIntegrationError(
          'TRANSCRIPT_UNAVAILABLE',
          'The provider-native fork did not preserve the selected message prefix',
          false,
        );
      }
    }
    return { agentSessionId: result.agentSessionId, nativeSession };
  } catch (error) {
    if (request.point) {
      await fs.rm(result.nativePath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
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
